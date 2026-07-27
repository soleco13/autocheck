import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();

import { Worker } from 'bullmq';
import { TEXTBOOK_QUEUE_NAME, TextbookIndexJobData, getRedis } from './queue';
import { db } from './db';
import { runIndexPipeline } from './services/rag-indexer';
import { configStore } from './lib/config-store';
import { logger } from './lib/logger';

let worker: Worker<TextbookIndexJobData> | null = null;

export function startTextbookWorker(): Worker<TextbookIndexJobData> {
  if (worker) return worker;

  const concurrency = configStore.get('rag_index_concurrency') || 1;

  worker = new Worker<TextbookIndexJobData>(
    TEXTBOOK_QUEUE_NAME,
    async (job) => {
      const { documentId, filePath } = job.data;
      logger.info({ documentId }, '[textbook-worker] starting indexing');

      // Guard: if document was deleted while queued — skip
      const row = await db.query(
        'SELECT status FROM rag_documents WHERE id = $1',
        [documentId],
      );
      if (!row.rows[0] || row.rows[0].status === 'error') {
        logger.warn({ documentId }, '[textbook-worker] document gone or errored, skipping');
        return { skipped: true };
      }

      await runIndexPipeline(documentId, filePath);
      return { documentId, done: true };
    },
    {
      connection:     getRedis() as any,
      concurrency,
      lockDuration:   20 * 60_000, // 20 min — большие PDF могут долго обрабатываться
      stalledInterval: 60_000,
      settings: {
        backoffStrategy: (attemptsMade: number, _type: string | undefined, err: Error | undefined) => {
          // PDF parse / IO throttle — подождать 30s с джиттером перед повтором
          if (err?.message?.includes('429') || err?.message?.includes('rate')) {
            return 30_000 + Math.floor(Math.random() * 15_000);
          }
          return Math.min(Math.pow(2, attemptsMade) * 2_000, 30_000);
        },
      },
    },
  );

  worker.on('failed', async (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, '[textbook-worker] job failed');
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await db.query(
        `UPDATE rag_documents
         SET status = 'error', error_msg = $1, updated_at = NOW()
         WHERE id = $2`,
        [err.message?.slice(0, 500) || 'Unknown error', job.data.documentId],
      ).catch(() => {});
    }
  });

  worker.on('completed', job => {
    logger.info({ jobId: job.id }, '[textbook-worker] job completed');
  });

  logger.info({ concurrency }, '✅ Textbook indexing worker started');
  return worker;
}

// Standalone entrypoint (если запускать отдельно)
if (require.main === module) {
  (async () => {
    await configStore.load();
    startTextbookWorker();

    const shutdown = async () => {
      if (worker) await worker.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })();
}
