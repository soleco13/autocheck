import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth-middleware';
import { safeError } from '../lib/safe-error';
import { db } from '../db';

const router = Router();

const DEFAULT_PROMPTS: Record<string, string> = {
  checker_system: `Ты — ИИ-проверщик контрольных и домашних работ для онлайн-школы. Ты проверяешь ответ ученика, ОПИРАЯСЬ на условие задания, критерии и эталонный ответ, которые тебе даны. Не выдумывай условие и не пиши, что контекста не хватает, если он приведён ниже. Отвечай ТОЛЬКО валидным JSON без markdown.`,
  report_student: `Ты — учитель. Напиши краткий (2-3 предложения) комментарий ученику по результатам работы. Отвечай на русском языке, доброжелательно и конструктивно.`,
  report_teacher: `Сформируй краткую сводку для учителя по работе ученика. Укажи на слабые места. 2-3 предложения.`,
};

// GET /api/settings
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  res.json({ ok: true });
});

// GET /api/settings/ai-usage — per-teacher token usage stats
router.get('/ai-usage', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const monthResult = await db.query(`
      SELECT
        COALESCE(SUM(prompt_tokens), 0)::int      AS input_tokens,
        COALESCE(SUM(completion_tokens), 0)::int  AS output_tokens,
        COUNT(*)::int                              AS total_calls
      FROM ai_call_log
      WHERE teacher_id = $1
        AND created_at >= date_trunc('month', NOW())
    `, [req.teacherId]);

    const totalResult = await db.query(`
      SELECT
        COALESCE(SUM(prompt_tokens), 0)::int      AS input_tokens,
        COALESCE(SUM(completion_tokens), 0)::int  AS output_tokens,
        COUNT(*)::int                              AS total_calls
      FROM ai_call_log
      WHERE teacher_id = $1
    `, [req.teacherId]);

    const month = monthResult.rows[0];
    const total = totalResult.rows[0];

    res.json({
      month: {
        inputTokens: parseInt(month.input_tokens) || 0,
        outputTokens: parseInt(month.output_tokens) || 0,
        totalCalls: parseInt(month.total_calls) || 0,
      },
      total: {
        inputTokens: parseInt(total.input_tokens) || 0,
        outputTokens: parseInt(total.output_tokens) || 0,
        totalCalls: parseInt(total.total_calls) || 0,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/settings/ai-prompts — get all prompts (with defaults fallback)
router.get('/ai-prompts', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      'SELECT prompt_key, prompt_text FROM ai_prompts WHERE teacher_id = $1',
      [req.teacherId]
    );
    const saved: Record<string, string> = {};
    for (const row of result.rows) {
      saved[row.prompt_key] = row.prompt_text;
    }
    // Merge with defaults
    const prompts: Record<string, string> = {};
    for (const key of Object.keys(DEFAULT_PROMPTS)) {
      prompts[key] = saved[key] ?? DEFAULT_PROMPTS[key];
    }
    res.json({ prompts, defaults: DEFAULT_PROMPTS });
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/settings/ai-prompts — save one or more prompts
router.post('/ai-prompts', requireAuth, async (req: AuthRequest, res: Response) => {
  const { key, text } = req.body;
  if (!key || typeof key !== 'string' || !Object.keys(DEFAULT_PROMPTS).includes(key)) {
    res.status(400).json({ error: 'Invalid prompt key' });
    return;
  }
  if (typeof text !== 'string') {
    res.status(400).json({ error: 'text required' });
    return;
  }
  try {
    if (!text.trim()) {
      // Reset to default — delete custom entry
      await db.query(
        'DELETE FROM ai_prompts WHERE teacher_id = $1 AND prompt_key = $2',
        [req.teacherId, key]
      );
    } else {
      await db.query(`
        INSERT INTO ai_prompts (teacher_id, prompt_key, prompt_text, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (teacher_id, prompt_key)
        DO UPDATE SET prompt_text = EXCLUDED.prompt_text, updated_at = NOW()
      `, [req.teacherId, key, text.trim()]);
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

export default router;
