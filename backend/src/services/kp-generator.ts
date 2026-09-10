import fs from 'fs';
import path from 'path';
import PizZip from 'pizzip';
import { db } from '../db';
import { aiThrottle } from '../lib/ai-throttle';
import { getOpenRouterClient } from '../lib/openrouter-client';
import { getTeacherPrompt, callGPTFallback, isCircuitOpen } from './ai-checker';
import { DEFAULT_PROMPTS } from '../api/settings';
import { logger } from '../lib/logger';

const MODEL = process.env.AI_REPORT_MODEL || process.env.AI_CHECKER_MODEL || 'anthropic/claude-sonnet-5';

/**
 * Генерация «Коррекционной программы» (КП) в формате .docx по итогам
 * проверочного тестирования ученика.
 *
 * Приватность: в ИИ уходит ТОЛЬКО список заданий, с которыми ученик не
 * справился (текст задания + эталон), предмет и класс проверочной работы.
 * Имя ученика, его ответы и любые персональные данные модели не передаются —
 * ИИ лишь называет учебные темы для повторения и число занятий. Всё остальное
 * (шапка, ФИО, оформление) подставляется из шаблона локально.
 */

// ── Ошибки с кодами для аккуратных HTTP-ответов ──────────────────────────────
export class KpError extends Error {
  constructor(message: string, public code: 'NOT_A_TEST' | 'NO_FAILED_TASKS' | 'NOT_FOUND') {
    super(message);
  }
}

// ── Определение «проверочного» материала по названию ─────────────────────────
export function isTestMaterial(title: string | null | undefined): boolean {
  return /тестировани/i.test(title || '');
}

// ── Предмет и «класс проверочной работы» из названия материала ───────────────
export const SUBJECT_BY_CODE: Record<string, string> = {
  РЯ: 'Русский язык', Р: 'Русский язык',
  МА: 'Математика', М: 'Математика',
  А: 'Алгебра', Г: 'Геометрия',
  АЯ: 'Английский язык', АНГ: 'Английский язык',
  Л: 'Литература', ЛЧ: 'Литературное чтение',
  Ф: 'Физика', Х: 'Химия', Б: 'Биология',
  И: 'История', ИС: 'История', ИСТ: 'История',
  О: 'Обществознание', ОБЩ: 'Обществознание',
  ГЕО: 'География', ГЕОГ: 'География',
  ИНФ: 'Информатика', ВиС: 'Информатика',
  ОКР: 'Окружающий мир', ОДНКР: 'ОДНКНР',
  ИЗО: 'Изобразительное искусство', МУЗ: 'Музыка',
  ФК: 'Физическая культура', ФКР: 'Физическая культура',
};

export function parseTestTitle(title: string | null | undefined): {
  subjectName: string | null;
  testedGrade: number | null;
} {
  const t = (title || '').trim();
  let subjectName: string | null = null;
  const codeMatch = t.match(/^\d*\s*([А-ЯЁA-Z]+)\d*\s*[_ ]/);
  if (codeMatch) subjectName = SUBJECT_BY_CODE[codeMatch[1].toUpperCase()] ?? null;

  let testedGrade: number | null = null;
  const gradeMatch = t.match(/за\s+(?:курс\s+)?(\d{1,2})\s*класс/i);
  if (gradeMatch) testedGrade = parseInt(gradeMatch[1], 10);

  return { subjectName, testedGrade };
}

// ── Вспомогательное ─────────────────────────────────────────────────────────
const xmlEsc = (s: string): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const clean = (s: any, n: number): string =>
  String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Статус ответа с учётом ручной правки балла учителем. */
function effectiveStatus(row: any): string {
  const ov = row.teacher_override_score;
  const max = row.task_max_score || row.max_score || 1;
  if (ov != null) {
    if (ov >= max) return 'correct';
    if (ov > 0) return 'partial';
    return 'incorrect';
  }
  return row.status;
}

const FAILED_STATUSES = new Set(['incorrect', 'not_answered', 'partial', 'skipped']);

function templatePath(): string {
  const candidates = [
    path.join(process.cwd(), 'templates', 'kp-template.docx'),
    path.join(__dirname, '..', '..', 'templates', 'kp-template.docx'),
    path.join(__dirname, '..', '..', '..', 'templates', 'kp-template.docx'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`kp-template.docx not found (tried: ${candidates.join(', ')})`);
}

// ── ИИ: список тем и число занятий по каждому проваленному заданию ───────────
interface KpRowPlan {
  task: number;
  topics: string[];
  lessons: number;
}

async function callKpAI(systemPrompt: string, userPrompt: string): Promise<string> {
  if (!isCircuitOpen()) {
    try {
      const client = getOpenRouterClient();
      const response = await client.chat.completions.create({
        model: MODEL,
        max_tokens: 4000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      return response.choices[0]?.message?.content ?? '';
    } catch (err: any) {
      const status: number = err?.status ?? 0;
      const body = String(err?.message ?? '').toLowerCase();
      const isTransient = status >= 500 || status === 429 ||
        (status === 400 && (body.includes('model not found') || body.includes('model_not_found'))) ||
        body.includes('overload') || body.includes('timeout');
      if (!isTransient) throw err;
      logger.warn(`[kp-generator] ${MODEL} unavailable, using fallback`);
    }
  }
  return callGPTFallback(userPrompt, systemPrompt, 4000);
}

function parseKpPlan(raw: string): KpRowPlan[] {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('[');
  if (start === -1) throw new Error('AI не вернул JSON-массив');
  const end = cleaned.lastIndexOf(']');

  let arr: any;
  if (end > start) {
    try {
      arr = JSON.parse(cleaned.slice(start, end + 1));
    } catch { /* fall through to salvage */ }
  }
  if (!Array.isArray(arr)) {
    // Спасение усечённого ответа: берём все полные объекты до последнего «}»
    const body = cleaned.slice(start + 1);
    const lastObj = body.lastIndexOf('}');
    if (lastObj === -1) throw new Error('AI вернул некорректный JSON');
    arr = JSON.parse('[' + body.slice(0, lastObj + 1) + ']');
  }
  if (!Array.isArray(arr)) throw new Error('AI вернул не массив');
  return arr
    .map((e: any): KpRowPlan | null => {
      const task = Number(e?.task);
      const topics = Array.isArray(e?.topics)
        ? e.topics.map((x: any) => clean(x, 300)).filter(Boolean)
        : [];
      let lessons = Math.round(Number(e?.lessons));
      if (!Number.isFinite(task) || topics.length === 0) return null;
      if (!Number.isFinite(lessons) || lessons < 1) lessons = 1;
      if (lessons > 3) lessons = 3;
      return { task, topics, lessons };
    })
    .filter((x): x is KpRowPlan => x !== null);
}

// ── Сборка строк таблицы ────────────────────────────────────────────────────
const RPR =
  '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman" /><w:bCs/><w:sz w:val="24" /><w:szCs w:val="24" />';

const borders = (color: string): string =>
  `<w:tcBorders>` +
  `<w:top w:val="single" w:color="${color}" w:sz="4" w:space="0"/>` +
  `<w:left w:val="single" w:color="${color}" w:sz="4" w:space="0"/>` +
  `<w:bottom w:val="single" w:color="${color}" w:sz="4" w:space="0"/>` +
  `<w:right w:val="single" w:color="${color}" w:sz="4" w:space="0"/>` +
  `</w:tcBorders>`;

const para = (text: string, jc: string): string =>
  `<w:p><w:pPr><w:jc w:val="${jc}" /><w:spacing w:before="240"/><w:rPr>${RPR}</w:rPr></w:pPr>` +
  (text
    ? `<w:r><w:rPr>${RPR}</w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`
    : `<w:r><w:rPr>${RPR}</w:rPr></w:r>`) +
  `</w:p>`;

function buildRow(num: number, topics: string[], lessons: number): string {
  const c1 =
    `<w:tc><w:tcPr>${borders('000000')}<w:tcW w:w="1225" w:type="dxa"/>` +
    `<w:textDirection w:val="lrTb" /><w:noWrap w:val="false"/></w:tcPr>` +
    para(String(num), 'center') +
    `</w:tc>`;
  const c2 =
    `<w:tc><w:tcPr>${borders('auto')}<w:tcW w:w="4814" w:type="dxa"/>` +
    `<w:textDirection w:val="lrTb" /><w:noWrap w:val="false"/></w:tcPr>` +
    topics.map((t) => para(t, 'both')).join('') +
    `</w:tc>`;
  const c3 =
    `<w:tc><w:tcPr>${borders('000000')}<w:tcW w:w="1646" w:type="dxa"/>` +
    `<w:vAlign w:val="center" /><w:textDirection w:val="lrTb" /><w:noWrap w:val="false"/></w:tcPr>` +
    para(String(lessons), 'both') +
    `</w:tc>`;
  const c4 =
    `<w:tc><w:tcPr>${borders('000000')}<w:tcW w:w="1660" w:type="dxa"/>` +
    `<w:textDirection w:val="lrTb" /><w:noWrap w:val="false"/></w:tcPr>` +
    para('', 'both') +
    `</w:tc>`;
  return `<w:tr><w:tblPrEx></w:tblPrEx><w:trPr></w:trPr>${c1}${c2}${c3}${c4}</w:tr>`;
}

// ── Подстановки в document.xml ──────────────────────────────────────────────
/**
 * Заменяет текст run(ов), идущих сразу за меткой, на одно новое значение.
 * `runs` — сколько последовательных run поглотить (у «ФИО ученика:» значение
 * разбито на два run: имя и фамилия).
 */
function replaceValueRun(xml: string, labelWithTags: string, value: string, runs = 1): string {
  const oneRun = `<w:r>(?:(?!</w:r>)[\\s\\S])*?</w:r>`;
  const re = new RegExp(
    `(${labelWithTags.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</w:t></w:r>)` +
      oneRun.repeat(runs),
  );
  const run =
    `<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman" />` +
    `<w:b/><w:sz w:val="28" /><w:szCs w:val="28" /><w:lang w:eastAsia="zh-CN" /></w:rPr>` +
    (value ? `<w:t xml:space="preserve">${xmlEsc(value)}</w:t>` : '') +
    `</w:r>`;
  return xml.replace(re, `$1${run}`);
}

function removeNarrativeParagraph(xml: string): string {
  const marker = 'В начале тестиров';
  const at = xml.indexOf(marker);
  if (at === -1) return xml;
  const start = xml.lastIndexOf('<w:p>', at);
  const end = xml.indexOf('</w:p>', at);
  if (start === -1 || end === -1) return xml;
  return xml.slice(0, start) + xml.slice(end + '</w:p>'.length);
}

function fillTable(xml: string, rowsXml: string): string {
  const gi = xml.indexOf('<w:gridCol w:w="1225"/>');
  if (gi === -1) throw new Error('template: таблица тем не найдена');
  const hdrClose = xml.indexOf('</w:tr>', gi) + '</w:tr>'.length;
  const tblClose = xml.indexOf('</w:tbl>', hdrClose);
  if (tblClose === -1) throw new Error('template: конец таблицы не найден');
  return xml.slice(0, hdrClose) + rowsXml + xml.slice(tblClose);
}

// ── Основная функция ───────────────────────────────────────────────────────
export interface KpResult {
  filename: string;
  buffer: Buffer;
}

/**
 * `sessionOrReportId` — id, приходящий из URL отчёта: это может быть как
 * student_session.id, так и report.id (маршрут /reports/:id принимает оба).
 */
export async function generateKpDocx(sessionOrReportId: string, teacherId: string): Promise<KpResult> {
  const sessRes = await db.query(
    `SELECT ss.id, ss.teacher_id, cs.title, cs.grade, cs.subject_code,
            s.full_name AS student_name,
            tch.full_name AS teacher_name
     FROM student_sessions ss
     JOIN control_sheets cs ON cs.id = ss.control_sheet_id
     JOIN students s ON s.id = ss.student_id
     LEFT JOIN teachers tch ON tch.id = ss.teacher_id
     LEFT JOIN reports r ON r.session_id = ss.id
     WHERE (ss.id = $1 OR r.id = $1) AND ss.teacher_id = $2
     LIMIT 1`,
    [sessionOrReportId, teacherId],
  );
  if (!sessRes.rows[0]) throw new KpError('Сессия не найдена', 'NOT_FOUND');
  const sess = sessRes.rows[0];
  const sessionId: string = sess.id;

  if (!isTestMaterial(sess.title)) {
    throw new KpError('Материал не является проверочным тестированием', 'NOT_A_TEST');
  }

  const ansRes = await db.query(
    `SELECT t.task_index, t.slide_num, t.question_text, t.reference_answer, t.max_score AS task_max_score,
            a.status, a.teacher_override_score
     FROM answers a
     JOIN tasks t ON t.id = a.task_id
     WHERE a.session_id = $1
     ORDER BY t.task_index ASC NULLS LAST, a.created_at ASC`,
    [sessionId],
  );

  const failed = ansRes.rows
    .map((r: any, i: number) => ({ ...r, num: r.task_index != null ? r.task_index + 1 : i + 1 }))
    .filter((r: any) => FAILED_STATUSES.has(effectiveStatus(r)));

  if (failed.length === 0) {
    throw new KpError('В работе нет заданий с ошибками — коррекционная программа не требуется', 'NO_FAILED_TASKS');
  }

  const { subjectName: parsedSubject, testedGrade } = parseTestTitle(sess.title);
  const subjectName = parsedSubject || SUBJECT_BY_CODE[sess.subject_code] || sess.subject_code || '';
  const gradeForDoc = testedGrade ?? (sess.grade > 0 ? sess.grade : null);

  // ── ИИ: темы + число занятий ──────────────────────────────────────────────
  const systemPrompt = await getTeacherPrompt(teacherId, 'kp_topics').catch(() => DEFAULT_PROMPTS.kp_topics);

  const taskListText = failed
    .map((r: any) => {
      const q = clean(r.question_text, 500) || '(текст задания недоступен)';
      const ref = r.reference_answer ? ` | эталонный ответ: ${clean(r.reference_answer, 200)}` : '';
      return `${r.num}. ${q}${ref}`;
    })
    .join('\n');

  const userPrompt =
    `Предмет: ${subjectName || '—'}. Класс проверочной работы: ${gradeForDoc ?? '—'}.\n\n` +
    `ЗАДАНИЯ, С КОТОРЫМИ УЧЕНИК НЕ СПРАВИЛСЯ:\n${taskListText}`;

  let plan: KpRowPlan[] = [];
  try {
    await aiThrottle.acquire();
    const raw = await callKpAI(systemPrompt, userPrompt);
    plan = parseKpPlan(raw);
  } catch (err) {
    logger.error({ err }, '[kp-generator] AI plan failed — using fallback rows');
  }

  const planByTask = new Map<number, KpRowPlan>();
  for (const p of plan) if (!planByTask.has(p.task)) planByTask.set(p.task, p);

  // ── Строки таблицы (одна на проваленное задание, порядок сохраняем) ───────
  let totalLessons = 0;
  const rowsXml = failed
    .map((r: any) => {
      const p = planByTask.get(r.num);
      const topics = p?.topics?.length
        ? p.topics
        : [clean(r.question_text, 200) || 'Тема для повторения'];
      const lessons = p?.lessons ?? 1;
      totalLessons += lessons;
      // В первом столбце — номер слайда материала (фолбэк — порядковый номер задания)
      const slide = r.slide_num != null ? r.slide_num : r.num;
      return buildRow(slide, topics, lessons);
    })
    .join('');

  // ── Подстановки в шаблон ─────────────────────────────────────────────────
  const zip = new PizZip(fs.readFileSync(templatePath()));
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('template: word/document.xml отсутствует');
  let xml = docFile.asText();

  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`;

  xml = removeNarrativeParagraph(xml);
  // Заголовок первого столбца таблицы: «№ задания» → «№ слайда»
  xml = xml.replace(
    '<w:t xml:space="preserve">№ задания</w:t>',
    '<w:t xml:space="preserve">№ слайда</w:t>',
  );
  xml = replaceValueRun(xml, '<w:t xml:space="preserve">ФИО ученика:', ` ${sess.student_name || ''}`, 2);
  // «Тест за N класс» — метку и слово « класс» шаблон держит в соседних run
  xml = replaceValueRun(xml, '<w:t xml:space="preserve">Тест за ', gradeForDoc != null ? String(gradeForDoc) : '');
  xml = replaceValueRun(xml, '<w:t xml:space="preserve">Предмет: ', subjectName);
  xml = replaceValueRun(xml, '<w:t xml:space="preserve">Дата составления: ', dateStr);
  xml = replaceValueRun(xml, '<w:t xml:space="preserve">Составил преподаватель – ', sess.teacher_name || '');

  // Рекомендованное количество часов = сумма занятий
  xml = xml.replace(
    /(<w:t xml:space="preserve">)18(<\/w:t><\/w:r><w:bookmarkStart)/,
    `$1${totalLessons}$2`,
  );

  xml = fillTable(xml, rowsXml);

  zip.file('word/document.xml', xml);
  const buffer: Buffer = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });

  // ── Имя файла: «КП ФИ класс предмет» ─────────────────────────────────────
  const nameParts = String(sess.student_name || '').trim().split(/\s+/).filter(Boolean);
  const fi = nameParts.length >= 2 ? `${nameParts[1]} ${nameParts[0]}` : (nameParts[0] || 'ученик');
  const filename =
    `КП ${fi}${gradeForDoc != null ? ` ${gradeForDoc}` : ''}${subjectName ? ` ${subjectName}` : ''}.docx`
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  return { filename, buffer };
}
