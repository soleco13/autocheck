import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();

import { Worker } from 'bullmq';
import { CHECK_QUEUE_NAME, CheckJobData, getRedis } from './queue';
import { db } from './db';
import { runCheckPipeline } from './services/check-runner';
import { initDDPConnections } from './ddp/connection-pool';
import { publishJobEvent } from './lib/pubsub';
import { configStore } from './lib/config-store';
import { startTextbookWorker } from './textbook-worker';

let worker: Worker<CheckJobData> | null = null;

export function startCheckWorker(): Worker<CheckJobData> {
  if (worker) return worker;

  // Read concurrency from configStore (populated from DB) so the Settings UI value
  // takes effect after restart. Falls back to env var → default 5.
  const concurrency = configStore.get('worker_concurrency')
    || parseInt(process.env.WORKER_CONCURRENCY || '5', 10);

  worker = new Worker<CheckJobData>(
    CHECK_QUEUE_NAME,
    async (job) => {
      const { checkJobId } = job.data;

      // If the job was cancelled in DB while it was waiting in Redis, skip it.
      const statusRow = await db.query(
        'SELECT status FROM check_jobs WHERE id = $1',
        [checkJobId],
      );
      if (statusRow.rows[0]?.status === 'failed') {
        return { skipped: true, reason: 'cancelled' };
      }

      await db.query(
        `UPDATE check_jobs SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [checkJobId],
      );

      const onAnswerProgress = (done: number, total: number) => {
        publishJobEvent(job.data.teacherId, { jobId: checkJobId, status: 'progress', done, total }).catch(() => {});
      };

      const { sessionId, reportId } = await runCheckPipeline({
        teacherId: job.data.teacherId,
        studentId: job.data.studentId,
        editorUrl: job.data.editorUrl,
        platformMaterialId: job.data.platformMaterialId,
        trainerToken: job.data.trainerToken,
      }, onAnswerProgress);

      await db.query(
        `UPDATE check_jobs SET status = 'completed', session_id = $1, report_id = $2, error = NULL, updated_at = NOW() WHERE id = $3`,
        [sessionId, reportId, checkJobId],
      );
      // Push real-time completion event to teacher's SSE stream
      publishJobEvent(job.data.teacherId, { jobId: checkJobId, status: 'completed', reportId }).catch(() => {});
      return { sessionId, reportId };
    },
    {
      connection: getRedis() as any,
      concurrency,
      // 30 min lock duration — bulk AI checks can take a long time per job.
      // Jobs that truly stall (process crash) are recovered by the stuck-job reaper in server.ts.
      lockDuration: 30 * 60_000,
      stalledInterval: 60_000,
      settings: {
        // Custom backoff: rate-limit and circuit errors get 60–90s jitter to spread retries
        // across the rate-limit window. Other errors get standard exponential backoff.
        backoffStrategy: (attemptsMade: number, _type: string | undefined, err: Error | undefined) => {
          if (err?.message?.includes('RATE_LIMIT') || err?.message?.includes('CIRCUIT_OPEN')) {
            // Wait for the 60s rate-limit window to fully reset, plus random jitter (0–30s)
            // to prevent all retried jobs from hitting the limiter in the same second.
            return 60_000 + Math.floor(Math.random() * 30_000);
          }
          // Exponential backoff with jitter for transient errors
          return Math.min(Math.pow(2, attemptsMade) * 1_000 + Math.floor(Math.random() * 2_000), 30_000);
        },
      },
    },
  );

  worker.on('failed', async (job, err) => {
    console.error(`[worker] job ${job?.id} failed:`, err.message);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await db.query(
        `UPDATE check_jobs SET status = 'failed', error = $1, updated_at = NOW() WHERE id = $2`,
        [err.message?.slice(0, 500) || 'unknown error', job.data.checkJobId],
      ).catch(() => {});
      publishJobEvent(job.data.teacherId, {
        jobId: job.data.checkJobId,
        status: 'failed',
        error: err.message?.slice(0, 200),
      }).catch(() => {});
    }
  });

  worker.on('completed', (job) => {
    console.log(`[worker] job ${job.id} completed`);
  });

  console.log(`✅ Check worker started (concurrency=${concurrency})`);
  return worker;
}

export { startTextbookWorker };

// Standalone entrypoint: `node dist/worker.js` (prod) or `ts-node src/worker.ts` (dev).
if (require.main === module) {
  (async () => {
    // Load system config from DB so configStore.get('worker_concurrency') returns the DB value.
    await configStore.load();
    initDDPConnections().catch(() => { /* connects lazily on demand too */ });
    startCheckWorker();

    const shutdown = async () => {
      console.log('[worker] shutting down…');
      if (worker) await worker.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })();
}
