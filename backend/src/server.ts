import 'reflect-metadata';

// SimpleDDP and other async libs can emit unhandled rejections internally.
// Catch them here to prevent process crash.
process.on('unhandledRejection', (reason: any) => {
  console.warn('[UnhandledRejection] Suppressed:', reason?.message || String(reason).slice(0, 120));
});

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

dotenv.config();

import { testConnection } from './db';
import { initDDPConnections } from './ddp/connection-pool';
import authRouter from './api/auth';
import studentsRouter from './api/students';
import checksRouter from './api/checks';
import reportsRouter from './api/reports';
import textbooksRouter from './api/textbooks';
import materialsRouter from './api/materials';
import debugRouter from './api/debug';
import settingsRouter from './api/settings';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, try again later' },
});

app.use('/api/auth/login', loginLimiter);

app.use('/api/debug', debugRouter);
app.use('/api/auth', authRouter);
app.use('/api/students', studentsRouter);
app.use('/api/checks', checksRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/textbooks', textbooksRouter);
app.use('/api/materials', materialsRouter);
app.use('/api/settings', settingsRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

async function start() {
  try {
    await testConnection();
  } catch (err) {
    console.error('❌ Database connection failed:', err);
    process.exit(1);
  }

  initDDPConnections().catch(err => {
    console.warn('DDP connections not established on startup (will retry on demand):', err.message);
  });

  // Dev convenience: run the check worker inside the API process so checks complete
  // without a second process. In production set INLINE_WORKER=false and run the
  // worker separately (`npm run worker`) so heavy parsing never blocks the API.
  // Only start it when Redis can actually back the queue (>= 5.0.0); otherwise
  // enqueue falls back to inline processing and a Worker would just spam errors.
  if (process.env.INLINE_WORKER !== 'false') {
    const { isRedisQueueCapable } = await import('./queue');
    if (await isRedisQueueCapable()) {
      try {
        const { startCheckWorker } = await import('./worker');
        startCheckWorker();
      } catch (err: any) {
        console.warn('Inline worker not started:', err.message);
      }
    } else {
      console.log('ℹ️  Check worker disabled (Redis < 5). Checks run inline until Redis is upgraded.');
    }
  }

  app.listen(PORT, () => {
    console.log(`✅ Backend running at http://localhost:${PORT}`);
  });
}

start();
