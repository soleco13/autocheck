/**
 * Redis pub/sub for real-time job events.
 * Publisher: worker.ts → publishes when a job completes/fails.
 * Subscriber: SSE endpoint → receives events and pushes to browser.
 * Works for both single-process and multi-process deployments.
 */
import IORedis from 'ioredis';
import { Response } from 'express';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const JOB_CHANNEL_PREFIX = 'job-events:';

// ── Publisher ─────────────────────────────────────────────────────────────────
let _pub: IORedis | null = null;
function getPub(): IORedis {
  if (!_pub) {
    _pub = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null,
      retryStrategy: (times) => (times > 10 ? null : Math.min(times * 1000, 5000)),
    });
    _pub.on('error', () => {});
  }
  return _pub;
}

export async function publishJobEvent(
  teacherId: string,
  event: {
    jobId: string;
    status: 'completed' | 'failed' | 'progress';
    reportId?: string | null;
    error?: string | null;
    done?: number;
    total?: number;
  },
): Promise<void> {
  try {
    await getPub().publish(`${JOB_CHANNEL_PREFIX}${teacherId}`, JSON.stringify(event));
  } catch {}
}

// ── SSE connection registry (in-process fallback when pub/sub isn't ready) ───
// Key: teacherId → Set of active Response objects
const _sseConns = new Map<string, Set<Response>>();

export function registerSSE(teacherId: string, res: Response): () => void {
  if (!_sseConns.has(teacherId)) _sseConns.set(teacherId, new Set());
  _sseConns.get(teacherId)!.add(res);
  return () => {
    _sseConns.get(teacherId)?.delete(res);
    if (_sseConns.get(teacherId)?.size === 0) _sseConns.delete(teacherId);
  };
}

function pushToSSE(teacherId: string, data: string): void {
  const conns = _sseConns.get(teacherId);
  if (!conns?.size) return;
  const msg = `data: ${data}\n\n`;
  for (const res of conns) {
    try { res.write(msg); } catch {}
  }
}

// ── Subscriber (one per process) ──────────────────────────────────────────────
let _sub: IORedis | null = null;

export function startJobEventSubscriber(): void {
  if (_sub) return;
  _sub = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => (times > 10 ? null : Math.min(times * 1000, 5000)),
  });
  _sub.on('error', () => {});

  _sub.psubscribe(`${JOB_CHANNEL_PREFIX}*`, (err) => {
    if (err) console.warn('[pubsub] psubscribe error:', err.message);
  });

  _sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
    const teacherId = channel.slice(JOB_CHANNEL_PREFIX.length);
    pushToSSE(teacherId, message);
  });
}
