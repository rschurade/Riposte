/**
 * PNG → WebP re-encoding for exports — pure JS + WASM (pngjs decode, jsquash
 * libwebp encode), so the packaged single-file server needs no native
 * binaries. Encodes are content-hash cached per set (.webp-cache/); repeat
 * exports cost nothing.
 *
 * Strategy for numeric quality: encode lossy AND lossless, ship the smaller —
 * flat-color frames come out both smaller and bit-perfect that way.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { init as webpInit, default as webpEncode } from '@jsquash/webp/encode.js';

// jsquash types assume a browser (ImageData, EmscriptenWasm namespace); we
// run it in node with a plain RGBA object and an explicit wasm binary.
type RawImage = { data: Uint8ClampedArray; width: number; height: number };
const initWebp = webpInit as unknown as (opts?: Record<string, unknown>) => Promise<unknown>;
const encodeWebp = webpEncode as unknown as (data: RawImage, opts?: Record<string, unknown>) => Promise<ArrayBuffer>;

const here = dirname(fileURLToPath(import.meta.url));

/** wasm lives next to the bundled server.js (packaged) or in node_modules (dev). */
const WASM_CANDIDATES = [
  join(here, 'webp_enc_simd.wasm'),
  resolve(here, '..', '..', '..', 'node_modules', '@jsquash', 'webp', 'codec', 'enc', 'webp_enc_simd.wasm'),
];

let initialized: Promise<boolean> | null = null;

function ensureInit(): Promise<boolean> {
  initialized ??= (async () => {
    const wasmPath = WASM_CANDIDATES.find((p) => existsSync(p));
    if (!wasmPath) return false;
    await initWebp({ wasmBinary: readFileSync(wasmPath) });
    return true;
  })();
  return initialized;
}

/** Null when the encoder is unavailable (missing wasm in a stripped install). */
export async function webpAvailable(): Promise<boolean> {
  try {
    return await ensureInit();
  } catch {
    return false;
  }
}

async function encodePng(pngBytes: Buffer, quality: number | 'lossless'): Promise<Buffer> {
  const png = PNG.sync.read(pngBytes);
  const imageData: RawImage = {
    data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length),
    width: png.width,
    height: png.height,
  };
  const lossless = Buffer.from(await encodeWebp(imageData, { lossless: 1 }));
  if (quality === 'lossless') return lossless;
  const lossy = Buffer.from(await encodeWebp(imageData, { quality }));
  return lossy.byteLength < lossless.byteLength ? lossy : lossless;
}

export interface WebpStats {
  encoded: number;
  cacheHits: number;
  pngBytes: number;
  webpBytes: number;
}

/**
 * WebP for a source PNG, through the per-set cache. Returns the cache file
 * path (stable content: safe for copyIfChanged into the export).
 */
export async function webpCached(
  setDir: string,
  srcPath: string,
  quality: number | 'lossless',
  stats: WebpStats,
): Promise<string> {
  if (!(await ensureInit())) throw new Error('webp encoder unavailable (webp_enc_simd.wasm not found)');
  const pngBytes = await readFile(srcPath);
  const key = createHash('sha1').update(pngBytes).update(`|${quality}`).digest('hex');
  const cacheFile = join(setDir, '.webp-cache', `${key}.webp`);
  if (existsSync(cacheFile)) {
    stats.cacheHits++;
  } else {
    const webp = await encodePng(pngBytes, quality);
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, webp);
    stats.encoded++;
  }
  stats.pngBytes += pngBytes.byteLength;
  stats.webpBytes += (await readFile(cacheFile)).byteLength;
  return cacheFile;
}
