import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import { db } from '../db';
import { logger } from '../lib/logger';
import { tryRenderCoverPng } from './cover-renderer';

const CHUNK_TOKENS  = 600;
const CHUNK_OVERLAP = 100;

// ── Language detection ────────────────────────────────────────────────────────

export function detectLanguage(text: string): 'ru' | 'en' | 'mixed' {
  const sample = text.slice(0, 2000);
  const cyrillic = (sample.match(/[Ѐ-ӿ]/g) ?? []).length;
  const latin    = (sample.match(/[a-zA-Z]/g) ?? []).length;
  const total    = cyrillic + latin;
  if (total === 0) return 'ru';
  const cyrRatio = cyrillic / total;
  if (cyrRatio > 0.75) return 'ru';
  if (cyrRatio < 0.25) return 'en';
  return 'mixed';
}

// ── PDF text cleaning ─────────────────────────────────────────────────────────
// Учебники часто имеют типографские артефакты после pdf-parse:
//   1. Буквенный пробел: "О б р а з е ц" → "Образец"
//   2. Ударения как символы: "Отдыха ́ ет" → "Отдыхает"
//   3. Типографские переносы: "вре-\nмени" → "времени"
//   4. Лишние табы/пробелы

export function cleanPdfText(text: string): string {
  let s = text;

  // 1. Склеить переносы: "вре-\nмени" → "времени"
  s = s.replace(/([а-яёА-ЯЁa-zA-Z])-\n([а-яёА-ЯЁa-zA-Z])/g, '$1$2');

  // 2. Убрать ударения: "а ́" или U+0301 (combining acute) рядом с буквой
  s = s.replace(/́/g, '');          // combining acute accent
  s = s.replace(/ ́/g, '');         // space + combining acute
  s = s.replace(/([а-яёА-ЯЁ]) ́/g, '$1'); // буква + пробел + acute-подобный

  // 3. Склеить буквенный пробел (3+ одиночных буквы через таб/пробел)
  //    "О	б	р	а	з	е	ц" → "Образец"
  //    Паттерн: одна буква, потом (\t или ' ') + одна буква, 2+ раза
  s = s.replace(/([А-ЯЁа-яёA-Za-z])([\t ])(?=[А-ЯЁа-яёA-Za-z][\t ][А-ЯЁа-яёA-Za-z])/g,
    (_m, letter) => letter); // убрать разделитель после буквы
  // Повторить для оставшихся пар (двойной проход)
  s = s.replace(/([А-ЯЁа-яёA-Za-z])([\t ])(?=[А-ЯЁа-яёA-Za-z][\t ][А-ЯЁа-яёA-Za-z])/g,
    (_m, letter) => letter);

  // 4. Табы → пробел
  s = s.replace(/\t+/g, ' ');

  // 5. Множественные пробелы → один
  s = s.replace(/ {2,}/g, ' ');

  // 6. Больше двух переводов строки → два
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

// ── Chunking ──────────────────────────────────────────────────────────────────
// 1 токен ≈ 4 символа — рабочая аппроксимация для ru/en

function chunkText(text: string): string[] {
  const charLimit    = CHUNK_TOKENS   * 4;
  const overlapChars = CHUNK_OVERLAP  * 4;
  const chunks: string[] = [];

  const paragraphs = text.split(/\n{2,}/);
  let current = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if ((current + '\n\n' + trimmed).length > charLimit) {
      if (current) {
        chunks.push(current.trim());
        current = current.slice(-overlapChars) + '\n\n' + trimmed;
      } else {
        // Абзац длиннее лимита — жёсткое разбиение
        let remaining = trimmed;
        while (remaining.length > charLimit) {
          chunks.push(remaining.slice(0, charLimit));
          remaining = remaining.slice(charLimit - overlapChars);
        }
        current = remaining;
      }
    } else {
      current = current ? current + '\n\n' + trimmed : trimmed;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 50);
}

// ── Progress helper ───────────────────────────────────────────────────────────

async function setProgress(documentId: string, step: string, pct: number) {
  await db.query(
    `UPDATE rag_documents
     SET status = 'processing', progress_step = $1, progress_pct = $2, updated_at = NOW()
     WHERE id = $3`,
    [step, pct, documentId],
  );
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

export async function runIndexPipeline(documentId: string, filePath: string): Promise<void> {
  try {
    // Шаг 1: парсинг PDF
    await setProgress(documentId, 'parsing', 5);
    logger.info({ documentId }, '[rag-indexer] parsing PDF');

    const fileBuffer = fs.readFileSync(filePath);

    // Рендерим обложку (первая страница PDF как PNG) до парсинга текста
    await tryRenderCoverPng(fileBuffer, documentId);

    const parsed = await pdfParse(fileBuffer);
    const rawText = parsed.text;

    if (!rawText || rawText.trim().length < 100) {
      throw new Error('PDF не содержит извлекаемого текста. Возможно, это скан — загрузите текстовый PDF.');
    }

    // Очищаем типографские артефакты ДО определения языка и нарезки
    const cleanText = cleanPdfText(rawText);
    logger.info({ documentId, rawLen: rawText.length, cleanLen: cleanText.length }, '[rag-indexer] text cleaned');

    const lang = detectLanguage(cleanText);
    await db.query(`UPDATE rag_documents SET lang = $1 WHERE id = $2`, [lang, documentId]);

    // Шаг 2: нарезка
    await setProgress(documentId, 'chunking', 25);
    logger.info({ documentId }, '[rag-indexer] chunking');

    const chunks = chunkText(cleanText);
    if (chunks.length === 0) throw new Error('Не удалось разбить текст на фрагменты');

    // Шаг 3: сохранение с tsvector (PostgreSQL считает сам при INSERT)
    await setProgress(documentId, 'saving', 50);
    logger.info({ documentId, chunks: chunks.length }, '[rag-indexer] saving chunks');

    await db.query('BEGIN');
    try {
      await db.query('DELETE FROM rag_chunks WHERE document_id = $1', [documentId]);

      // Batch INSERT по 200 чанков за раз чтобы не перегружать парсер запроса
      const BATCH = 200;
      for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = chunks.slice(i, i + BATCH);
        const values: any[] = [];
        const placeholders = batch.map((chunk, j) => {
          const base = j * 3;
          values.push(documentId, i + j, chunk);
          // to_tsvector для обоих языков сразу — ищем и по-русски, и по-английски
          return `($${base + 1}, $${base + 2}, $${base + 3},
            to_tsvector('russian', $${base + 3}) || to_tsvector('english', $${base + 3}))`;
        });

        await db.query(
          `INSERT INTO rag_chunks (document_id, chunk_index, content, search_vector)
           VALUES ${placeholders.join(', ')}`,
          values,
        );

        // Обновляем прогресс во время записи
        const pct = 50 + Math.round(((i + batch.length) / chunks.length) * 45);
        await db.query(
          `UPDATE rag_documents SET progress_pct = $1, updated_at = NOW() WHERE id = $2`,
          [pct, documentId],
        );
      }

      await db.query(
        `UPDATE rag_documents
         SET status = 'ready', progress_step = 'done', progress_pct = 100,
             chunk_count = $1, updated_at = NOW()
         WHERE id = $2`,
        [chunks.length, documentId],
      );

      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }

    logger.info({ documentId, chunks: chunks.length }, '[rag-indexer] done');
  } catch (err: any) {
    logger.error({ documentId, err: err.message }, '[rag-indexer] failed');
    await db.query(
      `UPDATE rag_documents
       SET status = 'error', error_msg = $1, updated_at = NOW()
       WHERE id = $2`,
      [err.message?.slice(0, 500) || 'Неизвестная ошибка', documentId],
    ).catch(() => {});
    throw err;
  } finally {
    try { fs.unlinkSync(filePath); } catch { /* уже удалён */ }
  }
}
