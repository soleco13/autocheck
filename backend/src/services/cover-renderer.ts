import fs from 'fs';
import path from 'path';
import { createCanvas } from '@napi-rs/canvas';
// pdfjs-dist v3 legacy build — CommonJS-compatible (v4+ ships ESM-only, incompatible with this project)
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import { logger } from '../lib/logger';

export const COVERS_DIR = path.join(process.cwd(), 'covers');

// pdf.js's Node font-data factory expects a plain filesystem directory path
// (not a file:// URL) — passing a URL makes it try (and fail) an HTTP fetch.
const STANDARD_FONTS_DIR =
  path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;

const COVER_WIDTH = 300; // px — thumbnail is shown at ~68px in the UI, 300 covers @2x/@3x DPI

class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    return { canvas, context };
  }
  reset(canvasAndContext: any, width: number, height: number) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext: any) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
  }
}

// Рендерит первую страницу PDF в PNG-обложку. Бросает исключение при неудаче —
// вызывающий код (rag-indexer) решает, критично это или нет.
export async function renderCoverPng(fileBuffer: Buffer, documentId: string): Promise<void> {
  fs.mkdirSync(COVERS_DIR, { recursive: true });

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(fileBuffer),
    canvasFactory: new NodeCanvasFactory(),
    isEvalSupported: false,
    disableFontFace: true,
    standardFontDataUrl: STANDARD_FONTS_DIR,
  });

  const doc = await loadingTask.promise;
  try {
    const page = await doc.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = COVER_WIDTH / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const factory = new NodeCanvasFactory();
    const { canvas, context } = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: context as any, viewport }).promise;

    const png = canvas.encodeSync('png');
    fs.writeFileSync(path.join(COVERS_DIR, `${documentId}.png`), png);
  } finally {
    await doc.destroy();
  }
}

export async function tryRenderCoverPng(fileBuffer: Buffer, documentId: string): Promise<void> {
  try {
    await renderCoverPng(fileBuffer, documentId);
  } catch (err: any) {
    // Обложка не критична для проверки работ — логируем и продолжаем
    logger.warn({ documentId, err: err.message }, '[cover-renderer] cover rendering failed');
  }
}
