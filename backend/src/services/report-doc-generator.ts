import PizZip from 'pizzip';
import { loadImage } from '@napi-rs/canvas';
import { db } from '../db';
import { logger } from '../lib/logger';
import { SUBJECT_BY_CODE } from './kp-generator';

/**
 * Экспорт страницы отчёта о проверке в .docx.
 *
 * Документ собирается из данных отчёта (reports + answers + tasks), а не
 * скриншотится со страницы: содержательно повторяет отчёт (шапка, итог,
 * карта работы, обе ИИ-сводки, разбор по каждому заданию, фото ответов),
 * но в «документном» оформлении.
 */

export class ReportDocError extends Error {
  constructor(message: string, public code: 'NOT_FOUND') {
    super(message);
  }
}

// ── half-points / twips / EMU ───────────────────────────────────────────────
const EMU_PER_CM = 360000;
const MAX_IMG_WIDTH_EMU = 15 * EMU_PER_CM;

const STATUS_RU: Record<string, string> = {
  correct: 'верно',
  incorrect: 'ошибка',
  partial: 'частично верно',
  manual_required: 'нужна проверка учителя',
  not_answered: 'нет ответа',
  skipped: 'пропущено',
  pending: 'ожидание',
  error: 'ошибка проверки',
};

const STATUS_FILL: Record<string, string> = {
  correct: 'C6EFCE',
  incorrect: 'FFC7CE',
  partial: 'FFEB9C',
  manual_required: 'FFE0C2',
  not_answered: 'E7E6E6',
  skipped: 'E7E6E6',
};

const TASK_TYPE_RU: Record<string, string> = {
  check_value: 'краткий ответ',
  open_answer: 'развёрнутый ответ',
  matches: 'сопоставление',
  input: 'ввод ответа',
  quiz: 'выбор варианта',
  fill_blanks: 'заполнение пропусков',
  photo_answer: 'фото рукописного решения',
};

// ── XML helpers ────────────────────────────────────────────────────────────
const esc = (s: any): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Грубая нормализация LaTeX-обрывков в читаемый текст. */
function mathToText(s: any): string {
  let t = String(s ?? '');
  t = t.replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2');
  t = t.replace(/\\(cdot|times)\b/g, '·');
  t = t.replace(/\\(le|leq)\b/g, '≤').replace(/\\(ge|geq)\b/g, '≥').replace(/\\neq\b/g, '≠');
  t = t.replace(/\\(ldots|dots)\b/g, '…');
  t = t.replace(/\\(left|right|bigg?|Big|displaystyle)\b/g, '');
  t = t.replace(/\\[a-zA-Z]+/g, '');
  t = t.replace(/\\[,;!]/g, '');
  t = t.replace(/[${}]/g, '');
  t = t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n');
  return t.trim();
}

const clip = (s: any, n: number): string => {
  const t = mathToText(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// ── document.xml building blocks ───────────────────────────────────────────
type RunOpts = { b?: boolean; i?: boolean; color?: string; sz?: number };

function run(text: string, o: RunOpts = {}): string {
  const rpr =
    `<w:rPr>` +
    (o.b ? '<w:b/>' : '') +
    (o.i ? '<w:i/>' : '') +
    (o.color ? `<w:color w:val="${o.color}"/>` : '') +
    (o.sz ? `<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>` : '') +
    `</w:rPr>`;
  // переносы строк внутри текста → <w:br/>
  const parts = String(text).split('\n');
  const body = parts
    .map((p, i) => (i > 0 ? '<w:br/>' : '') + `<w:t xml:space="preserve">${esc(p)}</w:t>`)
    .join('');
  return `<w:r>${rpr}${body}</w:r>`;
}

function para(runsXml: string, o: { style?: string; spaceBefore?: number; spaceAfter?: number; ind?: number } = {}): string {
  const ppr =
    `<w:pPr>` +
    (o.style ? `<w:pStyle w:val="${o.style}"/>` : '') +
    (o.ind ? `<w:ind w:left="${o.ind}"/>` : '') +
    (o.spaceBefore != null || o.spaceAfter != null
      ? `<w:spacing${o.spaceBefore != null ? ` w:before="${o.spaceBefore}"` : ''}${o.spaceAfter != null ? ` w:after="${o.spaceAfter}"` : ''}/>`
      : '') +
    `</w:pPr>`;
  return `<w:p>${ppr}${runsXml}</w:p>`;
}

const H1 = (t: string) => para(run(t, { b: true, sz: 36 }), { spaceAfter: 120 });
const H2 = (t: string) => para(run(t, { b: true, sz: 28, color: '1F4E79' }), { spaceBefore: 320, spaceAfter: 120 });

/** «Метка: значение» строкой. */
function labelValue(label: string, value: string): string {
  return para(run(label + ': ', { b: true }) + run(value || '—'), { spaceAfter: 40 });
}

// ── main ───────────────────────────────────────────────────────────────────
export interface ReportDocResult {
  filename: string;
  buffer: Buffer;
}

export async function generateReportDocx(
  sessionOrReportId: string,
  teacherId: string,
): Promise<ReportDocResult> {
  const r = await db.query(
    `SELECT rep.id AS report_id, rep.total_score, rep.max_score, rep.percentage,
            rep.grade AS report_grade, rep.status, rep.generated_at,
            rep.ai_summary_for_student, rep.ai_summary_for_teacher,
            ss.id AS session_id, ss.fetched_at,
            s.full_name AS student_name,
            cs.title, cs.topic, cs.grade, cs.subject_code,
            tb.subject_name
     FROM reports rep
     JOIN student_sessions ss ON ss.id = rep.session_id
     JOIN students s ON s.id = ss.student_id
     JOIN control_sheets cs ON cs.id = ss.control_sheet_id
     LEFT JOIN textbooks tb ON tb.id = cs.textbook_id
     WHERE (ss.id = $1 OR rep.id = $1) AND ss.teacher_id = $2
     LIMIT 1`,
    [sessionOrReportId, teacherId],
  );
  if (!r.rows[0]) throw new ReportDocError('Отчёт не найден', 'NOT_FOUND');
  const rep = r.rows[0];

  const ans = await db.query(
    `SELECT a.id, a.student_answer, a.student_answer_structured, a.status, a.score,
            a.teacher_override_score, a.ai_feedback, a.ai_teacher_note,
            t.question_text, t.task_type, t.reference_answer, t.slide_num, t.task_index,
            t.max_score
     FROM answers a
     JOIN tasks t ON t.id = a.task_id
     WHERE a.session_id = $1
     ORDER BY t.task_index ASC NULLS LAST, a.created_at ASC`,
    [rep.session_id],
  );
  const answers = ans.rows;

  // ── подсчёты ──
  const effScore = (x: any) => (x.teacher_override_score != null ? x.teacher_override_score : x.score) ?? 0;
  const totalScore = rep.total_score ?? answers.reduce((s: number, a: any) => s + effScore(a), 0);
  const maxScore = rep.max_score ?? answers.reduce((s: number, a: any) => s + (a.max_score || 1), 0);
  const pct = rep.percentage != null ? Math.round(Number(rep.percentage)) : maxScore ? Math.round((totalScore / maxScore) * 100) : 0;

  const countBy = (st: string) => answers.filter((a: any) => a.status === st).length;
  const summaryCounts = [
    ['верно', countBy('correct')],
    ['частично', countBy('partial')],
    ['неверно', countBy('incorrect')],
    ['нет ответа', countBy('not_answered') + countBy('skipped')],
    ['нужна проверка', countBy('manual_required')],
  ].filter(([, n]) => (n as number) > 0) as [string, number][];

  const dateStr = new Date(rep.generated_at || rep.fetched_at || Date.now()).toLocaleDateString('ru-RU');
  const subject =
    rep.subject_name ||
    SUBJECT_BY_CODE[String(rep.subject_code || '').toUpperCase()] ||
    rep.subject_code ||
    '—';

  // ── картинки: качаем фото ответов ──
  const zip = new PizZip();
  const rels: string[] = [`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`];
  const imageExts = new Set<string>();
  let relSeq = 2;
  let imgSeq = 1;
  let imgBudget = 20 * 1024 * 1024;
  const deadline = Date.now() + 25_000;

  async function embedPhoto(url: string): Promise<string | null> {
    if (!/^https?:\/\//i.test(url) || imgSeq > 8 || Date.now() > deadline || imgBudget <= 0) return null;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!resp.ok) return null;
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpeg';
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > imgBudget) return null;
      imgBudget -= buf.length;

      let cx = MAX_IMG_WIDTH_EMU;
      let cy = Math.round(MAX_IMG_WIDTH_EMU * 0.66);
      try {
        const im = await loadImage(buf);
        if (im.width && im.height) {
          const scale = Math.min(1, MAX_IMG_WIDTH_EMU / (im.width * 9525));
          cx = Math.round(im.width * 9525 * scale);
          cy = Math.round(im.height * 9525 * scale);
        }
      } catch { /* размеры по умолчанию */ }

      const name = `image${imgSeq}.${ext}`;
      zip.file(`word/media/${name}`, buf);
      imageExts.add(ext);
      const rId = `rId${relSeq++}`;
      rels.push(`<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
      imgSeq++;
      const docPrId = 1000 + imgSeq;
      return (
        `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr><w:r><w:drawing>` +
        `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
        `<wp:extent cx="${cx}" cy="${cy}"/>` +
        `<wp:docPr id="${docPrId}" name="Фото ${imgSeq - 1}"/>` +
        `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
        `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:nvPicPr><pic:cNvPr id="${docPrId}" name="Фото ${imgSeq - 1}"/><pic:cNvPicPr/></pic:nvPicPr>` +
        `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
        `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
        `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
      );
    } catch (err: any) {
      logger.warn({ err: err?.message }, '[report-doc] photo embed failed');
      return null;
    }
  }

  // ── тело документа ──
  const body: string[] = [];
  body.push(H1('Отчёт о проверке работы'));

  body.push(labelValue('Ученик', rep.student_name));
  body.push(labelValue('Материал', rep.title));
  if (rep.topic) body.push(labelValue('Тема', rep.topic));
  if (rep.grade) body.push(labelValue('Класс', String(rep.grade)));
  body.push(labelValue('Предмет', subject));
  body.push(labelValue('Дата проверки', dateStr));

  body.push(
    para(
      run(`Результат: ${pct}% · ${totalScore} из ${maxScore} баллов` + (rep.report_grade ? ` · оценка ${rep.report_grade}` : ''), { b: true, sz: 28 }),
      { spaceBefore: 200, spaceAfter: 60 },
    ),
  );
  if (summaryCounts.length) {
    body.push(para(run(summaryCounts.map(([l, n]) => `${l}: ${n}`).join('  ·  '), { color: '595959' })));
  }
  if (rep.status === 'manual_required') {
    body.push(para(run('В работе есть задания, требующие ручной проверки учителем.', { i: true, color: 'C2410C' }), { spaceBefore: 40 }));
  }

  // ── карта работы ──
  body.push(H2('Карта работы'));
  const mapRows = answers
    .map((a: any, i: number) => {
      const num = a.task_index != null ? a.task_index + 1 : i + 1;
      const slide = a.slide_num != null ? a.slide_num : '';
      const fill = STATUS_FILL[a.status] || 'FFFFFF';
      const cell = (txt: string, opts: { fill?: string; w: number; jc?: string } ) =>
        `<w:tc><w:tcPr><w:tcW w:w="${opts.w}" w:type="dxa"/>` +
        (opts.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${opts.fill}"/>` : '') +
        `</w:tcPr><w:p><w:pPr><w:jc w:val="${opts.jc || 'left'}"/></w:pPr>${run(txt)}</w:p></w:tc>`;
      return (
        `<w:tr>` +
        cell(String(num), { w: 900, jc: 'center' }) +
        cell(String(slide), { w: 1000, jc: 'center' }) +
        cell(clip(a.question_text, 70), { w: 5400 }) +
        cell(STATUS_RU[a.status] || a.status, { w: 2100, fill }) +
        cell(`${effScore(a)}/${a.max_score || 1}`, { w: 1100, jc: 'center' }) +
        `</w:tr>`
      );
    })
    .join('');
  const mapHeader =
    `<w:tr>` +
    ['№', '№ слайда', 'Задание', 'Статус', 'Балл']
      .map((h, idx) => {
        const w = [900, 1000, 5400, 2100, 1100][idx];
        return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run(h, { b: true })}</w:p></w:tc>`;
      })
      .join('') +
    `</w:tr>`;
  body.push(
    `<w:tbl><w:tblPr><w:tblW w:w="10500" w:type="dxa"/><w:tblBorders>` +
      `<w:top w:val="single" w:sz="4" w:color="AAAAAA"/><w:left w:val="single" w:sz="4" w:color="AAAAAA"/>` +
      `<w:bottom w:val="single" w:sz="4" w:color="AAAAAA"/><w:right w:val="single" w:sz="4" w:color="AAAAAA"/>` +
      `<w:insideH w:val="single" w:sz="4" w:color="AAAAAA"/><w:insideV w:val="single" w:sz="4" w:color="AAAAAA"/>` +
      `</w:tblBorders></w:tblPr>${mapHeader}${mapRows}</w:tbl>`,
  );

  // ── ИИ-сводки ──
  if ((rep.ai_summary_for_student || '').trim()) {
    body.push(H2('Комментарий для ученика'));
    body.push(para(run(mathToText(rep.ai_summary_for_student))));
  }
  if ((rep.ai_summary_for_teacher || '').trim()) {
    body.push(H2('Рекомендации учителю'));
    body.push(para(run(mathToText(rep.ai_summary_for_teacher))));
  }

  // ── разбор по заданиям ──
  body.push(H2('Разбор по заданиям'));
  for (let i = 0; i < answers.length; i++) {
    const a = answers[i];
    const num = a.task_index != null ? a.task_index + 1 : i + 1;
    const slide = a.slide_num != null ? ` · слайд ${a.slide_num}` : '';
    const typeRu = TASK_TYPE_RU[a.task_type] || a.task_type || 'задание';
    const head = `Задание ${num}${slide} · ${typeRu} — ${STATUS_RU[a.status] || a.status}, балл ${effScore(a)} из ${a.max_score || 1}`;
    body.push(para(run(head, { b: true, sz: 26 }), { spaceBefore: 240, spaceAfter: 60 }));

    const structured: any = a.student_answer_structured || {};
    const condition = mathToText(a.question_text || structured._slideProblem || structured._instruction || '');
    if (condition) {
      body.push(para(run('Условие: ', { b: true }) + run(clip(condition, 1500)), { ind: 200, spaceAfter: 40 }));
    }

    const photos: any[] = Array.isArray(structured.photos) ? structured.photos : [];
    if (a.task_type === 'photo_answer' && photos.length) {
      body.push(para(run('Ответ ученика (фото):', { b: true }), { ind: 200, spaceAfter: 40 }));
      for (const ph of photos.slice(0, 8)) {
        const drawn = await embedPhoto(ph?.url);
        if (drawn) body.push(drawn);
        else body.push(para(run(`[фото: ${esc(ph?.name || ph?.url || '—')}]`, { i: true, color: '888888' }), { ind: 200 }));
      }
    } else {
      const stu = mathToText(a.student_answer || '');
      body.push(
        para(run('Ответ ученика: ', { b: true }) + (stu ? run(clip(stu, 1200)) : run('нет ответа', { i: true, color: '888888' })), { ind: 200, spaceAfter: 40 }),
      );
    }

    if (a.status !== 'correct' && (a.reference_answer || '').trim()) {
      body.push(para(run('Верный ответ: ', { b: true, color: '0F766E' }) + run(clip(a.reference_answer, 800), { color: '0F766E' }), { ind: 200, spaceAfter: 40 }));
    }
    if ((a.ai_feedback || '').trim()) {
      body.push(para(run('Комментарий проверки: ', { b: true }) + run(clip(a.ai_feedback, 1500)), { ind: 200, spaceAfter: 40 }));
    }
    if ((a.ai_teacher_note || '').trim()) {
      body.push(para(run('Заметка для учителя: ', { b: true, color: 'C2410C' }) + run(clip(a.ai_teacher_note, 1200), { color: 'C2410C' }), { ind: 200, spaceAfter: 40 }));
    }
  }

  // ── сборка docx ──
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<w:body>${body.join('')}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>` +
    `</w:sectPr></w:body></w:document>`;

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr>` +
    `<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>` +
    `<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="ru-RU"/>` +
    `</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
    `</w:styles>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    (imageExts.has('jpeg') ? `<Default Extension="jpeg" ContentType="image/jpeg"/>` : '') +
    (imageExts.has('png') ? `<Default Extension="png" ContentType="image/png"/>` : '') +
    (imageExts.has('webp') ? `<Default Extension="webp" ContentType="image/webp"/>` : '') +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `</Types>`;

  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`);
  zip.file('word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', stylesXml);

  const buffer: Buffer = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });

  const nameParts = String(rep.student_name || '').trim().split(/\s+/).filter(Boolean);
  const fi = nameParts.length >= 2 ? `${nameParts[1]} ${nameParts[0]}` : (nameParts[0] || 'ученик');
  const filename = `Отчёт ${fi} — ${clip(rep.title, 60)} — ${dateStr}.docx`
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { filename, buffer };
}
