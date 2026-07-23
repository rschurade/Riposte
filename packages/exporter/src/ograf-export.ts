/**
 * OGraf graphic export — generates an EBU OGraf v1 graphic from a Riposte
 * scene. Output is a folder containing:
 *   <name>.ograf.json  — manifest
 *   graphic.mjs        — ES module (custom HTMLElement bridging riposte.js)
 *   riposte.js         — the runtime (shared across exports)
 *   scene.json         — the SceneDoc data (referenced by the bridge)
 *   assets/            — images, fonts
 *
 * The bridge wraps the Riposte runtime as an OGraf custom element:
 *   load()       → riposte.createRuntime(scene, root) + apply initial data
 *   playAction() → riposte Runtime.play() / .next() (step model)
 *   stopAction() → riposte Runtime.stop()
 *   updateAction() → riposte Runtime.update(data)
 *   customAction() → riposte Runtime.invoke(id, payload)
 *   dispose()    → riposte Runtime.destroy()
 *
 * Step mapping: Riposte pause markers → OGraf steps.
 *   playAction({goto: 0}) → play to first pause
 *   playAction({delta: 1}) → next() past current pause
 *   stopAction() → play from outro to end
 */

import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompositionElement, OutroPreset, SceneDoc, SceneElement, SetDoc } from '@riposte/shared';
import { collectSceneKeys } from './contract.ts';

export interface OgrafExportResult {
  outDir: string;
  name: string;
  /** Files written this run. */
  filesWritten: string[];
  /** Number of asset files copied (images, fonts). */
  assetsCopied: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNTIME = resolve(here, '..', '..', 'runtime', 'dist', 'riposte.js');

/** Derive a JSON Schema from the scene's data-binding keys. */
function buildSchema(doc: SceneDoc, components: Record<string, SceneDoc | null>): Record<string, unknown> | undefined {
  const keys = collectSceneKeys(doc, components);
  const all = new Set([...keys.content, ...keys.visibility]);
  if (all.size === 0) return undefined;

  const props: Record<string, unknown> = {};
  for (const k of all) {
    props[k] = { type: 'string', title: k.replace(/^_/, '').replace(/_/g, ' ') };
  }
  return { type: 'object', properties: props };
}

/** Build actionDurations array from scene markers (frames → ms). */
function buildActionDurations(doc: SceneDoc): Record<string, unknown>[] | undefined {
  const fps = doc.composition.fps;
  const markers = doc.composition.markers ?? [];
  const actions: Record<string, unknown>[] = [];

  const pauseFrame = markers.find((m) => m.type === 'pause')?.frame;
  const outroFrame = markers.find((m) => m.type === 'outro')?.frame;

  // playAction duration: from 0 to first pause (or scene end)
  const playEnd = pauseFrame ?? doc.composition.duration;
  actions.push({ type: 'playAction', duration: Math.round((playEnd / fps) * 1000) });

  // stopAction duration: outro marker to end (or 0 if no outro)
  if (outroFrame !== undefined) {
    const outroDur = doc.composition.duration - outroFrame;
    actions.push({ type: 'stopAction', duration: Math.round((outroDur / fps) * 1000) });
  }

  return actions.length > 0 ? actions : undefined;
}

// ---- bridge graphic.mjs generation -------------------------------------------

/** Generate the bridge ES module that wraps a Riposte scene as an OGraf custom element. */
function bridgeModule(
  sceneName: string,
  width: number,
  height: number,
  pauseFrames: number[],
  hasOutro: boolean,
  scenePayload: Record<string, unknown>,
): string {
  const pauseJson = JSON.stringify(pauseFrames);
  const sceneInline = JSON.stringify(scenePayload);
  return `// OGraf graphic bridge for "${sceneName}"
// Wraps the Riposte runtime — WYSIWYG fidelity by construction.

export default class extends HTMLElement {
  #runtime = null;
  #currentStep = undefined;
  #pauseFrames = /** @type {number[]} */ (${pauseJson});
  #hasOutro = ${hasOutro};
  #outroResolve = null;
  #contentRoot = null;

  async load({ data, renderType }) {
    this.#contentRoot = this.appendChild(document.createElement('div'));
    this.#contentRoot.style.cssText =
      'position:relative;overflow:hidden;width:${width}px;height:${height}px';

    // Import riposte.js (IIFE that sets globalThis.riposte)
    const rp = new URL('./riposte.js', import.meta.url).href;
    await new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = rp;
      s.onload = ok;
      s.onerror = fail;
      document.head.appendChild(s);
    });

    // Scene data inlined (no separate scene.json — OGraf validators would flag it)
    const scene = /** @type {Object} */ (${sceneInline});

    const components = scene.v_ografComponents ?? {};
    delete scene.v_ografComponents;

    // Register fonts before boot
    if (scene.v_ografFonts?.length) {
      await Promise.all(scene.v_ografFonts.map((f) => {
        const fontUrl = new URL(f.url, import.meta.url).href;
        const face = new FontFace(f.family, 'url("' + fontUrl + '")');
        return face.load().then((ff) => document.fonts.add(ff)).catch(() => {});
      }));
    }

    const opts = {
      assetBase: new URL('./', import.meta.url).href,
      components,
      fonts: scene.v_ografFonts ?? [],
      preload: scene.v_ografPreload ?? [],
      ...(scene.v_ografOutro ? { outro: scene.v_ografOutro } : {}),
      ...(scene.v_ografIntro ? { intro: scene.v_ografIntro } : {}),
    };

    // Use createRuntime directly — we own the lifecycle
    this.#runtime = globalThis.riposte.createRuntime(scene, this.#contentRoot, opts);
    this.#runtime.useOnStop((next) => {
      next();
      if (this.#outroResolve) {
        const r = this.#outroResolve;
        this.#outroResolve = null;
        this.#currentStep = undefined;
        r();
      }
    });

    if (data && Object.keys(data).length > 0) {
      this.#runtime.update(data);
    }

    return { statusCode: 200 };
  }

  async dispose() {
    if (this.#runtime) {
      this.#runtime.destroy();
      this.#runtime = null;
    }
    if (this.#contentRoot) {
      this.innerHTML = '';
      this.#contentRoot = null;
    }
    return { statusCode: 200 };
  }

  async playAction({ goto, delta, skipAnimation }) {
    if (!this.#runtime) return { statusCode: 400, statusMessage: 'Not loaded' };

    // Determine target step
    let target = 0;
    if (goto !== undefined && goto >= 0) {
      target = goto;
    } else {
      const base = this.#currentStep === undefined ? -1 : this.#currentStep;
      target = base + (delta ?? 1);
    }

    if (this.#pauseFrames.length === 0 || target >= this.#pauseFrames.length) {
      // No more steps — transition to end via stop
      this.#currentStep = undefined;
      return new Promise((resolve) => {
        this.#outroResolve = resolve;
        this.#runtime.stop();
      }).then(() => ({ statusCode: 200 }));
    }

    if (this.#currentStep === undefined) {
      // Fresh play from start
      this.#currentStep = 0;
      this.#runtime.play();
    } else if (target > this.#currentStep) {
      // Step forward
      for (let i = this.#currentStep; i < target; i++) {
        this.#runtime.next();
      }
      this.#currentStep = target;
    } else {
      // No movement needed (already at or past target)
    }

    // playAction resolves when the animation reaches the pause
    // The riposte player pauses on the pause marker — we resolve here
    // after a microtask to let the marker processing complete
    await new Promise((r) => setTimeout(r, 0));
    return { statusCode: 200, currentStep: this.#currentStep };
  }

  async stopAction({ skipAnimation }) {
    if (!this.#runtime) return { statusCode: 400, statusMessage: 'Not loaded' };
    return new Promise((resolve) => {
      this.#outroResolve = resolve;
      // If scene has an outro marker, runtime.stop() plays the outro.
      // If no outro but has pause markers, next() resumes past the last
      // pause so the scene plays its out keyframes naturally.
      if (this.#hasOutro) {
        this.#runtime.stop();
      } else if (this.#pauseFrames.length > 0) {
        this.#runtime.next();
      } else {
        // Fire-and-forget: no pauses, just hide
        this.#outroResolve = null;
        this.#runtime.stop();
        resolve();
      }
    }).then(() => ({ statusCode: 200 }));
  }

  async updateAction({ data }) {
    if (!this.#runtime) return { statusCode: 400, statusMessage: 'Not loaded' };
    this.#runtime.update(data);
    return { statusCode: 200 };
  }

  async customAction({ id, payload }) {
    if (!this.#runtime) return { statusCode: 400, statusMessage: 'Not loaded' };
    try {
      this.#runtime.invoke(id, payload);
      return { statusCode: 200 };
    } catch {
      return { statusCode: 400, statusMessage: 'Unknown action: ' + id };
    }
  }
}
`;
}

// ---- main export function ----------------------------------------------------

export async function exportOgraf(
  scene: SceneDoc,
  sceneFile: string,
  components: Record<string, SceneDoc>,
  set: SetDoc,
  setDir: string,
  outDir: string,
): Promise<OgrafExportResult> {
  const name = sceneName(sceneFile);
  const sceneOutDir = join(outDir, name);
  await mkdir(sceneOutDir, { recursive: true });

  const filesWritten: string[] = [];
  const write = async (file: string, content: string): Promise<void> => {
    const path = join(sceneOutDir, file);
    await writeFile(path, content, 'utf8');
    filesWritten.push(file);
  };

  // Pause frames (for step model mapping in the bridge)
  const pauseFrames = (scene.composition.markers ?? [])
    .filter((m) => m.type === 'pause')
    .map((m) => m.frame);

  const hasOutro = (scene.composition.markers ?? []).some((m) => m.type === 'outro') || scene.outro != null;

  // Manifest
  const manifest: Record<string, unknown> = {
    $schema: 'https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json',
    id: name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-'),
    name: scene.name,
    main: 'graphic.mjs',
    supportsRealTime: true,
    supportsNonRealTime: false,
    renderRequirements: [
      {
        resolution: {
          width: { exact: scene.composition.width },
          height: { exact: scene.composition.height },
        },
        frameRate: { exact: scene.composition.fps },
      },
    ],
  };

  if (pauseFrames.length > 0) manifest['stepCount'] = pauseFrames.length;

  const schema = buildSchema(scene, components);
  if (schema) manifest['schema'] = schema;

  const durations = buildActionDurations(scene);
  if (durations) manifest['actionDurations'] = durations;

  await write(`${name}.ograf.json`, JSON.stringify(manifest, null, 2) + '\n');

  // Prepare scene data with embedded metadata for the bridge.
  // Use v_ prefix for vendor-specific fields per the OGraf spec.
  const scenePayload: Record<string, unknown> = {
    ...JSON.parse(JSON.stringify(scene)),
    v_ografComponents: components,
    v_ografFonts: (set.fonts ?? []).map((f) => ({ family: f.family, url: f.file })),
    v_ografPreload: [...assetsOf(scene, components)].map((a) => relative(sceneOutDir, join(setDir, a)).replace(/\\/g, '/')),
  };

  // Pre-load outro/intro presets
  const outro = scene.outro
    ? await readPresetOrNull(setDir, 'outros', scene.outro)
    : null;
  const intro = scene.intro
    ? await readPresetOrNull(setDir, 'intros', scene.intro)
    : null;
  if (outro) scenePayload['v_ografOutro'] = outro;
  if (intro) scenePayload['v_ografIntro'] = intro;

  // Bridge graphic.mjs — scene data is inlined, no separate scene.json
  await write('graphic.mjs', bridgeModule(
    scene.name,
    scene.composition.width,
    scene.composition.height,
    pauseFrames,
    hasOutro,
    scenePayload,
  ));

  // Copy riposte.js
  const runtimeJs = await readFile(DEFAULT_RUNTIME);
  await writeFile(join(sceneOutDir, 'riposte.js'), runtimeJs);
  filesWritten.push('riposte.js');

  // Copy assets
  let assetsCopied = 0;
  const allAssets = assetsOf(scene, components);
  for (const f of set.fonts ?? []) allAssets.add(f.file);

  if (allAssets.size > 0) {
    await mkdir(join(sceneOutDir, 'assets'), { recursive: true });
    for (const rel of allAssets) {
      const src = join(setDir, rel);
      const filename = basename(rel);
      const subPath = relative(join(setDir, 'assets'), dirname(join(setDir, rel)));
      const dstDir = subPath && subPath !== '.' ? join(sceneOutDir, 'assets', subPath) : join(sceneOutDir, 'assets');
      await mkdir(dstDir, { recursive: true });
      try {
        await copyFile(src, join(dstDir, filename));
        assetsCopied++;
      } catch {
        // missing asset — silently skip
      }
    }
  }

  return { outDir: sceneOutDir, name, filesWritten, assetsCopied };
}

// ---- helpers -----------------------------------------------------------------

function sceneName(file: string): string {
  return basename(file).replace(/\.json$/i, '');
}

function assetsOf(doc: SceneDoc, components: Record<string, SceneDoc>): Set<string> {
  const out = new Set<string>();
  const fromEl = (el: SceneElement): void => {
    if (el.type === 'image' && el.asset) out.add(el.asset);
    if (el.type === 'imageSequence') for (const f of el.frames) out.add(f);
    if (el.type === 'imageLoader' && el.placeholder) out.add(el.placeholder);
  };
  for (const layer of doc.composition.layers) {
    if (layer.isGuide) continue;
    fromEl(layer.element);
    for (const m of layer.masks ?? []) fromEl(m);
  }
  // recurse into nested compositions
  for (const layer of doc.composition.layers) {
    const el = layer.element as CompositionElement;
    if (el.type !== 'composition' || !el.compositionId) continue;
    const sub = components[el.compositionId];
    if (sub) {
      const subAssets = assetsOf(sub, components);
      for (const a of subAssets) out.add(a);
    }
  }
  return out;
}

async function readPresetOrNull(setDir: string, folder: string, name: string): Promise<OutroPreset | null> {
  try {
    return JSON.parse(await readFile(join(setDir, folder, `${name}.json`), 'utf8')) as OutroPreset;
  } catch {
    return null;
  }
}
