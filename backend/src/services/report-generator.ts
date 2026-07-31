import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db';
import { aiThrottle } from '../lib/ai-throttle';
import { getTeacherPrompt, callGPTFallback, isCircuitOpen } from './ai-checker';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
  maxRetries: 0,
});
const MODEL = process.env.AI_REPORT_MODEL || process.env.AI_CHECKER_MODEL || 'claude-sonnet-4-6';

async function callReportAI(userPrompt: string): Promise<string> {
  if (!isCircuitOpen()) {
    try {
      const msg = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1200,
        messages: [{ role: 'user', content: userPrompt }],
      });
      const textBlock = msg.content.find((b: any) => b.type === 'text' && b.text);
      return textBlock ? (textBlock as any).text : '';
    } catch (err: any) {
      const status: number = err?.status ?? 0;
      const body = String(err?.message ?? '').toLowerCase();
      const isTransient = status >= 500 || status === 429 ||
        (status === 400 && (body.includes('model not found') || body.includes('model_not_found'))) ||
        body.includes('overload') || body.includes('timeout');
      if (!isTransient) throw err;
      console.warn(`[report-generator] Claude unavailable, using GPT fallback`);
    }
  }
  return callGPTFallback(userPrompt, 'Ты помощник учителя. Отвечай кратко и по-русски.', 1200);
}

function scoreToGrade(percentage: number): string {
  if (percentage >= 85) return '5';
  if (percentage >= 65) return '4';
  if (percentage >= 50) return '3';
  return '2';
}

export async function generateReport(sessionId: string): Promise<string> {
  const answersResult = await db.query(`
    SELECT a.score, a.status, a.ai_feedback, a.student_answer,
           t.question_text, t.max_score, t.task_type
    FROM answers a
    JOIN tasks t ON t.id = a.task_id
    WHERE a.session_id = $1
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

  // teacherId for prompt lookup — fetched once per report generation
  const teacherRow = await db.query('SELECT teacher_id FROM student_sessions WHERE id = $1', [sessionId]);
  const teacherId: string | null = teacherRow.rows[0]?.teacher_id ?? null;

  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here') {
    try {
      // Load teacher-customisable prompts from DB (cached 5 min), fall back to defaults
      const [studentPromptBase, teacherPromptBase] = await Promise.all([
        getTeacherPrompt(teacherId, 'report_student'),
        getTeacherPrompt(teacherId, 'report_teacher'),
      ]);

      const correctCount = answers.filter((a: any) => a.status === 'correct').length;

      const summaryPrompt =
        `${studentPromptBase}\n\n` +
        `Ученик: ${session.grade} класс. Работа: «${session.topic}». ` +
        `Оценка: ${grade} (${percentage.toFixed(0)}%). Верных заданий: ${correctCount} из ${answers.length}.`;

      const teacherSummaryPrompt =
        `${teacherPromptBase}\n\n` +
        `Ученик: ${session.grade} класс. Тема: «${session.topic}». ` +
        `Оценка: ${grade} (${percentage.toFixed(0)}%). ` +
        `Верных: ${correctCount}/${answers.length}. ` +
        `Неверных: ${answers.filter((a: any) => a.status === 'incorrect').length}.`;

      // Throttle both calls (2 slots) before firing — prevents 429 cascade under bulk load.
      await aiThrottle.acquire();
      await aiThrottle.acquire();
      const [studentText, teacherText] = await Promise.all([
        callReportAI(summaryPrompt),
        callReportAI(teacherSummaryPrompt),
      ]);
      aiSummaryForStudent = studentText;
      aiSummaryForTeacher = teacherText;
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
        status = $7, generated_at = NOW()
      WHERE session_id = $8
      RETURNING id
    `, [totalScore, maxScore, percentage, grade, aiSummaryForStudent, aiSummaryForTeacher, status, sessionId]);
    return existing.rows[0].id;
  } else {
    const result = await db.query(`
      INSERT INTO reports (session_id, total_score, max_score, percentage, grade,
        ai_summary_for_student, ai_summary_for_teacher, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [sessionId, totalScore, maxScore, percentage, grade, aiSummaryForStudent, aiSummaryForTeacher, status]);
    return result.rows[0].id;
  }
}
