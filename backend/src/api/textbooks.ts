import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth-middleware';
import { safeError } from '../lib/safe-error';
import { db } from '../db';
import { z } from 'zod';

const router = Router();

router.get('/', requireAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(`
      SELECT t.id, t.grade, t.subject_code, t.subject_name, t.title, t.author,
             COUNT(tc.id) AS chunks_count
      FROM textbooks t
      LEFT JOIN textbook_chunks tc ON tc.textbook_id = t.id
      GROUP BY t.id
      ORDER BY t.grade, t.subject_name
    `);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

const createSchema = z.object({
  grade:       z.number().int().min(1).max(11),
  subjectCode: z.string().min(1).max(10),
  subjectName: z.string().min(1).max(100),
  title:       z.string().min(1).max(300),
  author:      z.string().max(200).optional(),
  publisher:   z.string().max(200).optional(),
  year:        z.number().int().min(1900).max(2100).optional(),
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
    return;
  }
  const { grade, subjectCode, subjectName, title, author, publisher, year } = parsed.data;

  try {
    const result = await db.query(`
      INSERT INTO textbooks (grade, subject_code, subject_name, title, author, publisher, year)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [grade, subjectCode, subjectName, title, author ?? null, publisher ?? null, year ?? null]);
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: safeError(err) });
  }
});

const contentSchema = z.object({
  sections: z.array(z.object({
    title:    z.string().max(300).optional(),
    content:  z.string().max(500_000),
    position: z.number().int().min(0).optional(),
  })).min(1).max(100),
});

router.post('/:id/content', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = contentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
    return;
  }
  const { sections } = parsed.data;
  const textbookId = req.params.id;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let totalChunks = 0;

    for (const section of sections) {
      const sectionResult = await client.query(`
        INSERT INTO textbook_sections (textbook_id, title, content, position)
        VALUES ($1, $2, $3, $4) RETURNING id
      `, [textbookId, section.title || 'Section', section.content, section.position ?? 0]);

      const sectionId = sectionResult.rows[0].id;
      const content = section.content;
      const chunkSize = 500;

      for (let i = 0; i < content.length; i += chunkSize) {
        await client.query(`
          INSERT INTO textbook_chunks (textbook_id, section_id, chunk_text, chunk_index)
          VALUES ($1, $2, $3, $4)
        `, [textbookId, sectionId, content.slice(i, i + chunkSize), Math.floor(i / chunkSize)]);
        totalChunks++;
      }
    }

    await client.query('COMMIT');
    res.json({ sections: sections.length, chunks_count: totalChunks });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: safeError(err) });
  } finally {
    client.release();
  }
});

export default router;
