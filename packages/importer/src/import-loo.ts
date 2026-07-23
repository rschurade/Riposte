/**
 * Import a Loopic .loo project into a Riposte set folder.
 *
 * - every composition becomes scenes/<name>.json
 * - image/font/sequence resources land in the set's SHARED assets pool,
 *   content-hash deduplicated across all imports into that set
 * - fonts are registered in set.json (family = Loopic resource name)
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { SceneDoc, SetDoc, SetFont } from '@riposte/shared';
import { SET_FORMAT_VERSION } from '@riposte/shared';
import type { LooDoc, LooResource } from './loo-format.ts';
import { AssetPool, decodeContent } from './assets.ts';
import { convertComposition, type AssetResolver } from './convert.ts';

export interface LooImportOptions {
  /**
   * Import every composition in the project file. Default: only the ACTIVE
   * composition plus compositions it (transitively) embeds via COMPOSITION
   * elements — .loo files accumulate old copies and test comps that were
   * never part of the exported template.
   */
  allCompositions?: boolean;
}

export interface LooImportResult {
  scenes: string[];
  /** Compositions skipped as unreferenced baggage (name per skip). */
  skipped: string[];
  warnings: string[];
  assetReport: AssetPool['report'];
}

export async function importLoo(looPath: string, setDir: string, opts: LooImportOptions = {}): Promise<LooImportResult> {
  const doc = JSON.parse(await readFile(looPath, 'utf8')) as LooDoc;
  const pool = await AssetPool.open(setDir);
  const warnings: string[] = [];

  // Index resources and lazily materialize them into the pool on first use,
  // so unreferenced resources don't bloat the set.
  const resources = new Map<string, LooResource>();
  for (const r of doc.resources?.resources ?? []) resources.set(r.id, r);

  const imagePaths = new Map<string, string>();
  const resolver: AssetResolver = {
    async image(resourceId) {
      const cached = imagePaths.get(resourceId);
      if (cached) return cached;
      const r = resources.get(resourceId);
      if (!r?.content) {
        warnings.push(`missing image resource ${resourceId}`);
        return '';
      }
      const rel = await pool.store(decodeContent(r.content), withExt(r.name, r.fileType));
      imagePaths.set(resourceId, rel);
      return rel;
    },
    async sequenceFrames(resourceId, imageIds) {
      const seq = resources.get(resourceId);
      if (!seq?.images) {
        warnings.push(`missing image sequence resource ${resourceId}`);
        return [];
      }
      const byId = new Map(seq.images.map((img) => [img.id, img]));
      const frames: string[] = [];
      for (const id of imageIds) {
        const img = byId.get(id);
        if (!img?.content) {
          warnings.push(`sequence ${seq.name}: missing frame ${id}`);
          continue;
        }
        const key = `${resourceId}/${id}`;
        let rel = imagePaths.get(key);
        if (!rel) {
          // Loopic names most sequences just "Image Sequence" — suffix with the
          // resource id so different sequences get distinct folders.
          const subdir = `${sanitizeDir(seq.name)}_${resourceId.slice(0, 4)}`;
          rel = await pool.store(decodeContent(img.content), withExt(img.name, img.fileType), subdir);
          imagePaths.set(key, rel);
        }
        frames.push(rel);
      }
      return frames;
    },
  };

  // Fonts: materialize all (they're small and set-wide by nature).
  const fonts: SetFont[] = [];
  for (const r of resources.values()) {
    if (r.fileResourceType === 'FONT' && r.content) {
      const rel = await pool.store(decodeContent(r.content), withExt(r.name, r.fileType ?? 'ttf'), 'fonts');
      fonts.push({ family: r.name, file: rel });
    }
  }

  const { keep, skipped, activeId } = selectCompositions(doc, opts.allCompositions ?? false);
  // Composition refs start as tokens; final filenames are assigned after
  // conversion so component files can be deduplicated by CONTENT — the same
  // component name in different .loo files often holds different variants
  // (each Team template ships its own "nest").
  const compRefs = new Map(keep.map((c) => [c.id, `@comp:${c.id}`]));

  const converted: { comp: (typeof keep)[number]; scene: Awaited<ReturnType<typeof convertComposition>>['scene']; isActive: boolean }[] = [];
  for (const comp of keep) {
    const { scene, warnings: w } = await convertComposition(comp, resolver, compRefs);
    warnings.push(...w.map((msg) => `${comp.name}: ${msg}`));
    converted.push({ comp, scene, isActive: comp.id === activeId || (opts.allCompositions ?? false) });
  }

  const sceneFiles: string[] = [];
  const componentFiles: string[] = [];
  const finalRefs = new Map<string, string>();
  await mkdir(join(setDir, 'scenes'), { recursive: true });

  // components first (so parents can reference their final filenames)
  for (const item of converted.filter((x) => !x.isActive)) {
    substituteCompRefs(item.scene, finalRefs, warnings);
    const content = JSON.stringify(item.scene, null, 2) + '\n';
    let file = `scenes/${sanitizeDir(item.comp.name)}.json`;
    const existing = await readFileOrNull(join(setDir, file));
    if (existing !== null && existing !== content) {
      // same name, different content — never overwrite (asset policy applies)
      const hash = createHash('sha1').update(content).digest('hex').slice(0, 8);
      file = `scenes/${sanitizeDir(item.comp.name)}-${hash}.json`;
    }
    if ((await readFileOrNull(join(setDir, file))) !== content) {
      await writeFile(join(setDir, file), content, 'utf8');
    }
    finalRefs.set(item.comp.id, file);
    componentFiles.push(file);
  }

  // Active scenes are named after the .loo FILE — that's the template's
  // user-facing identity (matches the exported .html name and what the
  // playout client references). Designers copy project files without
  // renaming the composition inside, so comp names collide (Medals *_v2).
  const looName = sanitizeDir(basename(looPath).replace(/\.loo$/i, ''));
  const actives = converted.filter((x) => x.isActive);
  for (const item of actives) {
    substituteCompRefs(item.scene, finalRefs, warnings);
    const fileStem = actives.length === 1 ? looName : sanitizeDir(item.comp.name);
    const file = `scenes/${fileStem}.json`;
    item.scene.name = fileStem;
    await writeFile(join(setDir, file), JSON.stringify(item.scene, null, 2) + '\n', 'utf8');
    sceneFiles.push(file);
  }

  await updateSetDoc(setDir, sceneFiles, componentFiles, fonts);
  return { scenes: sceneFiles, skipped, warnings, assetReport: pool.report };
}

/** Replace "@comp:<id>" tokens in composition elements with final filenames. */
function substituteCompRefs(scene: { composition: { layers: { element: { type: string; compositionId?: string } }[] } }, finalRefs: Map<string, string>, warnings: string[]): void {
  for (const layer of scene.composition.layers) {
    const el = layer.element;
    if (el.type !== 'composition' || !el.compositionId?.startsWith('@comp:')) continue;
    const file = finalRefs.get(el.compositionId.slice('@comp:'.length));
    if (file) el.compositionId = file;
    else warnings.push(`unresolved component reference in ${el.compositionId}`);
  }
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Active composition + everything it transitively embeds; the rest is baggage. */
function selectCompositions(
  doc: LooDoc,
  all: boolean,
): { keep: LooDoc['compositions']; skipped: string[]; activeId: string } {
  const byId = new Map(doc.compositions.map((c) => [c.id, c]));
  const active = byId.get(doc.activeCompositionId ?? '') ?? doc.compositions[0]!;
  if (all || doc.compositions.length < 2) return { keep: doc.compositions, skipped: [], activeId: active.id };
  const keptIds = new Set([active.id]);
  const queue = [active];
  while (queue.length > 0) {
    const comp = queue.pop()!;
    for (const layer of comp.layers) {
      const el = layer.element as { type: string; compositionId?: string };
      if (el.type === 'COMPOSITION' && el.compositionId && !keptIds.has(el.compositionId)) {
        keptIds.add(el.compositionId);
        const target = byId.get(el.compositionId);
        if (target) queue.push(target);
      }
    }
  }
  return {
    keep: doc.compositions.filter((c) => keptIds.has(c.id)),
    skipped: doc.compositions.filter((c) => !keptIds.has(c.id)).map((c) => c.name),
    activeId: active.id,
  };
}

async function updateSetDoc(setDir: string, newScenes: string[], newComponents: string[], newFonts: SetFont[]): Promise<void> {
  const setPath = join(setDir, 'set.json');
  let set: SetDoc;
  try {
    set = JSON.parse(await readFile(setPath, 'utf8')) as SetDoc;
  } catch {
    set = {
      formatVersion: SET_FORMAT_VERSION,
      name: basename(setDir),
      scenes: [],
      export: { mode: 'external', preloadAssets: true },
    };
  }
  for (const s of newScenes) if (!set.scenes.includes(s)) set.scenes.push(s);
  const components = set.components ?? [];
  for (const c of newComponents) {
    if (!components.includes(c)) components.push(c);
    // a component is never also a top-level scene
    set.scenes = set.scenes.filter((s) => s !== c);
  }
  if (components.length > 0) set.components = components;
  const fonts = set.fonts ?? [];
  for (const f of newFonts) {
    const existing = fonts.find((x) => x.family === f.family);
    if (!existing) fonts.push(f);
    else if (existing.file !== f.file) existing.file = f.file; // same family, newer file wins
  }
  if (fonts.length > 0) set.fonts = fonts;
  await writeFile(setPath, JSON.stringify(set, null, 2) + '\n', 'utf8');
}

function withExt(name: string, fileType: string | undefined): string {
  if (!fileType) return name;
  const ext = fileType.includes('/') ? fileType.split('/')[1]! : fileType;
  return name.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? name : `${name}.${ext}`;
}

function sanitizeDir(name: string): string {
  return name.replace(/[<>:"/\\|?*\s]+/g, '_');
}
