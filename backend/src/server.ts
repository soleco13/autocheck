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
app.use(compression());

// ── HTTP request logging ─────────────────────────────────────────────────────
app.use(pinoHttp({
  logger,
  customLogLevel: (_req, res) => res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  redact: ['req.headers.cookie', 'req.headers.authorization'],
  autoLogging: { ignore: (req) => req.url === '/api/health' },
}));

// ── Request timeouts ─────────────────────────────────────────────────────────
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
const apiLimiter = rateLimit({
  windowMs: 60_000, max: 300,
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
app.use('/api/reports', reportsRouter);
app.use('/api/textbooks', textbooksRouter);
app.use('/api/materials', materialsRouter);
app.use('/api/settings', settingsRouter);

// ── Deep health check ────────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  const checks: Record<string, string> = {};
  try { const { db } = await import('./db'); await db.query('SELECT 1'); checks.postgres = 'ok'; }
  catch { checks.postgres = 'error'; }
  try { const { getRedis } = await import('./queue'); await getRedis().ping(); checks.redis = 'ok'; }
  catch { checks.redis = 'error'; }
  try { const { getGenaClient } = await import('./ddp/gena-client'); checks.ddp_gena = getGenaClient()?.connected ? 'ok' : 'disconnected'; }
  catch { checks.ddp_gena = 'error'; }
  try { const { getEdikClient } = await import('./ddp/edik-client'); checks.ddp_edik = getEdikClient()?.connected ? 'ok' : 'disconnected'; }
  catch { checks.ddp_edik = 'error'; }

  // Platform guard circuit state
  try {
    const { genaGuard, edikGuard } = await import('./lib/platform-guard');
    const gs = genaGuard.status(); const es = edikGuard.status();
    checks.gena_circuit  = gs.circuit === 'OPEN' ? 'open'  : 'ok';
    checks.edik_circuit  = es.circuit === 'OPEN' ? 'open'  : 'ok';
    checks.gena_inflight = String(gs.concurrent);
    checks.edik_inflight = String(es.concurrent);
  } catch { /* ignore */ }

  const healthy = ['postgres','redis','gena_circuit','edik_circuit'].every(k => !checks[k] || checks[k] === 'ok');
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', timestamp: new Date().toISOString(), checks });
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

  // 3. DDP (non-blocking)
  initDDPConnections().catch(err => logger.warn({ err }, 'DDP not ready on startup (will retry on demand)'));

  // 4. BullMQ worker (if Redis capable)
  const { isRedisQueueCapable } = await import('./queue');
  if (process.env.INLINE_WORKER !== 'false' && await isRedisQueueCapable()) {
    try {
      const { startCheckWorker } = await import('./worker');
      startCheckWorker();
      logger.info('✅ Check worker started (BullMQ)');
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
