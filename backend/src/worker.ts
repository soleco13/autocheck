import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();

import { Worker } from 'bullmq';
import { CHECK_QUEUE_NAME, CheckJobData, getRedis } from './queue';
import { db } from './db';
import { runCheckPipeline } from './services/check-runner';
import { initDDPConnections } from './ddp/connection-pool';

// How many checks this worker processes at once. Each check parallelises its own
// AI calls internally (AI_CONCURRENCY), so keep this modest.
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '3', 10);

let worker: Worker<CheckJobData> | null = null;

export function startCheckWorker(): Worker<CheckJobData> {
  if (worker) return worker;

  worker = new Worker<CheckJobData>(
    CHECK_QUEUE_NAME,
    async (job) => {
      const { checkJobId } = job.data;
      await db.query(
        `UPDATE check_jobs SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [checkJobId],
      );

      const { sessionId, reportId } = await runCheckPipeline({
        teacherId: job.data.teacherId,
        studentId: job.data.studentId,
        editorUrl: job.data.editorUrl,
        platformMaterialId: job.data.platformMaterialId,
        trainerToken: job.data.trainerToken,
      });

      await db.query(
        `UPDATE check_jobs SET status = 'completed', session_id = $1, report_id = $2, error = NULL, updated_at = NOW() WHERE id = $3`,
        [sessionId, reportId, checkJobId],
      );
      return { sessionId, reportId };
    },
    { connection: getRedis() as any, concurrency: WORKER_CONCURRENCY },
  );

  worker.on('failed', async (job, err) => {
    console.error(`[worker] job ${job?.id} failed:`, err.message);
    // Mark failed only when no retries remain.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await db.query(
        `UPDATE check_jobs SET status = 'failed', error = $1, updated_at = NOW() WHERE id = $2`,
        [err.message?.slice(0, 500) || 'unknown error', job.data.checkJobId],
      ).catch(() => { /* best-effort */ });
    }
  });

  worker.on('completed', (job) => {
    console.log(`[worker] job ${job.id} completed`);
  });

  console.log(`✅ Check worker started (concurrency=${WORKER_CONCURRENCY})`);
  return worker;
}

// Standalone entrypoint: `node dist/worker.js` (prod) or `ts-node src/worker.ts` (dev).
if (require.main === module) {
  initDDPConnections().catch(() => { /* connects lazily on demand too */ });
  startCheckWorker();

  const shutdown = async () => {
    console.log('[worker] shutting down…');
    if (worker) await worker.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
