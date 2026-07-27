import { Queue, QueueOptions } from 'bullmq';
import IORedis from 'ioredis';

export const CHECK_QUEUE_NAME    = 'check-answers';
export const TEXTBOOK_QUEUE_NAME = 'textbook-index';

// Payload carried through Redis to the worker. The trainerToken (JWT) is needed to
// fetch the session state; it lives only in the Redis job, not in Postgres.
export interface CheckJobData {
  checkJobId: string;        // row id in check_jobs
  teacherId: string;
  studentId: string;
  editorUrl?: string;
  platformMaterialId?: string;
  trainerToken?: string;
  source?: 'manual' | 'prefetch';
}

let connection: IORedis | null = null;
let queue: Queue<CheckJobData> | null = null;

// A single shared ioredis connection. `maxRetriesPerRequest: null` is required by BullMQ.
export function getRedis(): IORedis {
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
    // Avoid an uncaught error if Redis is down — connection errors are handled
    // at the queue/enqueue layer (which falls back to inline processing).
    connection.on('error', () => { /* swallowed; surfaced via enqueue fallback */ });
  }
  return connection;
}

// BullMQ requires Redis >= 5.0.0. Returns true only when the server meets that bar,
// so callers can avoid starting a Worker that would just spam connection errors.
// Result is cached after the first successful probe.
let redisCapable: boolean | null = null;
export async function isRedisQueueCapable(): Promise<boolean> {
  if (redisCapable !== null) return redisCapable;
  const probe = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    lazyConnect: true,
    retryStrategy: () => null, // probe once, don't retry
  });
  probe.on('error', () => {});
  try {
    await probe.connect();
    const info = await probe.info('server');
    const m = info.match(/redis_version:(\d+)\.(\d+)\.(\d+)/);
    const major = m ? parseInt(m[1], 10) : 0;
    redisCapable = major >= 5;
    if (!redisCapable) {
      console.warn(`[queue] Redis ${m ? m[0].split(':')[1] : '?'} is too old for BullMQ (need >= 5.0.0). Using inline check processing.`);
    }
  } catch (err: any) {
    console.warn('[queue] Redis not reachable for queue:', err?.message || err);
    redisCapable = false;
  } finally {
    try { probe.disconnect(); } catch { /* ignore */ }
  }
  return redisCapable;
}

export function getCheckQueue(): Queue<CheckJobData> {
  if (!queue) {
    const opts: QueueOptions = {
      connection: getRedis() as any,
      defaultJobOptions: {
        // 3 attempts total. Backoff delay is controlled per-error-type by the
        // worker's custom backoffStrategy (see worker.ts). The 'exponential' type
        // here is just the fallback base; the strategy function overrides it.
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    };
    queue = new Queue<CheckJobData>(CHECK_QUEUE_NAME, opts);
  }
  return queue;
}

// Priority: manual checks (teacher is waiting) jump ahead of background prefetch.
export const PRIORITY = { manual: 1, prefetch: 10 } as const;

// ── Textbook indexing queue ───────────────────────────────────────────────────

export interface TextbookIndexJobData {
  documentId: string;   // id в rag_documents
  teacherId:  string;
  filePath:   string;   // абсолютный путь к temp-файлу на диске
}

let textbookQueue: Queue<TextbookIndexJobData> | null = null;

export function getTextbookQueue(): Queue<TextbookIndexJobData> {
  if (!textbookQueue) {
    textbookQueue = new Queue<TextbookIndexJobData>(TEXTBOOK_QUEUE_NAME, {
      connection: getRedis() as any,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    });
  }
  return textbookQueue;
}
