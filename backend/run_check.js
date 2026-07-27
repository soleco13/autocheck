require('dotenv').config();
require('ts-node').register({ transpileOnly: true, files: true });
const { db } = require('./src/db');
const { checkAnswersBatch } = require('./src/services/ai-checker');
const { generateReport } = require('./src/services/report-generator');

const SESSION_ID = 'e5ada9d3-8ffd-4cbe-b679-e5fab3f783ef';

(async () => {
  // 1. FTS по обоим учебникам
  console.log('\n=== FTS ТОП-5 по теме ===');
  for (const q of ['прошедшее время глагол', 'прошедшее время', 'глагол суффикс прошедший']) {
    const r = await db.query(`
      SELECT COUNT(*) as cnt FROM rag_chunks tc
      JOIN rag_documents td ON td.id=tc.document_id
      WHERE tc.search_vector @@ websearch_to_tsquery('russian',$1)
        AND td.subject_code='РЯ' AND td.grade='5'
    `, [q]);
    console.log(`  "${q}" -> ${r.rows[0].cnt} чанков`);
  }
  const topChunks = await db.query(`
    SELECT td.title, tc.chunk_index,
           ts_rank_cd(tc.search_vector, websearch_to_tsquery('russian','прошедшее время глагол')) as score,
           LEFT(tc.content,250) as preview
    FROM rag_chunks tc JOIN rag_documents td ON td.id=tc.document_id
    WHERE tc.search_vector @@ websearch_to_tsquery('russian','прошедшее время глагол')
      AND td.subject_code='РЯ' AND td.grade='5'
    ORDER BY score DESC LIMIT 5
  `);
  topChunks.rows.forEach(r =>
    console.log(`  [ch${r.chunk_index}] score=${parseFloat(r.score).toFixed(4)} | "${r.title.slice(-10)}" | "${r.preview.slice(0,150)}"\n`)
  );

  // 2. Сброс ответов (task_type в tasks, не answers)
  console.log('=== RESETTING ALL ANSWERS ===');
  await db.query(`
    UPDATE answers SET status=NULL, score=NULL, ai_feedback=NULL, ai_teacher_note=NULL
    WHERE session_id=$1
  `, [SESSION_ID]);
  await db.query(`DELETE FROM reports WHERE session_id=$1`, [SESSION_ID]);
  console.log('Reset done');

  // 3. Запуск проверки
  console.log('\n=== RUNNING checkAnswersBatch (RAG mode) ===');
  await checkAnswersBatch(SESSION_ID, (d, total) => process.stdout.write(`\r  ${d}/${total}`));
  console.log('\n');

  // 4. Результаты
  const results = await db.query(`
    SELECT a.status, a.score,
           LEFT(a.ai_feedback,400) as feedback,
           LEFT(a.ai_teacher_note,300) as note,
           t.task_type, LEFT(t.question_text,70) as question
    FROM answers a
    JOIN tasks t ON t.id=a.task_id
    WHERE a.session_id=$1
    ORDER BY t.task_index
  `, [SESSION_ID]);

  console.log('=== RESULTS ===');
  results.rows.forEach((r, i) => {
    console.log(`\n[${i+1}] [${r.task_type}] "${r.question}"`);
    console.log(`  Status: ${r.status} | Score: ${r.score}`);
    if (r.feedback) console.log(`  Feedback: "${r.feedback}"`);
    if (r.note) console.log(`  Note: "${r.note}"`);
  });

  const withCitation = results.rows.filter(r =>
    r.feedback && (r.feedback.includes('«') || r.feedback.includes('"') ||
      r.feedback.includes('учебник') || r.feedback.includes('правил'))
  );
  console.log(`\n=== ЦИТАТЫ/ССЫЛКИ: ${withCitation.length}/${results.rows.length} ответов ===`);

  // 5. Отчёт
  const reportId = await generateReport(SESSION_ID);
  console.log(`\n✅ Report: http://localhost:3000/reports/${reportId}`);

  await db.end();
})().catch(e => { console.error('\n❌', e.message, e.stack?.split('\n')[1]); process.exit(1); });
