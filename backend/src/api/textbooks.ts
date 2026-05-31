import { Router, Request, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth-middleware';
import { db } from '../db';

const router = Router();

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const result = await db.query(`
    SELECT t.id, t.grade, t.subject_code, t.subject_name, t.title, t.author,
           COUNT(tc.id) as chunks_count
    FROM textbooks t
    LEFT JOIN textbook_chunks tc ON tc.textbook_id = t.id
    GROUP BY t.id
    ORDER BY t.grade, t.subject_name
  `);
  res.json(result.rows);
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { grade, subjectCode, subjectName, title, author, publisher, year } = req.body;
  if (!grade || !subjectCode || !subjectName || !title) {
    res.status(400).json({ error: 'grade, subjectCode, subjectName, title required' });
    return;
  }

  const result = await db.query(`
    INSERT INTO textbooks (grade, subject_code, subject_name, title, author, publisher, year)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [grade, subjectCode, subjectName, title, author, publisher, year]);

  res.status(201).json(result.rows[0]);
});

// Upload textbook content (text chunks)
router.post('/:id/content', requireAuth, async (req: AuthRequest, res: Response) => {
  const { sections } = req.body;
  if (!Array.isArray(sections)) {
    res.status(400).json({ error: 'sections array required' });
    return;
  }

  const textbookId = req.params.id;
  let totalChunks = 0;

  for (const section of sections) {
    // Create section
    const sectionResult = await db.query(`
      INSERT INTO textbook_sections (textbook_id, title, content, position)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [textbookId, section.title || 'Section', section.content || '', section.position || 0]);

    const sectionId = sectionResult.rows[0].id;

    // Split content into chunks of ~500 chars
    const content: string = section.content || '';
    const chunkSize = 500;
    const chunks: string[] = [];
    for (let i = 0; i < content.length; i += chunkSize) {
      chunks.push(content.slice(i, i + chunkSize));
    }

    for (let i = 0; i < chunks.length; i++) {
      await db.query(`
        INSERT INTO textbook_chunks (textbook_id, section_id, chunk_text, chunk_index)
        VALUES ($1, $2, $3, $4)
      `, [textbookId, sectionId, chunks[i], i]);
      totalChunks++;
    }
  }

  res.json({ sections: sections.length, chunks_count: totalChunks });
});

export default router;
