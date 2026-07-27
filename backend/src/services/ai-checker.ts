import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';
import { db } from '../db';
import { aiThrottle } from '../lib/ai-throttle';
import { DEFAULT_PROMPTS } from '../api/settings';
import { configStore } from '../lib/config-store';
import { retrieveChunks, checkRagAvailability, checkRagStatus } from './rag-retriever';

const CHECKER_MODEL  = process.env.AI_CHECKER_MODEL  || 'claude-haiku-4-5-20251001';
const FALLBACK_MODEL = process.env.AI_FALLBACK_MODEL || 'claude-sonnet-4-6';

// ── Claude circuit breaker ────────────────────────────────────────────────────
// After 2 consecutive transient failures, skip Claude for 5 min and go
// directly to GPT. Prevents wasting 0.5–2 s per answer waiting for Anthropic
// to respond with 400/5xx when it's clearly unavailable.
const CIRCUIT_FAIL_THRESHOLD = 2;
const CIRCUIT_OPEN_DURATION_MS = 5 * 60_000;
let circuitFailures = 0;
let circuitOpenUntil = 0;

export function isCircuitOpen(): boolean {
  if (Date.now() < circuitOpenUntil) return true;
  if (circuitOpenUntil > 0) { circuitOpenUntil = 0; circuitFailures = 0; } // half-open reset
  return false;
}
function onClaudeSuccess(): void { circuitFailures = 0; circuitOpenUntil = 0; }
function onClaudeFailure(): void {
  circuitFailures++;
  // Log only on the exact threshold — parallel jobs can all fail at once, we
  // don't want N identical "circuit OPEN" lines per wave of concurrent requests.
  if (circuitFailures === CIRCUIT_FAIL_THRESHOLD) {
    console.warn('[ai-checker] Claude circuit OPEN — routing to GPT for 5 min');
  }
  if (circuitFailures >= CIRCUIT_FAIL_THRESHOLD) {
    circuitOpenUntil = Date.now() + CIRCUIT_OPEN_DURATION_MS;
  }
}

// ── Per-teacher prompt cache (Redis-backed) ───────────────────────────────────
// Loads customised prompts from ai_prompts table. TTL=5min so UI changes
// propagate quickly without hammering the DB on every AI call.
// Redis ensures cache survives restarts and is shared across HTTP + worker processes.
const PROMPT_CACHE_TTL_S = 5 * 60;

export async function getTeacherPrompt(teacherId: string | null, key: string): Promise<string> {
  const { cacheGet, cacheSet } = await import('../lib/redis-cache');
  const fallback = DEFAULT_PROMPTS[key] ?? '';
  if (!teacherId) return fallback;

  const redisKey = `prompt:${teacherId}:${key}`;
  const hit = await cacheGet<string>(redisKey);
  if (hit !== null) return hit;

  try {
    const r = await db.query(
      'SELECT prompt_text FROM ai_prompts WHERE teacher_id = $1 AND prompt_key = $2 LIMIT 1',
      [teacherId, key],
    );
    const text = r.rows[0]?.prompt_text || fallback;
    await cacheSet(redisKey, text, PROMPT_CACHE_TTL_S);
    return text;
  } catch {
    return fallback;
  }
}

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

// ── GPT fallback ─────────────────────────────────────────────────────────────
// Used when claude-haiku-4.5 is unavailable (Anthropic outage / 5xx / overload).
// Calls the proxy's OpenAI-compatible endpoint which routes to gpt-5.4.
function isTransientError(err: any): boolean {
  if (typeof err?.status === 'number' && (err.status >= 500 || err.status === 429)) return true;
  // ClaudeHub returns 400 "Model not found" when Claude models aren't available on the plan.
  // Some aggregators return 400 "Invalid request parameters" instead of 429 when rate-limited.
  if (err?.status === 400) {
    const body = String(err?.message ?? '').toLowerCase();
    if (body.includes('model not found') || body.includes('model_not_found') ||
        body.includes('invalid request parameters')) return true;
  }
  const msg = String(err?.message ?? '').toLowerCase();
  return msg.includes('overload') || msg.includes('timeout') ||
         msg.includes('econnreset') || msg.includes('fetch failed') ||
         msg.includes('503') || msg.includes('529');
}

// Proxy returns extended-thinking responses with [thinking, text] blocks.
// Always find the first 'text' block instead of assuming content[0] is text.
function extractTextBlock(content: Anthropic.ContentBlock[]): string {
  for (const block of content) {
    if (block.type === 'text' && block.text) return block.text;
  }
  return '';
}

// Robust JSON extractor: strips markdown fences, finds the first valid JSON opener.
// Works with thinking-mode responses (which wrap JSON in ```json blocks or add prose).
function extractJSON(raw: string, opener: '{' | '['): string {
  // 1. Strip markdown code fences
  const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  // 2. Find first opener followed by valid JSON-start character
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] !== opener) continue;
    const next = clean.slice(i + 1).trimStart()[0] ?? '';
    const ok = opener === '{'
      ? next === '"' || next === '}'                       // object key or empty object
      : next === '{' || next === '"' || next === ']';      // array items or empty array
    if (ok) return clean.slice(i);
  }
  return clean;
}

export async function callGPTFallback(userPrompt: string, systemPrompt: string, maxTokens: number): Promise<string> {
  const client = getClient();
  const response = await client.messages.create({
    model: FALLBACK_MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  return extractTextBlock(response.content);
}

async function callAIGetText(
  userPrompt: string,
  systemPrompt: string,
  maxTokens: number,
  client: Anthropic,
): Promise<{ text: string; usage: { input_tokens: number; output_tokens: number } }> {
  if (!isCircuitOpen()) {
    try {
      const response = await client.messages.create({
        model: CHECKER_MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      onClaudeSuccess();
      return {
        text: extractTextBlock(response.content),
        usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
      };
    } catch (err: any) {
      if (!isTransientError(err)) throw err;
      onClaudeFailure();
      console.warn(`[ai-checker] Claude unavailable (${err.message?.slice(0, 60)}), using fallback`);
    }
  }
  const text = await callGPTFallback(userPrompt, systemPrompt, maxTokens);
  return { text, usage: { input_tokens: 0, output_tokens: 0 } };
}

// ── Answer-level AI cache ─────────────────────────────────────────────────────
// Cache key = SHA256(questionText + sortedAcceptable + studentAnswer + topic)
// When multiple students submit the same answer to the same question, AI is only
// called once. Cache TTL = 30 days (enforced via index, not hard delete here).
function buildCacheKey(ctx: AICheckContext): string {
  const raw = [
    ctx.questionText.trim(),
    [...ctx.acceptable].sort().join('|'),
    ctx.answerKey.trim(),
    ctx.studentAnswer.trim(),
    ctx.topic,
    // Include rag_mode so cache from AI-only mode isn't served in RAG mode and vice-versa
    String(configStore.get('rag_mode')),
  ].join('\x00');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function getCached(key: string): Promise<CheckResultWithUsage | null> {
  try {
    const r = await db.query(
      `UPDATE ai_check_cache
       SET hit_count = hit_count + 1, last_hit_at = NOW()
       WHERE cache_key = $1
         AND created_at > NOW() - INTERVAL '30 days'
       RETURNING status, score, feedback_student, feedback_teacher`,
      [key],
    );
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return {
      status: row.status as CheckResult['status'],
      score: row.score,
      maxScore: 1,
      feedbackForStudent: row.feedback_student,
      feedbackForTeacher: row.feedback_teacher,
      usage: { input_tokens: 0, output_tokens: 0 }, // cached — no tokens spent
    };
  } catch { return null; }
}

async function setCached(key: string, result: CheckResultWithUsage): Promise<void> {
  try {
    await db.query(
      `INSERT INTO ai_check_cache (cache_key, status, score, feedback_student, feedback_teacher, model)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (cache_key) DO NOTHING`,
      [key, result.status, result.score, result.feedbackForStudent, result.feedbackForTeacher, CHECKER_MODEL],
    );
  } catch { /* best-effort */ }
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

interface CheckResultWithUsage extends CheckResult {
  usage: { input_tokens: number; output_tokens: number };
}

// Специальные ошибки RAG — не технические сбои, обрабатываются отдельно.
export class RagTextbookNotFoundError extends Error {
  constructor(subjectCode: string, grade: string | number) {
    const subj = subjectCode && subjectCode !== 'XX' ? `«${subjectCode}»` : 'этого предмета';
    const gradeStr = Number(grade) > 0 ? `, ${grade} класс` : '';
    super(`Учебник не найден: загрузите учебник по предмету ${subj}${gradeStr} на странице «Учебники», либо переключите режим проверки на «ИИ» в Системных параметрах.`);
    this.name = 'RagTextbookNotFoundError';
  }
}

export class RagTextbookProcessingError extends Error {
  constructor(subjectCode: string, grade: string | number) {
    const subj = subjectCode && subjectCode !== 'XX' ? `«${subjectCode}»` : 'этого предмета';
    const gradeStr = Number(grade) > 0 ? `, ${grade} класс` : '';
    super(`Учебник по предмету ${subj}${gradeStr} ещё обрабатывается. Дождитесь завершения индексирования на странице «Учебники» и повторите проверку.`);
    this.name = 'RagTextbookProcessingError';
  }
}

async function buildRagSection(ctx: AICheckContext, teacherId?: string): Promise<string> {
  if (configStore.get('rag_mode') !== 1 || !teacherId) return '';

  // Быстрая проверка статуса перед поиском чанков
  const ragStatus = await checkRagStatus(
    teacherId,
    ctx.subjectCode || null,
    ctx.grade > 0 ? String(ctx.grade) : null,
  );
  if (ragStatus === 'processing') throw new RagTextbookProcessingError(ctx.subjectCode, ctx.grade);
  if (ragStatus === 'none') throw new RagTextbookNotFoundError(ctx.subjectCode, ctx.grade);

  const topK = configStore.get('rag_top_k') || 5;
  // Strip standalone multi-digit numbers (e.g. "579 710 741 198") before FTS —
  // they force AND-matching in tsquery but never appear in textbook text, killing results.
  const rawQuery = `${ctx.questionText} ${ctx.studentAnswer}`;
  const query = rawQuery.replace(/\b\d{3,}\b/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 2000) || rawQuery.slice(0, 500);
  try {
    const chunks = await retrieveChunks({
      query,
      teacherId,
      subjectCode: ctx.subjectCode || null,
      grade: ctx.grade > 0 ? String(ctx.grade) : null,
      topK,
    });
    if (chunks.length === 0) {
      // Textbook is ready but no relevant passages found — proceed without RAG context
      // rather than misleading the user with "textbook not found".
      console.warn(`[ai-checker] RAG: textbook ready but 0 chunks matched query for ${ctx.subjectCode}/${ctx.grade}`);
      return '';
    }
    const material = chunks.map(c => c.content).join('\n---\n');
    return `\n\nМатериал из учебника (используй ТОЛЬКО эту информацию для проверки ответа ученика):\n${material}\n\nВАЖНО: При объяснении ошибок или правильности ответа ОБЯЗАТЕЛЬНО ссылайся на конкретные правила, примеры или формулировки из приведённого материала учебника. Указывай цитаты в кавычках.`;
  } catch (err: any) {
    if (err instanceof RagTextbookNotFoundError) throw err;
    console.warn(`[ai-checker] RAG retrieval failed: ${err.message}`);
    return '';
  }
}

async function checkWithAI(ctx: AICheckContext, teacherId?: string): Promise<CheckResultWithUsage> {
  const cacheKey = buildCacheKey(ctx);
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const client = getClient();
  const [systemPromptBase, ragSection] = await Promise.all([
    getTeacherPrompt(teacherId ?? null, 'checker_system'),
    buildRagSection(ctx, teacherId),
  ]);
  const systemPrompt = systemPromptBase + ragSection;

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

  // Throttle before calling AI — prevents 429 cascade under bulk load
  await aiThrottle.acquire();
  const userPromptText = lines.join('\n');
  // max_tokens must be large enough to cover thinking tokens (~500–1000) + JSON response (~300)
  const { text, usage } = await callAIGetText(userPromptText, systemPrompt, 2048, client);
  let parsed: any;
  try {
    parsed = JSON.parse(extractJSON(text, '{'));
  } catch {
    // AI returned non-JSON — retry once via fallback model
    const gptText = await callGPTFallback(userPromptText, systemPrompt, 2048);
    parsed = JSON.parse(extractJSON(gptText, '{'));
  }

  let result: CheckResultWithUsage;
  if (hasReference) {
    const isCorrect: boolean = parsed.correct === true;
    result = {
      status: isCorrect ? 'correct' : 'incorrect',
      score: isCorrect ? 1 : 0,
      maxScore: 1,
      feedbackForStudent: parsed.feedback_student || (isCorrect ? 'Верно!' : 'Неверно.'),
      feedbackForTeacher: parsed.feedback_teacher || '',
      usage,
    };
  } else {
    const scoreRaw: number = typeof parsed.score === 'number' ? parsed.score : 0;
    const score = Math.round(scoreRaw);
    result = {
      status: scoreRaw >= 0.8 ? 'correct' : scoreRaw >= 0.4 ? 'partial' : 'incorrect',
      score,
      maxScore: 1,
      feedbackForStudent: parsed.feedback_student || '',
      feedbackForTeacher: parsed.feedback_teacher || '',
      usage,
    };
  }

  // Store in cache for future identical answers (fire-and-forget)
  setCached(cacheKey, result).catch(() => {});
  return result;
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
    let questionText = answer.question_text || slideProblem || '';
    const partIndex: number | undefined = structured?._partIndex;
    const totalParts: number | undefined = structured?._totalParts;
    if (partIndex && totalParts && totalParts > 1) {
      questionText = `[Составное задание: ответ на часть ${partIndex} из ${totalParts}]\n${questionText}`;
    }
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
    }, answer.teacher_id);

    // Log token usage — usage is returned directly from checkWithAI (no race condition)
    db.query(
      `INSERT INTO ai_call_log (answer_id, teacher_id, model, prompt_tokens, completion_tokens)
       VALUES ($1, $2, $3, $4, $5)`,
      [answerId, answer.teacher_id, CHECKER_MODEL, result.usage.input_tokens, result.usage.output_tokens]
    ).catch(() => {});

    await db.query(`
      UPDATE answers SET
        status = $1, score = $2,
        ai_feedback = $3, ai_teacher_note = $4
      WHERE id = $5
    `, [result.status, result.score, result.feedbackForStudent, result.feedbackForTeacher, answerId]);

  } catch (err: any) {
    // Учебник не найден — не технический сбой, сразу ставим manual_required с ясным сообщением.
    if (err instanceof RagTextbookNotFoundError || err instanceof RagTextbookProcessingError) {
      console.warn(`[ai-checker] RAG blocked answer ${answerId}: ${err.message}`);
      await db.query(
        `UPDATE answers
         SET status          = 'manual_required',
             score           = 0,
             ai_feedback     = $2,
             ai_teacher_note = $2
         WHERE id = $1`,
        [answerId, err.message],
      );
      return;
    }

    console.error('[ai-checker] Error:', err.message);
    // Don't overwrite a previously successful result — only set manual_required if answer has no usable status yet.
    await db.query(
      `UPDATE answers
       SET status        = CASE WHEN status IN ('correct','partial','incorrect') THEN status ELSE 'manual_required' END,
           score         = CASE WHEN status IN ('correct','partial','incorrect') THEN score  ELSE 0 END,
           ai_teacher_note = CASE
             WHEN ai_teacher_note IS NOT NULL
              AND ai_teacher_note != ''
              AND ai_teacher_note NOT LIKE 'ИИ недоступен%'
             THEN ai_teacher_note
             ELSE $2
           END
       WHERE id = $1`,
      [answerId, `ИИ недоступен: ${err.message?.slice(0, 100)}`]
    );
  }
}

// ── Batch checker: N answers → 1 API call ────────────────────────────────────
// Replaces the per-answer loop for open_answer tasks that need AI.
// Reduces API usage by ~BATCH_SIZE× compared to individual checkAnswer() calls.
// Falls back to individual checkAnswer() if the batch parse fails.
const BATCH_SIZE = 4;

interface BatchItem {
  answerId: string;
  ctx: AICheckContext;
  hasReference: boolean;
}

async function callBatchAI(items: BatchItem[], teacherId?: string | null): Promise<void> {
  const client = getClient();

  // RAG: получаем контекст из учебника для каждого задания батча ДО вызова ИИ.
  // Если RAG включён но учебника нет — throws RagTextbookNotFoundError до отправки промпта.
  const itemRagContext = new Map<string, string>(); // answerId → textbook excerpt
  if (configStore.get('rag_mode') === 1 && teacherId) {
    const firstCtx = items[0]?.ctx;
    const ragStatus = await checkRagStatus(
      teacherId,
      firstCtx?.subjectCode || null,
      firstCtx?.grade > 0 ? String(firstCtx.grade) : null,
    );
    if (ragStatus !== 'ready') {
      throw ragStatus === 'processing'
        ? new RagTextbookProcessingError(firstCtx?.subjectCode ?? '', firstCtx?.grade ?? 0)
        : new RagTextbookNotFoundError(firstCtx?.subjectCode ?? '', firstCtx?.grade ?? 0);
    }
    // Извлекаем релевантные чанки для каждого задания параллельно
    await Promise.all(items.map(async (item) => {
      const rawQ = `${item.ctx.questionText} ${item.ctx.studentAnswer}`;
      const query = (rawQ.replace(/\b\d{3,}\b/g, '').replace(/\s{2,}/g, ' ').trim() || rawQ).slice(0, 500);
      const chunks = await retrieveChunks({
        query,
        teacherId,
        subjectCode: item.ctx.subjectCode || null,
        grade: item.ctx.grade > 0 ? String(item.ctx.grade) : null,
        topK: configStore.get('rag_top_k') || 5,
      });
      if (chunks.length > 0) {
        itemRagContext.set(item.answerId, chunks.map(c => c.content).join('\n---\n'));
      }
    }));
  }

  const systemPromptBase = await getTeacherPrompt(teacherId ?? null, 'checker_system');
  const hasRag = itemRagContext.size > 0;
  const systemPrompt = hasRag
    ? systemPromptBase + '\n\nПри проверке используй ТОЛЬКО материал из учебника, предоставленный в каждом задании. Обязательно ссылайся на конкретные правила и цитаты из материала учебника в обратной связи.'
    : systemPromptBase;

  const blocks = items.map((item, i) => {
    const c = item.ctx;
    const gradeStr = c.grade > 0 ? `${c.grade} класс` : '';
    const subjectStr = c.subjectCode && c.subjectCode !== 'XX' ? c.subjectCode : '';
    const lines = [
      `[${i}] ${[subjectStr, gradeStr].filter(Boolean).join(', ')}`,
      `Задание: ${c.questionText || '(текст отсутствует)'}`,
    ];
    if (c.criteria) lines.push(`Критерии: ${c.criteria}`);
    // Инжектируем фрагмент учебника прямо в блок задания
    const ragExcerpt = itemRagContext.get(item.answerId);
    if (ragExcerpt) lines.push(`Материал из учебника:\n${ragExcerpt}`);
    if (item.hasReference) {
      const ref = c.acceptable.length > 0 ? c.acceptable.join(' / ') : c.answerKey;
      lines.push(`Правильный ответ: ${ref}`);
      lines.push(`Ответ ученика: ${c.studentAnswer || '(пусто)'}`);
      lines.push(`Формат ответа: {"i":${i},"correct":true/false,"feedback_student":"...","feedback_teacher":"..."}`);
    } else {
      lines.push(`Ответ ученика: ${c.studentAnswer || '(пусто)'}`);
      lines.push(`Формат ответа: {"i":${i},"score":0-1,"feedback_student":"...","feedback_teacher":"..."}`);
    }
    return lines.join('\n');
  });

  const userPrompt = `Проверь ${items.length} заданий. Верни ТОЛЬКО JSON-массив, без текста до или после него.\n\n${blocks.join('\n\n')}`;
  // Each item needs ~300 tokens for JSON + ~800 thinking overhead
  const batchMaxTokens = Math.max(2048, 800 * items.length);

  await aiThrottle.acquire();
  let parsed: any[];

  // Phase 1: call AI — only true API-level failures are handled here (mark manual_required + return).
  // Parse errors are NOT caught here; they propagate to Phase 2 so checkAnswersBatch can fall back
  // to individual checkAnswer() calls, which use a different (object) prompt format that usually works.
  let claudeText = '';
  let batchUsage = { input_tokens: 0, output_tokens: 0 };
  try {
    const r = await callAIGetText(userPrompt, systemPrompt, batchMaxTokens, client);
    claudeText = r.text;
    batchUsage = r.usage;
  } catch (err: any) {
    if (err instanceof RagTextbookNotFoundError || err instanceof RagTextbookProcessingError) {
      console.warn('[batch-checker] RAG blocked batch:', err.message);
      for (const item of items) {
        await db.query(
          `UPDATE answers SET status='manual_required', score=0, ai_feedback=$2, ai_teacher_note=$2 WHERE id=$1`,
          [item.answerId, err.message],
        ).catch(() => {});
      }
      return;
    }
    // API truly down — individual checkAnswer() would also fail, so mark here and return.
    console.error('[batch-checker] API unavailable, marking answers for retry:', err.message);
    const apiErrMsg = `ИИ-сервис временно недоступен (${err.message?.slice(0, 120)}). Запустите проверку повторно позже.`;
    for (const item of items) {
      await db.query(
        `UPDATE answers SET status='manual_required', ai_feedback=$2, ai_teacher_note=$2 WHERE id=$1`,
        [item.answerId, apiErrMsg],
      ).catch(() => {});
    }
    return;
  }

  // Phase 2: parse — failures propagate to checkAnswersBatch → individual checkAnswer() fallback.
  // Individual checking uses {"correct":...} object format which succeeds even when array format fails.
  try {
    parsed = JSON.parse(extractJSON(claudeText, '['));
    if (!Array.isArray(parsed)) throw new Error('not an array');
  } catch (parseErr: any) {
    console.warn(`[batch-checker] Claude parse failed (${parseErr.message}), trying fallback model`);
    const gptText = await callGPTFallback(userPrompt, systemPrompt, batchMaxTokens);
    parsed = JSON.parse(extractJSON(gptText, '['));
    if (!Array.isArray(parsed)) throw new Error('fallback response not an array');
  }

  // Log aggregated usage for first item's teacher (best-effort, skip for GPT fallback where tokens=0)
  const firstItem = items[0];
  if (firstItem && batchUsage.input_tokens > 0) {
    const teacherRow = await db.query(
      'SELECT teacher_id FROM answers a JOIN student_sessions ss ON ss.id = a.session_id WHERE a.id = $1',
      [firstItem.answerId],
    );
    const tid = teacherRow.rows[0]?.teacher_id;
    if (tid) {
      db.query(
        `INSERT INTO ai_call_log (teacher_id, model, prompt_tokens, completion_tokens)
         VALUES ($1, $2, $3, $4)`,
        [tid, CHECKER_MODEL, batchUsage.input_tokens, batchUsage.output_tokens],
      ).catch(() => {});
    }
  }

  // Apply results and populate cache
  const updatePromises: Promise<any>[] = [];
  for (const obj of parsed) {
    const idx = typeof obj.i === 'number' ? obj.i : -1;
    if (idx < 0 || idx >= items.length) continue;
    const item = items[idx];
    const hasRef = item.hasReference;
    let result: CheckResultWithUsage;
    if (hasRef) {
      const isCorrect = obj.correct === true;
      result = {
        status: isCorrect ? 'correct' : 'incorrect',
        score: isCorrect ? 1 : 0, maxScore: 1,
        feedbackForStudent: obj.feedback_student || (isCorrect ? 'Верно!' : 'Неверно.'),
        feedbackForTeacher: obj.feedback_teacher || '',
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    } else {
      const scoreRaw = typeof obj.score === 'number' ? obj.score : 0;
      result = {
        status: scoreRaw >= 0.8 ? 'correct' : scoreRaw >= 0.4 ? 'partial' : 'incorrect',
        score: Math.round(scoreRaw), maxScore: 1,
        feedbackForStudent: obj.feedback_student || '',
        feedbackForTeacher: obj.feedback_teacher || '',
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }
    setCached(buildCacheKey(item.ctx), result).catch(() => {});
    updatePromises.push(
      db.query(
        'UPDATE answers SET status=$1, score=$2, ai_feedback=$3, ai_teacher_note=$4 WHERE id=$5',
        [result.status, result.score, result.feedbackForStudent, result.feedbackForTeacher, item.answerId],
      ),
    );
  }
  await Promise.all(updatePromises);
}

// Public entry point: checks all open_answer items for a session using batch API.
// Deterministic/structured tasks (quiz, matches, fill_blanks) are handled by the
// existing checkAnswer() path which doesn't call the AI.
export async function checkAnswersBatch(
  sessionId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const result = await db.query(
    `SELECT a.id, t.task_type, a.student_answer, a.student_answer_structured,
            t.question_text, t.reference_answer, t.max_score as task_max_score,
            cs.grade, cs.subject_code, cs.topic, ss.teacher_id
     FROM answers a
     JOIN tasks t ON t.id = a.task_id
     JOIN control_sheets cs ON cs.id = t.control_sheet_id
     JOIN student_sessions ss ON ss.id = a.session_id
     WHERE a.session_id = $1
     ORDER BY t.task_index`,
    [sessionId],
  );

  const total = result.rows.length;
  let done = 0;
  const progress = () => { onProgress?.(++done, total); };

  // teacherId from first row — all answers in a session belong to the same teacher
  const teacherId: string | null = result.rows[0]?.teacher_id ?? null;

  // RAG: ранняя проверка ДО любых AI-вызовов и cache-хитов.
  // Различаем: учебника нет совсем vs учебник ещё индексируется.
  if (configStore.get('rag_mode') === 1 && teacherId) {
    const firstRow = result.rows[0];
    const ragStatus = await checkRagStatus(
      teacherId,
      firstRow?.subject_code || null,
      firstRow?.grade > 0 ? String(firstRow.grade) : null,
    );
    if (ragStatus !== 'ready') {
      const ragErr = ragStatus === 'processing'
        ? new RagTextbookProcessingError(firstRow?.subject_code ?? '', firstRow?.grade ?? 0)
        : new RagTextbookNotFoundError(firstRow?.subject_code ?? '', firstRow?.grade ?? 0);
      for (const row of result.rows) {
        await db.query(
          `UPDATE answers SET status='manual_required', score=0, ai_feedback=$2, ai_teacher_note=$2 WHERE id=$1`,
          [row.id, ragErr.message],
        ).catch(() => {});
      }
      console.warn(`[batch-checker] RAG ${ragStatus} for session ${sessionId}: ${ragErr.message}`);
      return;
    }
  }

  const aiItems: BatchItem[] = [];

  for (const answer of result.rows) {
    // Structured types: delegate to individual checkAnswer (deterministic, no AI)
    if (['matches', 'quiz', 'fill_blanks'].includes(answer.task_type)) {
      await checkAnswer(answer.id).catch(() => {}); progress(); continue;
    }

    const studentAnswer = answer.student_answer || '';
    if (!studentAnswer && !answer.student_answer_structured) {
      await db.query(
        'UPDATE answers SET status=$1, score=0, ai_feedback=$2 WHERE id=$3',
        ['incorrect', 'Ответ не заполнен.', answer.id],
      );
      progress(); continue;
    }

    const raw = answer.student_answer_structured;
    const structured: any = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    const acceptable: string[] = Array.isArray(structured?._acceptableAnswers)
      ? structured._acceptableAnswers
      : (answer.reference_answer ? [answer.reference_answer] : []);
    const answerKey: string = structured?._answerKey || '';
    const criteria: string = structured?._criteria || '';
    let questionText = answer.question_text || structured?._slideProblem || '';
    const partIndex: number | undefined = structured?._partIndex;
    const totalParts: number | undefined = structured?._totalParts;
    if (partIndex && totalParts && totalParts > 1) {
      questionText = `[Составное задание: ответ на часть ${partIndex} из ${totalParts}]\n${questionText}`;
    }

    // Deterministic shortcut (no API call)
    if (acceptable.length > 0 && deterministicMatch(studentAnswer, acceptable)) {
      await db.query(
        'UPDATE answers SET status=$1, score=1, ai_feedback=$2, ai_teacher_note=$3 WHERE id=$4',
        ['correct', 'Верно! Ответ совпадает с правильным.', `Ответ «${studentAnswer}» совпадает с эталоном.`, answer.id],
      );
      progress(); continue;
    }

    // Syntactic hint check
    if (!acceptable.length && !answerKey && questionText) {
      const syntactic = checkHintSyntactically(questionText, studentAnswer);
      if (syntactic !== null) {
        await db.query(
          'UPDATE answers SET status=$1, score=$2, ai_feedback=$3 WHERE id=$4',
          [syntactic ? 'correct' : 'incorrect', syntactic ? 1 : 0,
           syntactic ? 'Соответствует критерию задания.' : 'Не соответствует критерию задания.', answer.id],
        );
        progress(); continue;
      }
    }

    const ctx: AICheckContext = {
      taskType: answer.task_type,
      questionText,
      acceptable,
      answerKey,
      criteria,
      studentAnswer,
      grade: answer.grade,
      subjectCode: answer.subject_code,
      topic: answer.topic || '',
    };

    // Cache hit — no API call needed.
    // В RAG-режиме кэш включает rag_mode в ключ, поэтому попаданий из AI-режима не будет.
    const cacheKey = buildCacheKey(ctx);
    const cached = await getCached(cacheKey);
    if (cached) {
      await db.query(
        'UPDATE answers SET status=$1, score=$2, ai_feedback=$3, ai_teacher_note=$4 WHERE id=$5',
        [cached.status, cached.score, cached.feedbackForStudent, cached.feedbackForTeacher, answer.id],
      );
      progress(); continue;
    }

    aiItems.push({ answerId: answer.id, ctx, hasReference: acceptable.length > 0 || answerKey.trim() !== '' });
  }

  if (aiItems.length === 0) return;

  // Chunk into batches of BATCH_SIZE → 1 API call per batch
  for (let i = 0; i < aiItems.length; i += BATCH_SIZE) {
    const batch = aiItems.slice(i, i + BATCH_SIZE);
    try {
      await callBatchAI(batch, teacherId);
      for (const _ of batch) progress();
    } catch (err: any) {
      console.error('[batch-checker] Batch failed, individual fallback:', err.message);
      for (const item of batch) {
        await checkAnswer(item.answerId).catch(() => {}); progress();
      }
    }
  }
}
