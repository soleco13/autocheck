import fs from 'fs';
import path from 'path';
import os from 'os';
import { COVERS_DIR } from '../services/cover-renderer';
import { Router, Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { requireAuth, AuthRequest } from '../middleware/auth-middleware';
import { safeError } from '../lib/safe-error';
import { db } from '../db';
import { getTextbookQueue, isRedisQueueCapable } from '../queue';
import { runIndexPipeline } from '../services/rag-indexer';
import { logger } from '../lib/logger';

const router = Router();

// ── multer: temp storage, 50 MB limit, PDF only ──────────────────────────────

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const unique = `tb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      cb(null, unique + path.extname(file.originalname));
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Только PDF файлы поддерживаются'));
    }
  },
});

// 5 загрузок в минуту на учителя
const uploadLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  keyGenerator: (req: any) => req.teacherId || req.ip,
  message: { error: 'Слишком много загрузок. Подождите минуту.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── GET /api/textbooks ────────────────────────────────────────────────────────

router.get('/', requireAuth, async (_req: AuthRequest, res: Response) => {
  try {
    // Учебники — общий ресурс: видны и используются всеми учителями системы,
    // а не только тем, кто загрузил.
    const result = await db.query(
      `SELECT id, filename, title, author, subject_code, grade, lang,
              file_size_bytes, chunk_count, status, progress_step, progress_pct,
              error_msg, created_at, updated_at
       FROM rag_documents
       ORDER BY created_at DESC`,
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

// ── GET /api/textbooks/:id/cover — первая страница PDF как обложка ───────────

router.get('/:id/cover', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    // Учебник — общий ресурс, доступен любому авторизованному учителю
    const check = await db.query(
      `SELECT 1 FROM rag_documents WHERE id = $1`,
      [req.params.id],
    );
    if (!check.rows[0]) { res.status(404).end(); return; }

    const coverPath = path.join(COVERS_DIR, `${req.params.id}.png`);
    if (!fs.existsSync(coverPath)) { res.status(404).end(); return; }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 дней
    fs.createReadStream(coverPath).pipe(res);
  } catch (err: any) {
    res.status(500).end();
  }
});

// ── GET /api/textbooks/:id/status ────────────────────────────────────────────

router.get('/:id/status', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      `SELECT id, status, progress_step, progress_pct, chunk_count, error_msg, updated_at
       FROM rag_documents
       WHERE id = $1`,
      [req.params.id],
    );
    if (!result.rows[0]) { res.status(404).json({ error: 'Учебник не найден' }); return; }
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

// ── POST /api/textbooks/upload-pdf ───────────────────────────────────────────

router.post(
  '/upload-pdf',
  requireAuth,
  uploadLimiter,
  upload.single('file'),
  async (req: AuthRequest, res: Response) => {
    const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: 'Файл не прикреплён' });
      return;
    }

    const { title, author, subjectCode, grade, lang } = req.body;
    if (!title?.trim()) {
      res.status(400).json({ error: 'Название учебника обязательно' });
      return;
    }

    try {
      // Create document record
      const insertResult = await db.query(
        `INSERT INTO rag_documents
           (teacher_id, filename, title, author, subject_code, grade, lang, file_size_bytes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
         RETURNING id`,
        [
          req.teacherId,
          file.originalname,
          title.trim(),
          author?.trim() || null,
          subjectCode || null,
          grade || null,
          lang || 'ru',
          file.size,
        ],
      );

      const documentId: string = insertResult.rows[0].id;
      const filePath = file.path;

      // Try BullMQ queue first, fall back to async inline
      const canQueue = await isRedisQueueCapable();

      if (canQueue) {
        const queue = getTextbookQueue();
        await queue.add('index', { documentId, teacherId: req.teacherId!, filePath });
        logger.info({ documentId }, '[textbooks] enqueued for indexing');
      } else {
        // Non-blocking fallback — setImmediate so response is sent first
        setImmediate(() => {
          runIndexPipeline(documentId, filePath).catch(err => {
            logger.error({ documentId, err: err.message }, '[textbooks] inline indexing failed');
          });
        });
        logger.info({ documentId }, '[textbooks] inline indexing (no Redis)');
      }

      res.status(201).json({ id: documentId, status: 'pending' });
    } catch (err: any) {
      res.status(500).json({ error: safeError(err) });
    }
  },
);

// ── POST /api/textbooks/:id/reindex — повторная обработка с новым PDF ────────

router.post(
  '/:id/reindex',
  requireAuth,
  upload.single('file'),
  async (req: AuthRequest, res: Response) => {
    const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
    if (!file) { res.status(400).json({ error: 'Файл не прикреплён' }); return; }

    try {
      const docResult = await db.query(
        `UPDATE rag_documents
         SET status = 'pending', progress_step = NULL, progress_pct = 0,
             chunk_count = 0, error_msg = NULL, file_size_bytes = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING id`,
        [file.size, req.params.id],
      );
      if (!docResult.rows[0]) {
        res.status(404).json({ error: 'Учебник не найден' }); return;
      }

      const documentId = req.params.id;
      const filePath = file.path;
      const canQueue = await isRedisQueueCapable();

      if (canQueue) {
        const queue = getTextbookQueue();
        await queue.add('index', { documentId, teacherId: req.teacherId!, filePath }, { priority: 1 });
      } else {
        setImmediate(() => {
          runIndexPipeline(documentId, filePath).catch(err => {
            logger.error({ documentId, err: err.message }, '[textbooks] reindex failed');
          });
        });
      }

      res.json({ id: documentId, status: 'pending' });
    } catch (err: any) {
      res.status(500).json({ error: safeError(err) });
    }
  },
);

// ── DELETE /api/textbooks/:id ─────────────────────────────────────────────────

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      `DELETE FROM rag_documents
       WHERE id = $1
       RETURNING id`,
      [req.params.id],
    );
    if (!result.rows[0]) { res.status(404).json({ error: 'Учебник не найден' }); return; }
    // Удаляем файл обложки
    try { fs.unlinkSync(path.join(COVERS_DIR, `${req.params.id}.png`)); } catch { /* уже нет */ }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

export default router;
