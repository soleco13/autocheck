/**
 * Database cleanup — removes old records to prevent unbounded table growth.
 * Called on startup + every 24 hours.
 */
import { db } from '../db';
import { logger } from './logger';

export async function runCleanup(): Promise<void> {
  try {
    // 1. Remove completed/failed check_jobs older than 30 days
    const jobs = await db.query(
      `DELETE FROM check_jobs
       WHERE status IN ('completed', 'failed')
         AND updated_at < NOW() - INTERVAL '30 days'
       RETURNING id`,
    );
    if (jobs.rows.length > 0) {
      logger.info(`[cleanup] Removed ${jobs.rows.length} old check_jobs`);
    }

    // 2. Remove ai_call_log entries older than 90 days (keep recent for billing/stats)
    const logs = await db.query(
      `DELETE FROM ai_call_log
       WHERE created_at < NOW() - INTERVAL '90 days'
       RETURNING id`,
    );
    if (logs.rows.length > 0) {
      logger.info(`[cleanup] Removed ${logs.rows.length} old ai_call_log entries`);
    }

    // 3. Remove ai_check_cache entries older than 30 days (curriculum may change)
    await db.query(
      `DELETE FROM ai_check_cache WHERE created_at < NOW() - INTERVAL '30 days'`,
    );

    // 4. Remove audit_log entries older than 1 year
    await db.query(
      `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '1 year'`,
    );
  } catch (err: any) {
    logger.warn({ err }, '[cleanup] Cleanup error');
  }
}

export function scheduleCleanup(): void {
  // Run once on startup (catches accumulated records after downtime)
  setTimeout(runCleanup, 60_000).unref();
  // Run every 24 hours
  setInterval(runCleanup, 24 * 60 * 60_000).unref();
}
