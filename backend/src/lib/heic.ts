import crypto from 'crypto';
import { createCanvas } from '@napi-rs/canvas';

// iPhone photos arrive as HEIC/HEIF. Only Safari renders them, Word doesn't embed
// them, and vision models are hit-and-miss — so we transcode to JPEG on the fly.
// Nothing is persisted; the platform keeps the original file.

const MAX_SIDE = 2560; // enough for handwriting, keeps a 12 MP photo well under 1 MB
const JPEG_QUALITY = 85;

// ISO-BMFF "ftyp" box with a HEIF-family brand at bytes 8..11.
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif']);

export function isHeic(buf: Buffer, contentType?: string | null): boolean {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('heic') || ct.includes('heif')) return true;
  if (buf.length < 12 || buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('ascii', 8, 12);
  return HEIF_BRANDS.has(brand) && brand !== 'avif';
}

// A decode of a 12 MP iPhone photo peaks around ~400 MB RSS and ~2 s of CPU; a
// report page requests all its photos at once, so cap parallel decodes and keep
// recent results (teachers re-open the same report) in a small LRU.
const MAX_PARALLEL = 2;
const CACHE_ENTRIES = 30;
let running = 0;
const waiters: Array<() => void> = [];
const cache = new Map<string, Promise<Buffer>>();

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>(r => waiters.push(r));
  running++;
  try { return await fn(); } finally {
    running--;
    waiters.shift()?.();
  }
}

export function heicToJpeg(buf: Buffer): Promise<Buffer> {
  const key = crypto.createHash('sha1').update(buf).digest('hex');
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); cache.set(key, hit); // bump recency
    return hit;
  }
  const p = withSlot(() => decodeToJpeg(buf));
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  return p;
}

async function decodeToJpeg(buf: Buffer): Promise<Buffer> {
  // heic-decode is CJS but pulls a WASM build of libheif — load lazily so the
  // ~1.5 MB module is only paid for when a HEIC actually shows up.
  const decode: (opts: { buffer: Buffer }) => Promise<{ width: number; height: number; data: Uint8ClampedArray }> =
    require('heic-decode');
  const { width, height, data } = await decode({ buffer: buf });

  const src = createCanvas(width, height);
  const sctx = src.getContext('2d');
  const img = sctx.createImageData(width, height);
  img.data.set(data);
  sctx.putImageData(img, 0, 0);

  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  if (scale === 1) return src.encode('jpeg', JPEG_QUALITY);

  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const dst = createCanvas(w, h);
  dst.getContext('2d').drawImage(src, 0, 0, w, h);
  return dst.encode('jpeg', JPEG_QUALITY);
}

// Convenience for callers that already have bytes + upstream content-type:
// returns JPEG for HEIC input, passes anything else through untouched.
export async function normalizePhoto(buf: Buffer, contentType?: string | null): Promise<{ buf: Buffer; contentType: string | null }> {
  if (!isHeic(buf, contentType)) return { buf, contentType: contentType ?? null };
  return { buf: await heicToJpeg(buf), contentType: 'image/jpeg' };
}
