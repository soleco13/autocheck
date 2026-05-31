import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db';

let anthropic: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    if (!apiKey || apiKey === 'your_anthropic_api_key_here') {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }
    anthropic = new Anthropic({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      maxRetries: 3,
    });
  }
  return anthropic;
}

interface CheckResult {
  status: 'correct' | 'partial' | 'incorrect' | 'manual_required';
  score: number;
  maxScore: number;
  feedbackForStudent: string;
  feedbackForTeacher: string;
}

interface AICheckContext {
  taskType: string;
  questionText: string;   // full task text (problem + per-input hint)
  acceptable: string[];   // structured correct answers (rulesChecker), may be empty
  answerKey: string;      // textual answer key from "Критерии оценивания" (may be empty)
  criteria: string;       // grading criteria text (may be empty)
  studentAnswer: string;
  grade: number;
  subjectCode: string;
  topic: string;
}

async function checkWithAI(ctx: AICheckContext): Promise<CheckResult> {
  const client = getClient();

  const systemPrompt = `Ты — ИИ-проверщик контрольных и домашних работ для онлайн-школы. Ты проверяешь ответ ученика, ОПИРАЯСЬ на условие задания, критерии и эталонный ответ, которые тебе даны. Не выдумывай условие и не пиши, что контекста не хватает, если он приведён ниже. Отвечай ТОЛЬКО валидным JSON без markdown.`;

  const gradeStr = ctx.grade > 0 ? `${ctx.grade} класс` : '';
  const subjectStr = ctx.subjectCode && ctx.subjectCode !== 'XX' ? ctx.subjectCode : '';
  const topicStr = ctx.topic && ctx.topic !== 'Unknown' ? ctx.topic : '';
  const contextLine = [subjectStr, gradeStr, topicStr ? `тема: ${topicStr}` : ''].filter(Boolean).join(', ');

  const hasReference = ctx.acceptable.length > 0 || ctx.answerKey.trim() !== '';
  const referenceStr = ctx.acceptable.length > 0
    ? ctx.acceptable.join(' / ')
    : ctx.answerKey;

  const lines: string[] = [];
  if (contextLine) lines.push(contextLine + '.');
  lines.push(`Задание: ${ctx.questionText || '(текст задания отсутствует)'}`);
  if (ctx.criteria) lines.push(`Критерии оценивания: ${ctx.criteria}`);
  if (hasReference) lines.push(`Правильный ответ: ${referenceStr}`);
  lines.push(`Ответ ученика: ${ctx.studentAnswer || '(пусто)'}`);

  if (hasReference) {
    lines.push(`
Сравни ответ ученика с правильным ответом по смыслу. Числа могут быть записаны по-разному (дроби, единицы измерения, лишние пробелы, запятая или точка как разделитель) — такие различия НЕ считаются ошибкой. Ответ верен, если совпадает по математическому/смысловому значению.
Верни JSON: {"correct": true/false, "feedback_student": "краткая обратная связь ученику", "feedback_teacher": "заметка для учителя"}`);
  } else {
    lines.push(`
Оцени правильность и полноту ответа ученика по условию задания${ctx.criteria ? ' и критериям' : ''}.
Верни JSON: {"score": 0-1 (доля правильности), "feedback_student": "краткая обратная связь ученику", "feedback_teacher": "заметка для учителя"}`);
  }

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n') }],
  });

  // Return usage alongside result for caller to log
  (checkWithAI as any).__lastUsage = response.usage;

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

  if (hasReference) {
    const isCorrect: boolean = parsed.correct === true;
    return {
      status: isCorrect ? 'correct' : 'incorrect',
      score: isCorrect ? 1 : 0,
      maxScore: 1,
      feedbackForStudent: parsed.feedback_student || (isCorrect ? 'Верно!' : 'Неверно.'),
      feedbackForTeacher: parsed.feedback_teacher || '',
    };
  } else {
    const scoreRaw: number = typeof parsed.score === 'number' ? parsed.score : 0;
    const score = Math.round(scoreRaw);
    return {
      status: scoreRaw >= 0.8 ? 'correct' : scoreRaw >= 0.4 ? 'partial' : 'incorrect',
      score,
      maxScore: 1,
      feedbackForStudent: parsed.feedback_student || '',
      feedbackForTeacher: parsed.feedback_teacher || '',
    };
  }
}

// Normalizes an answer for deterministic comparison: lowercase, strip spaces and
// surrounding quotes, unify decimal separator.
function normalizeAnswer(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '').replace(/,/g, '.').replace(/[«»"'`]/g, '');
}

// True when both strings denote the same number (e.g. "1530" vs "1530 км" vs "1530,0").
// Fractions/expressions (containing "/") are left to string compare / AI so we never
// mis-read "1/4" as the integer 14.
function numericEqual(a: string, b: string): boolean {
  if (/[\/]/.test(a) || /[\/]/.test(b)) return false;
  const toNum = (s: string) => parseFloat(s.replace(',', '.').replace(/[^\d.\-]/g, ''));
  const na = toNum(a), nb = toNum(b);
  return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 1e-9;
}

// Deterministic check against the accepted answers — bypasses the AI for exact/numeric matches.
function deterministicMatch(student: string, acceptable: string[]): boolean {
  const ns = normalizeAnswer(student);
  if (!ns) return false;
  return acceptable.some(acc => normalizeAnswer(acc) === ns || numericEqual(student, acc));
}

// Checks if a hint-style question can be evaluated syntactically (no AI needed).
// Returns true/false if deterministic, null if needs AI.
function checkHintSyntactically(questionText: string, answer: string): boolean | null {
  const q = questionText.toLowerCase();
  const a = answer.trim();

  // "Первая буква Х." / "первая буква — Х"
  const firstLetter = q.match(/первая буква\s*[—–-]?\s*([а-яёa-z])/i);
  if (firstLetter) return a.toUpperCase().startsWith(firstLetter[1].toUpperCase());

  // "Название состоит из N букв."
  const letterCount = q.match(/состоит из\s+(\d+|[а-яё]+)\s+букв/i);
  if (letterCount) {
    const n = parseInt(letterCount[1]) || WORD_TO_NUM[letterCount[1].toLowerCase()] || 0;
    if (n > 0) return a.replace(/\s/g, '').length === n;
  }

  // "Название состоит из N слов."
  const wordCount = q.match(/состоит из\s+(\d+|[а-яё]+)\s+слов/i);
  if (wordCount) {
    const n = parseInt(wordCount[1]) || WORD_TO_NUM[wordCount[1].toLowerCase()] || 0;
    if (n > 0) return a.split(/\s+/).filter(Boolean).length === n;
  }

  // "Двойная «н»" / "двойная 'н'" / "двойная н" / "двойная буква н" (any quote variant)
  const doubleLetter = q.match(/двойная\s+(?:буква\s+)?\W?([а-яё])/i);
  if (doubleLetter) {
    const l = doubleLetter[1].toLowerCase();
    return a.toLowerCase().includes(l + l);
  }

  // "Последняя буква Х."
  const lastLetter = q.match(/последняя буква\s*[—–-]?\s*([а-яёa-z])/i);
  if (lastLetter) {
    const l = lastLetter[1].toLowerCase();
    return a.toLowerCase().trimEnd().slice(-1) === l;
  }

  return null;
}

const WORD_TO_NUM: Record<string, number> = {
  один: 1, одна: 1, одно: 1, одного: 1, одной: 1, одну: 1,
  два: 2, две: 2, двух: 2, двум: 2,
  три: 3, трёх: 3, трём: 3,
  четыре: 4, четырёх: 4, четырём: 4,
  пять: 5, пяти: 5, шесть: 6, шести: 6,
  семь: 7, семи: 7, восемь: 8, восьми: 8,
  девять: 9, девяти: 9, десять: 10, десяти: 10,
};

export async function checkAnswer(answerId: string): Promise<void> {
  const answerResult = await db.query(`
    SELECT a.*, t.task_type, t.question_text, t.reference_answer,
           cs.grade, cs.subject_code, cs.topic,
           ss.teacher_id
    FROM answers a
    JOIN tasks t ON t.id = a.task_id
    JOIN control_sheets cs ON cs.id = t.control_sheet_id
    JOIN student_sessions ss ON ss.id = a.session_id
    WHERE a.id = $1
  `, [answerId]);

  if (!answerResult.rows[0]) return;
  const answer = answerResult.rows[0];

  // Empty answer
  if (!answer.student_answer && !answer.student_answer_structured) {
    await db.query(
      'UPDATE answers SET status = $1, score = 0, ai_feedback = $2 WHERE id = $3',
      ['incorrect', 'Ответ не заполнен.', answerId]
    );
    return;
  }

  // Matches, quiz, fill_blanks — use platform's pre-evaluated result or direct comparison
  if (answer.task_type === 'matches' || answer.task_type === 'quiz' || answer.task_type === 'fill_blanks') {
    const raw = answer.student_answer_structured;
    const structured: any = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    const isSolved: boolean | null = structured?._isSolved ?? null;

    const labels: Record<string, string> = {
      matches: 'соответствие',
      quiz: 'выбор ответов',
      fill_blanks: 'заполнение пропусков',
    };
    const label = labels[answer.task_type] || answer.task_type;

    if (answer.task_type === 'fill_blanks') {
      // Score each item individually
      const items: any[] = structured?.items || [];
      const maxScore = answer.task_max_score || items.length || 1;
      const correctCount = items.filter((it: any) => it.studentAnswer === it.correctAnswer).length;
      const score = correctCount;
      const status = score === maxScore ? 'correct' : score === 0 ? 'incorrect' : 'partial';
      await db.query(
        'UPDATE answers SET status = $1, score = $2, ai_feedback = $3 WHERE id = $4',
        [status, score, `Верно ${correctCount} из ${maxScore}: ${items.map((it: any) => it.questionText + ' → ' + (it.studentAnswer === it.correctAnswer ? '✓' : '✗ ' + it.studentAnswer + ' (правильно: ' + it.correctAnswer + ')')).join(', ')}`, answerId]
      );
      return;
    }

    if (isSolved !== null) {
      await db.query(
        'UPDATE answers SET status = $1, score = $2, ai_feedback = $3 WHERE id = $4',
        [
          isSolved ? 'correct' : 'incorrect',
          isSolved ? 1 : 0,
          isSolved ? `Задание на ${label} выполнено верно.` : `Задание на ${label} выполнено неверно.`,
          answerId,
        ]
      );
    } else {
      await db.query(
        'UPDATE answers SET status = $1, ai_feedback = $2, ai_teacher_note = $3 WHERE id = $4',
        ['manual_required', `Задание на ${label} — требует ручной проверки.`, `Ответ: ${answer.student_answer}`, answerId]
      );
    }
    return;
  }

  try {
    const raw = answer.student_answer_structured;
    const structured: any = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;

    // Rich slide context extracted by the parser.
    const slideProblem: string = structured?._slideProblem || structured?._slideQuestion || '';
    const answerKey: string = structured?._answerKey || '';
    const criteria: string = structured?._criteria || '';
    const acceptable: string[] = Array.isArray(structured?._acceptableAnswers)
      ? structured._acceptableAnswers
      : (answer.reference_answer ? [answer.reference_answer] : []);
    const studentAnswer: string = answer.student_answer || '';

    // 1) Deterministic check against accepted answers — bulletproof for exact/numeric matches.
    if (acceptable.length > 0 && deterministicMatch(studentAnswer, acceptable)) {
      await db.query(
        'UPDATE answers SET status = $1, score = 1, ai_feedback = $2, ai_teacher_note = $3 WHERE id = $4',
        ['correct', 'Верно! Ответ совпадает с правильным.', `Ответ ученика «${studentAnswer}» совпадает с эталоном (${acceptable.join(' / ')}).`, answerId]
      );
      return;
    }

    // 2) Hint-style open answers (no reference): try a syntactic check first.
    if (answer.task_type === 'open_answer' && acceptable.length === 0 && !answerKey && answer.question_text) {
      const syntactic = checkHintSyntactically(answer.question_text, studentAnswer);
      if (syntactic !== null) {
        await db.query(
          'UPDATE answers SET status = $1, score = $2, ai_feedback = $3 WHERE id = $4',
          [
            syntactic ? 'correct' : 'incorrect',
            syntactic ? 1 : 0,
            syntactic ? 'Соответствует критерию задания.' : 'Не соответствует критерию задания.',
            answerId,
          ]
        );
        return;
      }
    }

    // 3) AI check with the full context (problem + criteria + reference answer).
    const questionText = answer.question_text || slideProblem || '';
    const result = await checkWithAI({
      taskType: answer.task_type,
      questionText,
      acceptable,
      answerKey,
      criteria,
      studentAnswer,
      grade: answer.grade,
      subjectCode: answer.subject_code,
      topic: answer.topic || '',
    });

    // Log token usage (non-fatal)
    const usage = (checkWithAI as any).__lastUsage;
    if (usage) {
      db.query(
        `INSERT INTO ai_call_log (answer_id, teacher_id, model, prompt_tokens, completion_tokens)
         VALUES ($1, $2, $3, $4, $5)`,
        [answerId, answer.teacher_id, 'claude-haiku-4-5-20251001', usage.input_tokens, usage.output_tokens]
      ).catch(() => {});
    }

    await db.query(`
      UPDATE answers SET
        status = $1, score = $2,
        ai_feedback = $3, ai_teacher_note = $4
      WHERE id = $5
    `, [result.status, result.score, result.feedbackForStudent, result.feedbackForTeacher, answerId]);

  } catch (err: any) {
    console.error('[ai-checker] Error:', err.message);
    // Fall back to mock result
    await db.query(
      'UPDATE answers SET status = $1, score = 0, ai_teacher_note = $2 WHERE id = $3',
      ['manual_required', `ИИ недоступен: ${err.message?.slice(0, 100)}`, answerId]
    );
  }
}
