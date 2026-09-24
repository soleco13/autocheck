import { Router } from 'express';
import { requireAuth } from '../middleware/auth-middleware';
import { getMontiMetrics, getMontiStatus, isMontiEnabled } from '../ddp/monti-client';
import { getOpenRouterClient } from '../lib/openrouter-client';
import { logger } from '../lib/logger';

const router = Router();
const REPORT_MODEL = process.env.AI_REPORT_MODEL || 'anthropic/claude-sonnet-5';
const COOLDOWN_MS = 10 * 60_000;
let lastReport = 0;

router.get('/status', requireAuth, (_req, res) => {
  res.json({ status: getMontiStatus(), metrics: getMontiMetrics(), enabled: isMontiEnabled() });
});

// ── OpenRouter balance ────────────────────────────────────────────────────
// Shown to every teacher in the header. Cached for 5 min so page loads don't hammer OpenRouter.
const BALANCE_TTL_MS = 5 * 60_000;
let balanceCache: { at: number; data: any } | null = null;

async function fetchOpenRouter(path: string, apiKey: string): Promise<any> {
  const r = await fetch(`https://openrouter.ai/api/v1${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`OpenRouter ${path} → HTTP ${r.status}`);
  return ((await r.json()) as any).data;
}

router.get('/balance', requireAuth, async (_req, res) => {
  if (balanceCache && Date.now() - balanceCache.at < BALANCE_TTL_MS)
    return res.json(balanceCache.data);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENROUTER_API_KEY не настроен' });

  try {
    const [credits, key] = await Promise.all([
      fetchOpenRouter('/credits', apiKey),
      fetchOpenRouter('/key', apiKey),
    ]);
    const balance = Math.max(0, credits.total_credits - credits.total_usage);
    const avgDaily = (key.usage_weekly ?? 0) / 7;
    const data = {
      balance,
      totalCredits: credits.total_credits,
      usageDaily:   key.usage_daily ?? 0,
      usageWeekly:  key.usage_weekly ?? 0,
      usageMonthly: key.usage_monthly ?? 0,
      avgDaily,
      daysLeft: avgDaily > 0 ? balance / avgDaily : null,
      updatedAt: new Date().toISOString(),
    };
    balanceCache = { at: Date.now(), data };
    res.json(data);
  } catch (err: any) {
    logger.warn({ err: err.message }, '[platform] OpenRouter balance fetch failed');
    // Serve stale data rather than nothing if we have it.
    if (balanceCache) return res.json({ ...balanceCache.data, stale: true });
    res.status(502).json({ error: 'Не удалось получить баланс OpenRouter' });
  }
});

router.post('/report', requireAuth, async (_req, res) => {
  if (!isMontiEnabled())
    return res.status(503).json({ error: 'Мониторинг платформы не настроен' });

  const wait = COOLDOWN_MS - (Date.now() - lastReport);
  if (wait > 0)
    return res.status(429).json({ error: `Следующий отчёт через ${Math.ceil(wait / 60_000)} мин.`, waitMs: wait });

  const metrics = getMontiMetrics();
  const status  = getMontiStatus();
  const rt = metrics.responseTime;

  const fmtTS = (arr: any[], keys: string[]) =>
    arr.slice(-10).map(p => {
      const t = new Date(p.ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      return `${t}: ${keys.map(k => `${k}=${typeof p[k] === 'number' ? p[k].toFixed(0) : '-'}ms`).join(', ')}`;
    }).join('\n');

  const prompt = `Ты аналитик производительности платформы good-teach.itgen.io. Напиши один короткий абзац (3-5 предложений) на русском языке без форматирования, заголовков, звёздочек и специальных символов. Опиши текущее состояние платформы, укажи что именно выходит за норму с конкретными цифрами, назови вероятную причину и дай одну практическую рекомендацию.

Статус: ${status}. Время: ${new Date(metrics.updatedAt).toLocaleTimeString('ru-RU')}.
DB: ${rt.db.toFixed(0)}ms, async: ${rt.async.toFixed(0)}ms, compute: ${rt.compute.toFixed(0)}ms, wait: ${rt.wait.toFixed(0)}ms, итого: ${rt.total.toFixed(0)}ms.
Ошибки: ${metrics.errorRate.toFixed(2)}%, throughput: ${metrics.throughput.toFixed(0)} rpm, данные из БД: ${metrics.fetchedDocKb.toFixed(0)} KB/запрос.
Норма: db < 200ms, ошибки < 1%. Выше 500ms db или выше 5% ошибок — критично.

${fmtTS(metrics.timeseries.responseTime, ['db', 'async'])}`;

  try {
    lastReport = Date.now();
    const client = getOpenRouterClient();
    const response = await client.chat.completions.create({
      model: REPORT_MODEL,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.choices[0]?.message?.content ?? '';
    res.json({ report: text, status, metrics, generatedAt: new Date().toISOString() });
  } catch (err: any) {
    lastReport = 0;
    logger.error({ err }, '[platform] AI report failed');
    res.status(500).json({ error: 'Не удалось сгенерировать отчёт' });
  }
});

export default router;
