// Одноразовая миграция: старые обложки учебников хранились как мини-PDF
// (backend/covers/{id}.pdf, первая страница оригинала, вырезанная через pdf-lib).
// Новый пайплайн (cover-renderer.ts) рендерит и отдаёт PNG (covers/{id}.png).
// Оригинальные загруженные PDF уже удалены после индексации, поэтому
// единственный источник для регенерации — существующий {id}.pdf.
//
// Запуск (один раз, после `npm install` с новыми зависимостями):
//   cd backend && node scripts/migrate-covers-to-png.js
//
// Идемпотентно: пропускает {id}, для которых уже есть {id}.png.

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const COVERS_DIR = path.join(__dirname, '..', 'covers');
const STANDARD_FONTS_DIR =
  path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
const COVER_WIDTH = 300;

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
  }
}

async function renderOne(pdfPath, pngPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({
    data,
    canvasFactory: new NodeCanvasFactory(),
    isEvalSupported: false,
    disableFontFace: true,
    standardFontDataUrl: STANDARD_FONTS_DIR,
  }).promise;

  try {
    const page = await doc.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = COVER_WIDTH / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const factory = new NodeCanvasFactory();
    const { canvas, context } = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: context, viewport }).promise;

    fs.writeFileSync(pngPath, canvas.encodeSync('png'));
  } finally {
    await doc.destroy();
  }
}

async function main() {
  if (!fs.existsSync(COVERS_DIR)) {
    console.log('Нет папки covers/ — миграция не требуется.');
    return;
  }

  const pdfFiles = fs.readdirSync(COVERS_DIR).filter(f => f.endsWith('.pdf'));
  if (pdfFiles.length === 0) {
    console.log('Старых .pdf обложек не найдено — миграция не требуется.');
    return;
  }

  console.log(`Найдено ${pdfFiles.length} старых обложек.`);
  let ok = 0, skipped = 0, failed = 0;

  for (const file of pdfFiles) {
    const id = file.replace(/\.pdf$/, '');
    const pdfPath = path.join(COVERS_DIR, file);
    const pngPath = path.join(COVERS_DIR, `${id}.png`);

    if (fs.existsSync(pngPath)) {
      skipped++;
      continue;
    }

    try {
      await renderOne(pdfPath, pngPath);
      fs.unlinkSync(pdfPath);
      ok++;
      console.log(`  OK  ${id}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${id}: ${err.message}`);
    }
  }

  console.log(`Готово: ${ok} сконвертировано, ${skipped} пропущено (png уже есть), ${failed} ошибок.`);
  if (failed > 0) {
    console.log('Для документов с ошибкой обложка останется недоступна, пока учитель не нажмёт "Переиндексировать".');
  }
}

main().catch(err => {
  console.error('Миграция упала:', err);
  process.exit(1);
});
