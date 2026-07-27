import 'reflect-metadata';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import timeout from 'connect-timeout';
import pinoHttp from 'pino-http';
import dotenv from 'dotenv';

dotenv.config();

// ── Validate required secrets at startup ──────────────────────────────────
const REQUIRED_ENV = ['JWT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key] || process.env[key] === 'fallback_secret') {
    console.error(`❌ Required env var ${key} is missing or placeholder. Refusing to start.`);
    process.exit(1);
  }
}
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
  console.warn('⚠️  NODE_ENV not set — defaulted to production');
}

import { logger } from './lib/logger';

// ── Unhandled rejection / exception handlers ──────────────────────────────
process.on('unhandledRejection', (reason: any) => {
  const msg = reason?.message || String(reason);
  if (!msg.includes('ECONNREFUSED') && !msg.includes('reconnect')) {
    logger.error({ err: reason }, '[UnhandledRejection]');
  }
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, '[UncaughtException]');
  process.exit(1);
});

import { testConnection } from './db';
import { runMigrations } from './db/migrate-runner';
import { initDDPConnections } from './ddp/connection-pool';
import authRouter from './api/auth';
import studentsRouter from './api/students';
import checksRouter from './api/checks';
import reportsRouter from './api/reports';
import textbooksRouter from './api/textbooks';
import materialsRouter from './api/materials';
import debugRouter from './api/debug';
import settingsRouter from './api/settings';
import eventsRouter from './api/events';
import platformRouter from './api/platform';
import { requireAuth } from './middleware/auth-middleware';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const IS_PROD = process.env.NODE_ENV === 'production';

// ── Security ────────────────────────────────────────────────────────────────
app.use(helmet({
  // CSP: tighten in production; allow inline scripts for Vite dev
  contentSecurityPolicy: IS_PROD ? {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      styleSrc:       ["'self'", "'unsafe-inline'"],  // needed for CSS-in-JS
      imgSrc:         ["'self'", 'data:', 'blob:'],
      connectSrc:     ["'self'"],
      fontSrc:        ["'self'", 'data:'],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
    },
  } : false,
  // HSTS: only on production HTTPS
  hsts: IS_PROD ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  // Prevent MIME sniffing
  noSniff: true,
  // Disable X-Powered-By
  hidePoweredBy: true,
}));
app.use(cors({ origin: FRONTEND_URL, credentials: true }));

// ── Compression ──────────────────────────────────────────────────────────────
// Skip SSE connections: compression buffers chunks until flush, which prevents
// server-sent events from being streamed to the client in real time.
app.use(compression({
  filter: (req, res) => {
    if (req.headers.accept?.includes('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}));

// ── HTTP request logging ─────────────────────────────────────────────────────
app.use(pinoHttp({
  logger,
  customLogLevel: (_req, res) => res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  redact: ['req.headers.cookie', 'req.headers.authorization'],
  autoLogging: { ignore: (req) => req.url === '/api/health' },
}));

// ── Request timeouts ─────────────────────────────────────────────────────────
app.use('/api/textbooks/upload-pdf', timeout('180s')); // PDF parsing может занять до 2 мин
app.use('/api/students/:id/works', timeout('90s'));
app.use('/api/checks', timeout('90s'));
app.use(timeout('60s'));
function haltOnTimedout(req: Request, _res: Response, next: NextFunction) {
  if (!(req as any).timedout) next();
}
app.use(haltOnTimedout);

// ── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// ── Rate limiting ────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000, max: 10,
  message: { error: 'Слишком много попыток входа. Попробуйте через 15 минут.' },
  standardHeaders: true, legacyHeaders: false,
});

// Per-teacher rate limit (keyed by teacherId after auth, falls back to IP).
// 600/min per teacher allows bulk polling without hitting the wall:
// 10 teachers × 20 polls/min = 200/teacher — well within limit.
// IP-keyed fallback handles unauthenticated endpoints (/health, /auth/login).
const apiLimiter = rateLimit({
  windowMs: 60_000, max: 600,
  keyGenerator: (req) => (req as any).teacherId || req.ip || 'unknown',
  message: { error: 'Слишком много запросов. Подождите минуту.' },
  standardHeaders: true, legacyHeaders: false,
  skip: (req) => req.path === '/health',
});
app.use('/api/auth/login', loginLimiter);
app.use('/api', apiLimiter);

// ── Routes ───────────────────────────────────────────────────────────────────
// Debug router: disabled on production entirely
if (!IS_PROD) {
  app.use('/api/debug', requireAuth, debugRouter);
  logger.info('Debug router enabled (development only)');
}

app.use('/api/auth', authRouter);
app.use('/api/students', studentsRouter);
app.use('/api/checks', checksRouter);
app.use('/api/events', eventsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/textbooks', textbooksRouter);
app.use('/api/materials', materialsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/platform', platformRouter);

// ── Bull Board — queue/worker monitoring UI ──────────────────────────────────
// Mounted at /queues — accessible only to authenticated teachers.
// Lazy-loaded so it doesn't error on startup if Redis is unavailable.
{
  const BULL_BOARD_PATH = '/queues';
  app.use(BULL_BOARD_PATH, requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { createBullBoard } = await import('@bull-board/api');
      const { BullMQAdapter }   = await import('@bull-board/api/bullMQAdapter');
      const { ExpressAdapter }  = await import('@bull-board/express');
      const { getCheckQueue, getTextbookQueue, isRedisQueueCapable } = await import('./queue');

      if (!await isRedisQueueCapable()) {
        res.status(503).send('<h2>Bull Board недоступен — Redis не подключён (inline-режим)</h2>');
        return;
      }

      // Build the board once, cache it on app.locals to avoid re-creating on every request.
      if (!app.locals._bullBoardRouter) {
        const serverAdapter = new ExpressAdapter();
        serverAdapter.setBasePath(BULL_BOARD_PATH);
        createBullBoard({
          queues: [new BullMQAdapter(getCheckQueue()), new BullMQAdapter(getTextbookQueue())],
          serverAdapter,
        });
        app.locals._bullBoardRouter = serverAdapter.getRouter();
      }

      app.locals._bullBoardRouter(req, res, next);
    } catch (err: any) {
      next(err);
    }
  });
}

// ── Deep health check (cached 5 s to avoid DB/Redis I/O on every monitoring poll) ─
let _healthCache: { result: object; status: number; ts: number } | null = null;
const HEALTH_TTL_MS = 5_000;

async function buildHealthPayload(): Promise<{ checks: Record<string, string>; coreHealthy: boolean; platformHealthy: boolean }> {
  const checks: Record<string, string> = {};
  try { const { db } = await import('./db'); await db.query('SELECT 1'); checks.postgres = 'ok'; }
  catch { checks.postgres = 'error'; }
  try { const { getRedis } = await import('./queue'); await getRedis().ping(); checks.redis = 'ok'; }
  catch { checks.redis = 'error'; }
  try { const { getGenaClient } = await import('./ddp/gena-client'); checks.ddp_gena = getGenaClient()?.connected ? 'ok' : 'disconnected'; }
  catch { checks.ddp_gena = 'error'; }
  try { const { getEdikClient } = await import('./ddp/edik-client'); checks.ddp_edik = getEdikClient()?.connected ? 'ok' : 'disconnected'; }
  catch { checks.ddp_edik = 'error'; }

  // Platform guard circuit state — advisory only, does not affect HTTP status code.
  try {
    const { genaGuard, edikGuard } = await import('./lib/platform-guard');
    const gs = genaGuard.status(); const es = edikGuard.status();
    checks.gena_circuit  = gs.circuit === 'OPEN' ? 'open'  : 'ok';
    checks.edik_circuit  = es.circuit === 'OPEN' ? 'open'  : 'ok';
    checks.gena_inflight = String(gs.concurrent);
    checks.edik_inflight = String(es.concurrent);
  } catch { /* ignore */ }

  // BullMQ queue stats
  try {
    const { getCheckQueue, isRedisQueueCapable } = await import('./queue');
    if (await isRedisQueueCapable()) {
      const q = getCheckQueue();
      const [waiting, active, failed] = await Promise.all([
        q.getWaitingCount(), q.getActiveCount(), q.getFailedCount(),
      ]);
      checks.queue_waiting = String(waiting);
      checks.queue_active  = String(active);
      checks.queue_failed  = String(failed);
    } else {
      checks.queue = 'inline-mode';
    }
  } catch { checks.queue = 'error'; }

  const coreHealthy = ['postgres', 'redis'].every(k => checks[k] === 'ok');
  const platformHealthy = ['gena_circuit', 'edik_circuit'].every(k => !checks[k] || checks[k] === 'ok');
  return { checks, coreHealthy, platformHealthy };
}

app.get('/api/health', async (_req, res) => {
  const now = Date.now();
  if (_healthCache && now - _healthCache.ts < HEALTH_TTL_MS) {
    return res.status(_healthCache.status).json(_healthCache.result);
  }
  const { checks, coreHealthy, platformHealthy } = await buildHealthPayload();
  const result = {
    status: coreHealthy ? 'ok' : 'degraded',
    platform_status: platformHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  };
  _healthCache = { result, status: coreHealthy ? 200 : 503, ts: now };
  res.status(_healthCache.status).json(result);
});

// ── Global error handler (must be last) ─────────────────────────────────────
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  if ((req as any).timedout) {
    return res.status(503).json({ error: 'Запрос выполняется слишком долго. Попробуйте позже.' });
  }
  logger.error({ err, method: req.method, url: req.url }, '[RequestError]');
  res.status(err.status || 500).json({ error: err.message || 'Внутренняя ошибка сервера' });
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  // 1. Database
  try { await testConnection(); } catch (err) { logger.fatal({ err }, '❌ DB connection failed'); process.exit(1); }

  // 2. Auto-run migrations
  try {
    await runMigrations();
    logger.info('✅ Migrations applied');
  } catch (err) {
    logger.fatal({ err }, '❌ Migration failed');
    process.exit(1);
  }

  // 3. Load system config from DB (after migrations so table exists)
  const { configStore } = await import('./lib/config-store');
  await configStore.load();

  // 3b. Stuck-job reaper — marks processing jobs that exceeded their timeout as failed.
  // Prevents jobs hung on a crashed/timed-out platform call from blocking forever.
  {
    const { db: dbRef } = await import('./db');
    const reaper = async () => {
      try {
        const timeoutMin = configStore.get('stuck_job_timeout_min');
        const result = await dbRef.query(
          `UPDATE check_jobs
           SET status = 'failed',
               error  = 'Задача зависла (timeout) и была автоматически отменена.',
               updated_at = NOW()
           WHERE status IN ('processing', 'queued')
             AND updated_at < NOW() - ($1 || ' minutes')::interval
           RETURNING id`,
          [timeoutMin],
        );
        if (result.rows.length > 0) {
          logger.warn(`[reaper] Marked ${result.rows.length} stuck job(s) as failed (timeout=${timeoutMin}m)`);
        }
      } catch (err: any) {
        logger.warn({ err }, '[reaper] Stuck-job check failed');
      }
    };
    // Run once on startup (catches jobs stuck from a previous crash), then every 5 min.
    reaper();
    setInterval(reaper, 5 * 60_000).unref();
  }

  // 4. DDP (non-blocking)
  initDDPConnections().catch(err => logger.warn({ err }, 'DDP not ready on startup (will retry on demand)'));

  // 4a. Monti APM monitoring (non-blocking)
  const { initMontiClient } = await import('./ddp/monti-client');
  initMontiClient().catch(err => logger.warn({ err }, '[Monti] not ready on startup'));

  // 4b. SSE pub/sub subscriber — receives job completion events from workers (even in separate processes)
  const { startJobEventSubscriber } = await import('./lib/pubsub');
  startJobEventSubscriber();
  logger.info('✅ SSE job-event subscriber started');

  // 4c. Scheduled DB cleanup (completed jobs, old logs)
  const { scheduleCleanup } = await import('./lib/cleanup');
  scheduleCleanup();

  // 5. BullMQ workers (if Redis capable and INLINE_WORKER not disabled)
  const { isRedisQueueCapable } = await import('./queue');
  if (process.env.INLINE_WORKER !== 'false' && await isRedisQueueCapable()) {
    try {
      const { startCheckWorker, startTextbookWorker } = await import('./worker');
      startCheckWorker();
      startTextbookWorker();
      logger.info('✅ Check + Textbook workers started (BullMQ)');
    } catch (err: any) { logger.warn({ err }, 'Inline worker not started'); }
  } else {
    logger.info('ℹ️  Inline check processing (Redis < 5 or INLINE_WORKER=false)');
  }

  const server = app.listen(PORT, () => logger.info(`✅ Backend at http://localhost:${PORT} [${IS_PROD ? 'production' : 'development'}]`));

  // 5. Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info(`[${signal}] Shutting down...`);
    server.close(async () => {
      try { const { db } = await import('./db'); await db.end(); logger.info('DB pool closed'); } catch { /* ignore */ }
      try { const { getRedis } = await import('./queue'); await getRedis().quit(); logger.info('Redis closed'); } catch { /* ignore */ }
      logger.info('Shutdown complete');
      process.exit(0);
    });
    setTimeout(() => { logger.error('Forced shutdown after timeout'); process.exit(1); }, 15_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start();
