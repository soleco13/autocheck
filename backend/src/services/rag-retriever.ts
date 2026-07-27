import { db } from '../db';
import { logger } from '../lib/logger';

export interface RetrievedChunk {
  chunkId:    string;
  documentId: string;
  content:    string;
  score:      number;
}

export interface RetrieverOptions {
  query:        string;
  teacherId:    string;
  subjectCode?: string | null;
  grade?:       string | null;
  topK?:        number;
}

export async function retrieveChunks(opts: RetrieverOptions): Promise<RetrievedChunk[]> {
  const { query, teacherId, subjectCode, grade, topK = 5 } = opts;

  if (!query.trim()) return [];

  // Обрезаем запрос — защита от гигантских промптов
  const safeQuery = query.slice(0, 500);

  // ── Уровень 1: фильтр по subject_code + grade ─────────────────────────────
  // Полностью параметризованный запрос — $1 = query текст, никакой интерполяции
  if (subjectCode && grade) {
    try {
      const rows = await db.query<any>(
        `SELECT
           tc.id          AS chunk_id,
           tc.document_id,
           tc.content,
           ts_rank_cd(tc.search_vector,
             websearch_to_tsquery('russian', $1) || websearch_to_tsquery('english', $1)
           ) AS score
         FROM rag_chunks tc
         JOIN rag_documents td ON td.id = tc.document_id
         WHERE td.teacher_id   = $2
           AND td.subject_code = $3
           AND td.grade        = $4
           AND td.status       = 'ready'
           AND tc.search_vector @@ (
             websearch_to_tsquery('russian', $1) || websearch_to_tsquery('english', $1)
           )
         ORDER BY score DESC
         LIMIT $5`,
        [safeQuery, teacherId, subjectCode, grade, topK],
      );

      if (rows.rows.length > 0) return mapRows(rows.rows);
    } catch (err: any) {
      logger.warn({ err: err.message }, '[rag-retriever] level-1 query failed, trying fallback');
    }
  }

  // ── Уровень 2: тот же предмет, любой класс ───────────────────────────────
  // Не используем "все учебники учителя" — учебник по математике не должен
  // применяться при проверке русского языка и наоборот.
  if (subjectCode) {
    try {
      const rows = await db.query<any>(
        `SELECT
           tc.id          AS chunk_id,
           tc.document_id,
           tc.content,
           ts_rank_cd(tc.search_vector,
             websearch_to_tsquery('russian', $1) || websearch_to_tsquery('english', $1)
           ) AS score
         FROM rag_chunks tc
         JOIN rag_documents td ON td.id = tc.document_id
         WHERE td.teacher_id   = $2
           AND td.subject_code = $3
           AND td.status       = 'ready'
           AND tc.search_vector @@ (
             websearch_to_tsquery('russian', $1) || websearch_to_tsquery('english', $1)
           )
         ORDER BY score DESC
         LIMIT $4`,
        [safeQuery, teacherId, subjectCode, topK],
      );

      return mapRows(rows.rows);
    } catch (err: any) {
      logger.warn({ err: err.message }, '[rag-retriever] level-2 query failed');
      return [];
    }
  }

  return [];
}

// Тип ответа: готов, ещё обрабатывается, или отсутствует совсем
export type RagAvailability = 'ready' | 'processing' | 'none';

// Возвращает статус учебника по предмету:
// 'ready'      — учебник готов к использованию
// 'processing' — учебник загружен, но ещё индексируется
// 'none'       — учебника нет вообще
export async function checkRagStatus(
  teacherId: string,
  subjectCode: string | null,
  grade: string | null,
): Promise<RagAvailability> {
  if (!subjectCode) return 'none';
  try {
    // Проверяем все статусы для этого предмета
    const params: any[] = [teacherId, subjectCode];
    const gradeClause = grade ? `AND grade = $${params.push(grade)}` : '';
    const r = await db.query(
      `SELECT status FROM rag_documents
       WHERE teacher_id = $1 AND subject_code = $2 ${gradeClause}
       ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'processing' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END
       LIMIT 1`,
      params,
    );
    if (!r.rows[0]) {
      // Точного совпадения нет — пробуем без класса
      if (grade) return checkRagStatus(teacherId, subjectCode, null);
      return 'none';
    }
    const st = r.rows[0].status;
    if (st === 'ready') return 'ready';
    if (st === 'pending' || st === 'processing') return 'processing';
    return 'none';
  } catch (err: any) {
    logger.error({ err: err?.message, teacherId, subjectCode, grade }, '[rag-retriever] checkRagStatus DB error — treating as none');
    return 'none';
  }
}

// Быстрая проверка: есть ли у учителя учебник по данному ПРЕДМЕТУ.
// Класс — вторичный критерий (не блокирует, если предмет совпадает).
// Учебники по другим предметам НЕ считаются совпадением — это и была причина
// того, что математика проходила проверку при наличии только русского учебника.
export async function checkRagAvailability(
  teacherId: string,
  subjectCode: string | null,
  grade: string | null,
): Promise<boolean> {
  try {
    if (!subjectCode) {
      // Предмет неизвестен — считаем недоступным, чтобы не смешивать учебники
      return false;
    }

    // Уровень 1: точное совпадение предмет + класс
    if (grade) {
      const r = await db.query(
        `SELECT 1 FROM rag_documents
         WHERE teacher_id = $1 AND subject_code = $2 AND grade = $3 AND status = 'ready'
         LIMIT 1`,
        [teacherId, subjectCode, grade],
      );
      if (r.rows.length > 0) return true;
    }

    // Уровень 2: тот же предмет, любой класс (учитель мог загрузить без указания класса)
    const r2 = await db.query(
      `SELECT 1 FROM rag_documents
       WHERE teacher_id = $1 AND subject_code = $2 AND status = 'ready'
       LIMIT 1`,
      [teacherId, subjectCode],
    );
    return r2.rows.length > 0;
  } catch (err: any) {
    logger.error({ err: err?.message, teacherId, subjectCode, grade }, '[rag-retriever] checkRagAvailability DB error — treating as unavailable');
    return false;
  }
}

function mapRows(rows: any[]): RetrievedChunk[] {
  return rows.map(r => ({
    chunkId:    r.chunk_id,
    documentId: r.document_id,
    content:    r.content,
    score:      parseFloat(r.score) || 0,
  }));
}
