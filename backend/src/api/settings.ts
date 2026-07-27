import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth-middleware';
import { safeError } from '../lib/safe-error';
import { db } from '../db';
import { configStore, PARAM_META } from '../lib/config-store';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { cacheDel } from '../lib/redis-cache';

const router = Router();

export const DEFAULT_PROMPTS: Record<string, string> = {
  checker_system:
`Ты — ИИ-проверщик контрольных и домашних работ российской онлайн-школы good-teach.

Проверяй ответ ученика, опираясь ТОЛЬКО на данные тебе условие задания, критерии оценивания и эталонный ответ. Никогда не выдумывай условие и не пиши, что контекст отсутствует — если он есть в запросе, используй его.

Правила:
• Числовые ответы: считай верными разные формы одного числа (1530, «1530 км», «1 530», «1530,0» — всё верно)
• Текстовые ответы: принимай синонимы и перефразировки, если смысл точно совпадает
• Орфографические ошибки НЕ влияют на правильность, если смысл понятен
• Частично правильный ответ (верный ход, неверный итог) → score 0.5

Отвечай ТОЛЬКО валидным JSON без markdown-блоков и пояснений.`,

  report_student:
`Ты — доброжелательный учитель российской школы. Напиши ученику короткий комментарий (2–3 предложения) по итогам работы.

Тон: поддерживающий и конкретный. Отметь что получилось хорошо и над чем стоит поработать. Обращайся на «ты». Язык — русский.`,

  report_teacher:
`Ты — методист, пишущий профессиональную сводку для учителя по работе ученика (2–3 предложения).

Укажи: типичные ошибки, слабые темы, конкретные рекомендации. Стиль — деловой и конкретный, без общих фраз. Язык — русский.`,
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
      await db.query('DELETE FROM ai_prompts WHERE teacher_id = $1 AND prompt_key = $2', [req.teacherId, key]);
    } else {
      await db.query(`
        INSERT INTO ai_prompts (teacher_id, prompt_key, prompt_text, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (teacher_id, prompt_key)
        DO UPDATE SET prompt_text = EXCLUDED.prompt_text, updated_at = NOW()
      `, [req.teacherId, key, text.trim()]);
    }
    // Invalidate prompt cache in Redis so AI calls pick up the change immediately
    await cacheDel(`prompt:${req.teacherId}:${key}`);
    audit({ teacherId: req.teacherId!, action: 'prompt_changed', entityType: 'prompt', entityId: key });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/settings/system — all system parameters with current values
router.get('/system', requireAuth, async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ params: configStore.all() });
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/settings/system — update one parameter
const systemUpdateSchema = z.object({
  key:   z.string().min(1).max(80),
  value: z.number().int(),
});

router.post('/system', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = systemUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
    return;
  }
  const { key, value } = parsed.data;
  if (!PARAM_META[key]) {
    res.status(400).json({ error: 'Unknown parameter' });
    return;
  }
  try {
    await configStore.set(key, value);
    res.json({ ok: true, key, value: configStore.get(key) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/settings/system/reset — reset one parameter to default
router.post('/system/reset', requireAuth, async (req: AuthRequest, res: Response) => {
  const { key } = req.body;
  if (!key || !PARAM_META[key]) {
    res.status(400).json({ error: 'Unknown parameter' });
    return;
  }
  try {
    await configStore.reset(key);
    res.json({ ok: true, key, value: configStore.get(key) });
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

export default router;
