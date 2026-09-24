import { db } from '../db';
import { aiThrottle } from '../lib/ai-throttle';
import { getOpenRouterClient } from '../lib/openrouter-client';
import { getTeacherPrompt, callGPTFallback, isCircuitOpen } from './ai-checker';

const MODEL = process.env.AI_REPORT_MODEL || process.env.AI_CHECKER_MODEL || 'anthropic/claude-sonnet-5';

async function callReportAI(userPrompt: string, maxTokens = 1200): Promise<string> {
  if (!isCircuitOpen()) {
    try {
      const client = getOpenRouterClient();
      const response = await client.chat.completions.create({
        model: MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: userPrompt }],
      });
      if (response.choices[0]?.finish_reason === 'length') {
        console.warn(`[report-generator] ${MODEL} response hit the ${maxTokens}-token cap — summary may be cut off`);
      }
      return response.choices[0]?.message?.content ?? '';
    } catch (err: any) {
      const status: number = err?.status ?? 0;
      const body = String(err?.message ?? '').toLowerCase();
      const isTransient = status >= 500 || status === 429 ||
        (status === 400 && (body.includes('model not found') || body.includes('model_not_found'))) ||
        body.includes('overload') || body.includes('timeout');
      if (!isTransient) throw err;
      console.warn(`[report-generator] ${MODEL} unavailable, using fallback`);
    }
  }
  return callGPTFallback(userPrompt, 'Ты помощник учителя. Отвечай по-русски.', maxTokens);
}

const STATUS_RU: Record<string, string> = {
  correct: 'верно',
  incorrect: 'ошибка',
  partial: 'частично верно',
  manual_required: 'нужна проверка учителя',
  not_answered: 'нет ответа',
  skipped: 'пропущено',
};

const clean = (s: any, n: number): string =>
  String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const TASK_TYPE_RU: Record<string, string> = {
  check_value: 'задание с кратким ответом',
  open_answer: 'задание с развёрнутым ответом',
  matches: 'задание на сопоставление',
  input: 'задание с вводом ответа',
  quiz: 'тест с выбором варианта',
  fill_blanks: 'задание на заполнение пропусков',
  photo_answer: 'задание с фото рукописного решения',
};

function scoreToGrade(percentage: number): string {
  if (percentage >= 85) return '5';
  if (percentage >= 65) return '4';
  if (percentage >= 50) return '3';
  return '2';
}

export async function generateReport(sessionId: string): Promise<string> {
  const answersResult = await db.query(`
    SELECT a.score, a.status, a.ai_feedback, a.ai_teacher_note, a.student_answer,
           a.teacher_override_score,
           t.question_text, t.max_score, t.task_type, t.task_index, t.reference_answer
    FROM answers a
    JOIN tasks t ON t.id = a.task_id
    WHERE a.session_id = $1
    ORDER BY t.task_index ASC NULLS LAST, a.created_at ASC
  `, [sessionId]);

  const sessionResult = await db.query(`
    SELECT ss.id, ss.student_id, ss.teacher_id, ss.fetched_at,
           cs.title, cs.grade, cs.subject_code, cs.topic,
           s.full_name as student_name,
           tb.subject_name
    FROM student_sessions ss
    JOIN control_sheets cs ON cs.id = ss.control_sheet_id
    JOIN students s ON s.id = ss.student_id
    LEFT JOIN textbooks tb ON tb.id = cs.textbook_id
    WHERE ss.id = $1
  `, [sessionId]);

  if (!sessionResult.rows[0]) throw new Error('Session not found');
  const session = sessionResult.rows[0];
  const answers = answersResult.rows;

  const totalScore = answers.reduce((sum: number, a: any) => sum + (a.score || 0), 0);
  const maxScore = answers.reduce((sum: number, a: any) => sum + (a.max_score || 1), 0);
  const percentage = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;
  const grade = scoreToGrade(percentage);

  const hasManualRequired = answers.some((a: any) => a.status === 'manual_required');
  const status = hasManualRequired ? 'manual_required' : 'completed';

  // Generate AI summary
  let aiSummaryForStudent = '';
  let aiSummaryForTeacher = '';
  let aiTopicsCovered = '';

  // teacherId for prompt lookup — fetched once per report generation
  const teacherRow = await db.query('SELECT teacher_id FROM student_sessions WHERE id = $1', [sessionId]);
  const teacherId: string | null = teacherRow.rows[0]?.teacher_id ?? null;

  if (process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY !== 'your_openrouter_api_key_here') {
    try {
      // Load teacher-customisable prompts from DB (cached 5 min), fall back to defaults
      const [studentPromptBase, teacherPromptBase, topicsPromptBase] = await Promise.all([
        getTeacherPrompt(teacherId, 'report_student'),
        getTeacherPrompt(teacherId, 'report_teacher'),
        getTeacherPrompt(teacherId, 'report_topics'),
      ]);

      const correctCount = answers.filter((a: any) => a.status === 'correct').length;

      // Full per-task breakdown — every task, in order, with the student's answer,
      // the reference answer and the checker's verdict (text checker + vision model
      // for photo tasks). This is the raw material the report model turns into a
      // detailed, task-by-task feedback for the student.
      const taskBreakdown = answers
        .map((a: any, i: number) => {
          const num = a.task_index != null ? a.task_index + 1 : i + 1;
          const eff = a.teacher_override_score != null ? a.teacher_override_score : a.score;
          const typeRu = TASK_TYPE_RU[a.task_type] || a.task_type || 'задание';
          const lines = [
            `Задание ${num} — ${typeRu}. Результат: ${STATUS_RU[a.status] || a.status}, балл ${eff ?? 0} из ${a.max_score || 1}`,
            `  Условие: ${clean(a.question_text, 600) || '—'}`,
            // Matching answers list every pair (≈40 chars each) — 400 cut the tail off
            // and the report model "found" errors in pairs it never saw.
            `  Ответ ученика: ${clean(a.student_answer, 1200) || '—'}`,
          ];
          if (a.reference_answer) lines.push(`  Эталонный ответ: ${clean(a.reference_answer, 400)}`);
          if (a.ai_feedback) lines.push(`  Что показала проверка: ${clean(a.ai_feedback, 700)}`);
          if (a.ai_teacher_note) lines.push(`  Заметка для учителя: ${clean(a.ai_teacher_note, 500)}`);
          return lines.join('\n');
        })
        .join('\n\n');

      const incorrectCount = answers.filter((a: any) => a.status === 'incorrect').length;
      const partialCount = answers.filter((a: any) => a.status === 'partial').length;
      const manualCount = answers.filter((a: any) => a.status === 'manual_required').length;

      const commonContext =
        `Класс: ${session.grade}. Предмет: ${session.subject_name || session.subject_code || '—'}. ` +
        `Тема: «${session.topic || session.title}».\n` +
        `Верных заданий ${correctCount} из ${answers.length} ` +
        `(с ошибкой: ${incorrectCount}, частично: ${partialCount}, требуют ручной проверки: ${manualCount}). ` +
        `Выполнено на ${percentage.toFixed(0)}%.`;

      const studentContext = `КОНТЕКСТ РАБОТЫ\n${commonContext}`;
      const teacherContext = `КОНТЕКСТ РАБОТЫ\n${commonContext} Предварительная оценка: ${grade}.`;

      const noInventRule =
        'ВАЖНО: называй ошибку только если она прямо указана в «Что показала проверка» или видна из сравнения ' +
        'с эталоном. Если задание помечено как ошибка, но конкретная ошибка не указана — не придумывай её, ' +
        'просто скажи, что задание стоит перепроверить.';

      const summaryPrompt =
        `${studentPromptBase}\n\n${studentContext}\n\n` +
        `РАЗБОР ПО ЗАДАНИЯМ (это исходные данные для тебя — опирайся только на них):\n\n${taskBreakdown}\n\n${noInventRule}`;

      const teacherSummaryPrompt =
        `${teacherPromptBase}\n\n${teacherContext}\n\n` +
        `РАЗБОР ПО ЗАДАНИЯМ:\n\n${taskBreakdown}\n\n${noInventRule}`;

      const topicsPrompt =
        `${topicsPromptBase}\n\n${studentContext}\n\n` +
        `РАЗБОР ПО ЗАДАНИЯМ:\n\n${taskBreakdown}`;

      // Throttle all three calls (3 slots) before firing — prevents 429 cascade under bulk load.
      await aiThrottle.acquire();
      await aiThrottle.acquire();
      await aiThrottle.acquire();
      // Cyrillic tokenises at roughly 2 chars/token, so the prompt's "4–6
      // предложений" / "3–5 предложений" paragraphs plus any run-over need real
      // headroom — 700/550 was cutting summaries off mid-sentence.
      const [studentText, teacherText, topicsText] = await Promise.all([
        callReportAI(summaryPrompt, 1500),
        callReportAI(teacherSummaryPrompt, 1500),
        callReportAI(topicsPrompt, 500),
      ]);
      aiSummaryForStudent = studentText;
      aiSummaryForTeacher = teacherText;
      aiTopicsCovered = topicsText;
    } catch (err) {
      console.error('Failed to generate AI summary:', err);
    }
  }

  // Save or update report
  const existing = await db.query('SELECT id FROM reports WHERE session_id = $1', [sessionId]);

  if (existing.rows[0]) {
    // Only overwrite AI summaries if the new generation produced non-empty text.
    // Empty string means AI failed (circuit open, timeout, etc.) — preserve the previous valid summary.
    await db.query(`
      UPDATE reports SET
        total_score = $1, max_score = $2, percentage = $3, grade = $4,
        ai_summary_for_student = CASE WHEN $5 != '' THEN $5::text ELSE ai_summary_for_student END,
        ai_summary_for_teacher = CASE WHEN $6 != '' THEN $6::text ELSE ai_summary_for_teacher END,
        ai_topics_covered = CASE WHEN $7 != '' THEN $7::text ELSE ai_topics_covered END,
        status = $8, generated_at = NOW()
      WHERE session_id = $9
      RETURNING id
    `, [totalScore, maxScore, percentage, grade, aiSummaryForStudent, aiSummaryForTeacher, aiTopicsCovered, status, sessionId]);
    return existing.rows[0].id;
  } else {
    const result = await db.query(`
      INSERT INTO reports (session_id, total_score, max_score, percentage, grade,
        ai_summary_for_student, ai_summary_for_teacher, ai_topics_covered, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [sessionId, totalScore, maxScore, percentage, grade, aiSummaryForStudent, aiSummaryForTeacher, aiTopicsCovered, status]);
    return result.rows[0].id;
  }
}
