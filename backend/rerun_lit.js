require('dotenv').config();
require('ts-node').register({ transpileOnly: true, files: true });
const { db } = require('./src/db');
const { checkAnswersBatch } = require('./src/services/ai-checker');
const { generateReport } = require('./src/services/report-generator');

const SESSION_ID = '6549b6b4-4441-4b4e-a652-463c40090002';

(async () => {
  // Убедимся что учебник готов
  const docs = await db.query(`
    SELECT subject_code, grade, status, chunk_count FROM rag_documents
    WHERE subject_code='Л' AND status='ready'
  `);
  console.log('Textbooks ready:', docs.rows);

  // FTS тест по теме
  const fts = await db.query(`
    SELECT COUNT(*) as cnt FROM rag_chunks tc
    JOIN rag_documents td ON td.id=tc.document_id
    WHERE td.subject_code='Л' AND td.status='ready'
      AND tc.search_vector @@ websearch_to_tsquery('russian','былина Илья Муромец')
  `);
  console.log('FTS "былина Илья Муромец":', fts.rows[0].cnt, 'чанков');

  // Сброс
  console.log('\nResetting answers...');
  await db.query(`UPDATE answers SET status=NULL,score=NULL,ai_feedback=NULL,ai_teacher_note=NULL WHERE session_id=$1`, [SESSION_ID]);
  await db.query(`DELETE FROM reports WHERE session_id=$1`, [SESSION_ID]);

  // Запуск
  console.log('Running check...');
  await checkAnswersBatch(SESSION_ID, (d, t) => process.stdout.write(`\r  ${d}/${t}`));
  console.log('\n');

  // Результаты
  const rows = await db.query(`
    SELECT a.status, LEFT(a.ai_feedback,250) as fb, t.task_type, LEFT(t.question_text,60) as q
    FROM answers a JOIN tasks t ON t.id=a.task_id
    WHERE a.session_id=$1 ORDER BY t.task_index
  `, [SESSION_ID]);

  rows.rows.forEach((r, i) => {
    console.log(`[${i+1}] [${r.task_type}] ${r.status} | "${r.q}"`);
    if (r.fb) console.log(`     "${r.fb}"`);
  });

  const ok = rows.rows.every(r => r.status && r.status !== 'null');
  if (!ok) { console.log('\n❌ Ошибка: часть ответов не проверена'); process.exit(1); }

  const reportId = await generateReport(SESSION_ID);
  console.log(`\n✅ http://localhost:3000/reports/${reportId}`);
  await db.end();
})().catch(e => { console.error('\n❌', e.message); process.exit(1); });
