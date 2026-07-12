/**
 * @riposte/exporter — turns a set project into deployable CasparCG templates.
 *
 * 'external' (default): per-scene HTML shells next to ONE shared assets
 * folder (which also carries a single riposte.js runtime), relative
 * references only — the exported folder works anywhere under the CasparCG
 * template root. Only assets actually referenced by exported scenes (and
 * their components and fonts) are copied.
 *
 * 'baked': self-contained single-file HTML per scene — every asset and the
 * runtime inlined as data URIs (compatibility fallback; big files).
 */

import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SceneDoc, SceneElement, SetDoc } from '@riposte/shared';

export interface ExportOptions {
  mode?: 'external' | 'baked';
  /** Path to the runtime IIFE; defaults to the workspace build. */
  runtimeJs?: string;
}

export interface ExportResult {
  outDir: string;
  mode: 'external' | 'baked';
  scenes: string[];
  /** Scenes whose HTML actually changed on disk this run. */
  scenesUpdated: string[];
  /** Assets copied this run (missing or different at the destination). */
  assetsCopied: number;
  /** Assets already byte-identical at the destination. */
  assetsUpToDate: number;
  /** Total bytes of all referenced assets (copied or not). */
  assetBytes: number;
  runtimeUpdated: boolean;
  warnings: string[];
}

/** Write only when the content differs — unchanged files keep their timestamp. */
async function writeIfChanged(path: string, content: string): Promise<boolean> {
  try {
    if ((await readFile(path, 'utf8')) === content) return false;
  } catch {
    /* missing or unreadable — write it */
  }
  await writeFile(path, content, 'utf8');
  return true;
}

export interface SyncResult {
  copied: number;
  upToDate: number;
  /** Bytes actually transferred (copied files only). */
  copiedBytes: number;
}

/**
 * Incrementally mirror a directory tree into another (deploy an export to the
 * CasparCG template dir). Additive only — files that exist solely in the
 * destination are left alone, since the target dir usually holds other
 * template families too.
 */
export async function syncDir(srcDir: string, dstDir: string): Promise<SyncResult> {
  const r: SyncResult = { copied: 0, upToDate: 0, copiedBytes: 0 };
  await mkdir(dstDir, { recursive: true });
  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      const sub = await syncDir(src, dst);
      r.copied += sub.copied;
      r.upToDate += sub.upToDate;
      r.copiedBytes += sub.copiedBytes;
    } else if (entry.isFile()) {
      if (await copyIfChanged(src, dst)) {
        r.copied++;
        r.copiedBytes += (await stat(dst)).size;
      } else {
        r.upToDate++;
      }
    }
  }
  return r;
}

/** Copy only when the destination is missing or differs (size, then bytes). */
async function copyIfChanged(src: string, dst: string): Promise<boolean> {
  try {
    const [s, d] = await Promise.all([stat(src), stat(dst)]);
    if (s.size === d.size) {
      const [sb, db] = await Promise.all([readFile(src), readFile(dst)]);
      if (sb.equals(db)) return false;
    }
  } catch {
    /* destination missing — copy it */
  }
  await copyFile(src, dst);
  return true;
}

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNTIME = resolve(here, '..', '..', 'runtime', 'dist', 'riposte.js');

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  gif: 'image/gif',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

export async function exportSet(setDir: string, outDir: string, opts: ExportOptions = {}): Promise<ExportResult> {
  const warnings: string[] = [];
  const set = JSON.parse(await readFile(join(setDir, 'set.json'), 'utf8')) as SetDoc;
  const mode = opts.mode ?? set.export?.mode ?? 'external';
  const preloadAssets = set.export?.preloadAssets ?? true;
  const runtimeJs = await readFile(opts.runtimeJs ?? DEFAULT_RUNTIME, 'utf8');

  const readScene = async (file: string): Promise<SceneDoc | null> => {
    try {
      return JSON.parse(await readFile(join(setDir, file), 'utf8')) as SceneDoc;
    } catch {
      warnings.push(`missing scene file ${file}`);
      return null;
    }
  };

  const components: Record<string, SceneDoc> = {};
  for (const file of set.components ?? []) {
    const doc = await readScene(file);
    if (doc) components[file] = doc;
  }

  await mkdir(outDir, { recursive: true });
  const scenes: string[] = [];
  const scenesUpdated: string[] = [];
  const allAssets = new Set<string>();

  for (const file of set.scenes) {
    const doc = await readScene(file);
    if (!doc) continue;
    const name = file.replace(/^scenes\//, '').replace(/\.json$/, '');

    // components this scene actually embeds (transitively)
    const sceneComponents: Record<string, SceneDoc> = {};
    collectComponents(doc, components, sceneComponents, warnings);

    const assets = new Set<string>();
    collectAssets(doc, assets);
    for (const comp of Object.values(sceneComponents)) collectAssets(comp, assets);
    for (const f of set.fonts ?? []) assets.add(f.file);
    for (const a of assets) allAssets.add(a);

    const html =
      mode === 'external'
        ? externalShell(name, doc, sceneComponents, set, preloadAssets ? [...assets] : [])
        : await bakedShell(name, doc, sceneComponents, set, setDir, runtimeJs, warnings);

    if (await writeIfChanged(join(outDir, `${name}.html`), html)) scenesUpdated.push(name);
    scenes.push(name);
  }

  let assetsCopied = 0;
  let assetsUpToDate = 0;
  let assetBytes = 0;
  let runtimeUpdated = false;
  if (mode === 'external') {
    await mkdir(join(outDir, 'assets'), { recursive: true });
    runtimeUpdated = await writeIfChanged(join(outDir, 'assets', 'riposte.js'), runtimeJs);
    for (const rel of allAssets) {
      const src = join(setDir, rel);
      const dst = join(outDir, rel);
      try {
        await mkdir(dirname(dst), { recursive: true });
        if (await copyIfChanged(src, dst)) assetsCopied++;
        else assetsUpToDate++;
        assetBytes += (await stat(dst)).size;
      } catch {
        warnings.push(`missing asset ${rel}`);
      }
    }
  }

  return { outDir, mode, scenes, scenesUpdated, assetsCopied, assetsUpToDate, assetBytes, runtimeUpdated, warnings };
}

// ---- collection -------------------------------------------------------------

function collectComponents(
  doc: SceneDoc,
  available: Record<string, SceneDoc>,
  out: Record<string, SceneDoc>,
  warnings: string[],
  depth = 0,
): void {
  if (depth > 4) return;
  for (const layer of doc.composition.layers) {
    const el = layer.element;
    if (el.type !== 'composition') continue;
    if (out[el.compositionId]) continue;
    const comp = available[el.compositionId];
    if (!comp) {
      warnings.push(`${doc.name}: component ${el.compositionId} not found in set`);
      continue;
    }
    out[el.compositionId] = comp;
    collectComponents(comp, available, out, warnings, depth + 1);
  }
}

function collectAssets(doc: SceneDoc, out: Set<string>): void {
  const fromElement = (el: SceneElement): void => {
    if (el.type === 'image' && el.asset) out.add(el.asset);
    if (el.type === 'imageSequence') for (const f of el.frames) out.add(f);
    if (el.type === 'imageLoader' && el.placeholder) out.add(el.placeholder);
  };
  for (const layer of doc.composition.layers) {
    if (layer.isGuide) continue; // guides never render on air
    fromElement(layer.element);
    for (const m of layer.masks ?? []) fromElement(m);
  }
}

// ---- shells -----------------------------------------------------------------

/** JSON safe for inline <script> embedding. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function shellHtml(name: string, width: number, height: number, runtimeTag: string, bootScript: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${name}</title>
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:${width}px;height:${height}px}</style>
</head><body>
${runtimeTag}
<script>
${bootScript}
</script>
</body></html>
`;
}

function bootScript(scene: SceneDoc, components: Record<string, SceneDoc>, fonts: { family: string; url: string }[], preload: string[]): string {
  return (
    `riposte.boot(${inlineJson(scene)}, {\n` +
    `  components: ${inlineJson(components)},\n` +
    `  fonts: ${inlineJson(fonts)},\n` +
    `  preload: ${inlineJson(preload)},\n` +
    `});`
  );
}

function externalShell(name: string, scene: SceneDoc, components: Record<string, SceneDoc>, set: SetDoc, preload: string[]): string {
  const fonts = (set.fonts ?? []).map((f) => ({ family: f.family, url: f.file }));
  return shellHtml(
    name,
    scene.composition.width,
    scene.composition.height,
    '<script src="assets/riposte.js"></script>',
    bootScript(scene, components, fonts, preload),
  );
}

async function bakedShell(
  name: string,
  scene: SceneDoc,
  components: Record<string, SceneDoc>,
  set: SetDoc,
  setDir: string,
  runtimeJs: string,
  warnings: string[],
): Promise<string> {
  const dataUris = new Map<string, string>();
  const toDataUri = async (rel: string): Promise<string> => {
    const cached = dataUris.get(rel);
    if (cached) return cached;
    try {
      const bytes = await readFile(join(setDir, rel));
      const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
      const uri = `data:${MIME[ext] ?? 'application/octet-stream'};base64,${bytes.toString('base64')}`;
      dataUris.set(rel, uri);
      return uri;
    } catch {
      warnings.push(`${name}: missing asset ${rel}`);
      return '';
    }
  };

  const bakeDoc = async (doc: SceneDoc): Promise<SceneDoc> => {
    const clone = JSON.parse(JSON.stringify(doc)) as SceneDoc;
    const bakeElement = async (el: SceneElement): Promise<void> => {
      if (el.type === 'image' && el.asset) el.asset = await toDataUri(el.asset);
      if (el.type === 'imageSequence') {
        for (let i = 0; i < el.frames.length; i++) el.frames[i] = await toDataUri(el.frames[i]!);
      }
    };
    for (const layer of clone.composition.layers) {
      await bakeElement(layer.element);
      for (const m of layer.masks ?? []) await bakeElement(m);
    }
    return clone;
  };

  const bakedScene = await bakeDoc(scene);
  const bakedComponents: Record<string, SceneDoc> = {};
  for (const [file, doc] of Object.entries(components)) bakedComponents[file] = await bakeDoc(doc);
  const fonts = [];
  for (const f of set.fonts ?? []) fonts.push({ family: f.family, url: await toDataUri(f.file) });

  return shellHtml(
    name,
    scene.composition.width,
    scene.composition.height,
    `<script>${runtimeJs}</script>`,
    bootScript(bakedScene, bakedComponents, fonts, []),
  );
}
