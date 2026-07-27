/**
 * SSE endpoint for real-time job status push.
 * Replaces /checks/jobs/status polling for bulk checks.
 * One persistent connection per teacher; all job events for that teacher arrive here.
 */
import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth-middleware';
import { registerSSE } from '../lib/pubsub';

const router = Router();

router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Keepalive ping every 25s (browsers close idle SSE after 30s)
  const ping = setInterval(() => {
    try { res.write(':ping\n\n'); } catch {}
  }, 25_000);

  const cleanup = registerSSE(req.teacherId!, res);

  req.on('close', () => {
    clearInterval(ping);
    cleanup();
  });
});

export default router;
