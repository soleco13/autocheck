import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
  maxRetries: 3,
});
const MODEL = 'claude-sonnet-4-6';

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
    SELECT ss.*, cs.title, cs.grade, cs.subject_code, cs.topic,
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

  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here') {
    try {
      const summaryPrompt = `Ты — учитель. Напиши краткий (2-3 предложения) комментарий ученику ${session.grade} класса по результатам работы "${session.topic}".
Оценка: ${grade} (${percentage.toFixed(0)}%).
Ответь на русском языке, доброжелательно и конструктивно.`;

      const teacherPrompt = `Сформируй краткую сводку для учителя по работе ученика ${session.student_name} (${session.grade} класс).
Тема: ${session.topic}. Оценка: ${grade} (${percentage.toFixed(0)}%).
Количество заданий: ${answers.length}, верных: ${answers.filter((a: any) => a.status === 'correct').length}.
Укажи на слабые места. 2-3 предложения.`;

      // Run both summaries in parallel — they are independent.
      const [msg, msg2] = await Promise.all([
        anthropic.messages.create({ model: MODEL, max_tokens: 256, messages: [{ role: 'user', content: summaryPrompt }] }),
        anthropic.messages.create({ model: MODEL, max_tokens: 256, messages: [{ role: 'user', content: teacherPrompt }] }),
      ]);
      aiSummaryForStudent = msg.content[0].type === 'text' ? msg.content[0].text : '';
      aiSummaryForTeacher = msg2.content[0].type === 'text' ? msg2.content[0].text : '';

      // Log token usage (non-fatal)
      const teacherRow = await db.query('SELECT teacher_id FROM student_sessions WHERE id = $1', [sessionId]);
      const teacherId = teacherRow.rows[0]?.teacher_id;
      if (teacherId) {
        const totalIn = (msg.usage?.input_tokens || 0) + (msg2.usage?.input_tokens || 0);
        const totalOut = (msg.usage?.output_tokens || 0) + (msg2.usage?.output_tokens || 0);
        db.query(
          `INSERT INTO ai_call_log (teacher_id, model, prompt_tokens, completion_tokens)
           VALUES ($1, $2, $3, $4)`,
          [teacherId, MODEL, totalIn, totalOut]
        ).catch(() => {});
      }
    } catch (err) {
      console.error('Failed to generate AI summary:', err);
    }
  }

  // Save or update report
  const existing = await db.query('SELECT id FROM reports WHERE session_id = $1', [sessionId]);

  if (existing.rows[0]) {
    await db.query(`
      UPDATE reports SET
        total_score = $1, max_score = $2, percentage = $3, grade = $4,
        ai_summary_for_student = $5, ai_summary_for_teacher = $6,
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
