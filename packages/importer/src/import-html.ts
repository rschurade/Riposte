/**
 * Fallback importer: Loopic HTML EXPORT → Riposte scene.
 *
 * For templates whose .loo project is lost (e.g. the hand-converted
 * Schedule). The export contains the composition as readable JS:
 *   mainComposition = new Composition({... layers: [new Layer({...})] ...})
 * We extract that expression with a string-aware balanced scanner and
 * evaluate it with stub constructors, then translate like the .loo path.
 *
 * Semantics (verified against the FIE_2026 family):
 * - keyframe frames are LAYER-LOCAL (offset by layer.startFrame)
 * - x/y are the anchor position; style.transformOrigin = {x,y} plain offsets
 *   from center → center = value − origin (same rule as .loo)
 * - keyframe values live in `_value` (the literal carries get/set accessors)
 * - pause markers hide as `frameActions.push(new FrameAction(N, …pause…))`
 *   statements appended inside the composition action; outroFrame is a
 *   composition field
 * - hand-added <script> blocks after the loopic runtime CANNOT be imported —
 *   they are reported so their logic can be ported to the composition action
 */

import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  ElementStyle,
  Keyframe,
  Layer,
  Marker,
  SceneDoc,
  SceneElement,
  StyleProperty,
  TextElement,
} from '@riposte/shared';
import { SCENE_FORMAT_VERSION } from '@riposte/shared';
import { AssetPool, decodeContent } from './assets.ts';

export interface HtmlImportResult {
  scene: string;
  warnings: string[];
  /** Hand-added custom script blocks that need manual porting. */
  customScripts: string[];
  assetReport: AssetPool['report'];
}

// ---- export-side shapes (post stub-eval) -----------------------------------

interface XProp {
  unit?: string;
  value?: unknown;
  keyframes?: { _value?: unknown; value?: unknown; frame: number; easing?: { p1x: number; p1y: number; p2x: number; p2y: number } }[];
}

interface XElement {
  id: string;
  key?: string;
  type: string;
  style?: Record<string, unknown>;
  /** Sibling of style at element level in exports. */
  transformOrigin?: { x?: number; y?: number };
  content?: string;
  autoSize?: boolean;
  autoSqueeze?: boolean;
  multiline?: boolean;
  /** IMAGE: asset ref arrives as `content` in the export (same field texts use). */
  src?: string;
  imageSequence?: string[];
  images?: string[];
  size?: string;
}

interface XLayer {
  id: string;
  name?: string;
  startFrame: number;
  duration: number;
  isVisible?: boolean;
  isGuide?: boolean;
  maskLayers?: XLayer[];
  element: XElement;
}

interface XComposition {
  duration: number;
  fps?: number;
  outroFrame?: number;
  layers: XLayer[];
  compositionAction?: { __src: string };
}

export async function importLoopicHtml(htmlPath: string, setDir: string): Promise<HtmlImportResult> {
  const warnings: string[] = [];
  const html = await readFile(htmlPath, 'utf8');
  const htmlDir = dirname(htmlPath);
  const pool = await AssetPool.open(setDir);

  const comp = evalComposition(html);
  const name = sanitize(basename(htmlPath).replace(/\.html?$/i, ''));

  // asset resolution: relative paths (external export) or data URIs (baked)
  const assetCache = new Map<string, string>();
  const storeAsset = async (ref: string, fallbackName: string): Promise<string> => {
    const cached = assetCache.get(ref);
    if (cached !== undefined) return cached;
    let rel = '';
    try {
      if (ref.startsWith('data:')) {
        const ext = /^data:image\/(\w+)/.exec(ref)?.[1] ?? 'png';
        rel = await pool.store(decodeContent(ref), `${fallbackName}.${ext === 'jpeg' ? 'jpg' : ext}`);
      } else {
        rel = await pool.store(await readFile(join(htmlDir, ref)), basename(ref));
      }
    } catch {
      warnings.push(`missing asset ${ref.slice(0, 80)}`);
    }
    assetCache.set(ref, rel);
    return rel;
  };

  const layers: Layer[] = [];
  let assetIdx = 0;
  for (const xl of comp.layers) {
    const element = await convertElement(xl.element, xl.startFrame, warnings, (ref) => storeAsset(ref, `asset${assetIdx++}`));
    const layer: Layer = {
      id: xl.id,
      name: xl.name ?? xl.element.key ?? xl.element.type.toLowerCase(),
      startFrame: xl.startFrame,
      duration: xl.duration,
      element,
    };
    if (xl.isGuide) layer.isGuide = true;
    if (xl.isVisible === false) layer.hidden = true;
    const masks: SceneElement[] = [];
    for (const ml of xl.maskLayers ?? []) {
      masks.push(await convertElement(ml.element, ml.startFrame, warnings, (ref) => storeAsset(ref, `asset${assetIdx++}`)));
    }
    if (masks.length > 0) layer.masks = masks;
    layers.push(layer);
  }

  // markers: outroFrame + pause pushes hidden in the composition action
  const markers: Marker[] = [];
  let action = comp.compositionAction?.__src ?? '';
  action = extractFunctionBody(action);
  // matches optional comma/semicolon chaining and the `this.` prefix so the
  // removal never leaves dangling tokens in minified comma-chained code
  const pausePushRe = /[,;]?\s*(?:this\.)?frameActions\.push\(new FrameAction\((\d+)\s*,\s*\(?function\s*\(\)\s*\{\s*this\.pause\(\)\s*\}\s*\)?\)\)[;,]?/g;
  for (const m of action.matchAll(pausePushRe)) markers.push({ frame: Number(m[1]), type: 'pause' });
  action = action.replace(pausePushRe, ';').trim();
  if (comp.outroFrame !== undefined) markers.push({ frame: comp.outroFrame, type: 'outro' });
  markers.sort((a, b) => a.frame - b.frame);

  const scene: SceneDoc = {
    formatVersion: SCENE_FORMAT_VERSION,
    name,
    composition: {
      width: 1920,
      height: 1080,
      fps: comp.fps ?? 30,
      duration: comp.duration,
      markers,
      layers,
    },
  };
  if (action !== '') scene.composition.action = action;

  // Loopic show/hide + redirect scripts become data (visibility bindings)
  const { migrateSceneScripts, restructureHoldLayers } = await import('./migrate-scripts.ts');
  for (const step of [migrateSceneScripts(scene), restructureHoldLayers(scene)]) {
    warnings.push(...step.notes.map((n) => `migrate: ${n}`));
  }

  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(join(setDir, 'scenes'), { recursive: true });
  const file = `scenes/${name}.json`;
  await writeFile(join(setDir, file), JSON.stringify(scene, null, 2) + '\n', 'utf8');

  // register in set.json
  const setPath = join(setDir, 'set.json');
  const set = JSON.parse(await readFile(setPath, 'utf8')) as { scenes: string[] };
  if (!set.scenes.includes(file)) set.scenes.push(file);
  await writeFile(setPath, JSON.stringify(set, null, 2) + '\n', 'utf8');

  // hand-added custom scripts (after the loopic runtime) need manual porting
  const customScripts = findCustomScripts(html);

  return { scene: file, warnings, customScripts, assetReport: pool.report };
}

// ---- composition extraction --------------------------------------------------

function evalComposition(html: string): XComposition {
  const marker = 'mainComposition=new Composition(';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('mainComposition not found — not a Loopic export?');
  const exprStart = start + 'mainComposition='.length;
  const expr = html.slice(exprStart, scanBalanced(html, start + marker.length - 1) + 1);

  // stubs must be constructible (`new X(...)`) — regular functions returning
  // an object (which overrides `this` under `new`), NOT arrow functions
  const identity = function (o: Record<string, unknown>) { return o; };
  // elements take (styleObj, extrasObj) — merge both
  const element = function (a: Record<string, unknown>, b?: Record<string, unknown>) { return { ...a, ...b }; };
  // ColorProperty wraps a Property — flatten to an XProp with unit 'color'
  const colorProp = function (o: { color?: { value?: unknown; keyframes?: unknown[] } }) {
    return { unit: 'color', value: o?.color?.value, keyframes: o?.color?.keyframes ?? [] };
  };
  const fontFace = function (family: string, src: string) { return { __font: family, src }; };
  const compAction = function (f: () => void) { return { __src: f.toString() }; };
  const frameAction = function (frame: number, f: () => void) { return { __frame: frame, __src: f.toString() }; };
  const fn = new Function(
    'Composition', 'Layer', 'MaskLayer', 'Property', 'ColorProperty', 'FontFace',
    'CompositionAction', 'FrameAction',
    'TextElement', 'ImageElement', 'ImageSequenceElement', 'ImageLoaderElement',
    'RectangleElement', 'EllipseElement', 'PathElement', 'CompositionElement', 'ImageSequence',
    `"use strict"; return ${expr};`,
  );
  return fn(
    identity, identity, identity, identity, colorProp, fontFace, compAction, frameAction,
    element, element, element, element, element, element, element, element, element,
  ) as XComposition;
}

/** Index of the paren matching text[open]; skips string literals. */
export function scanBalanced(text: string, open: number): number {
  let depth = 0;
  let str: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (str) {
      if (c === '\\') i++;
      else if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') str = c;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced composition expression');
}

function extractFunctionBody(src: string): string {
  const open = src.indexOf('{');
  const close = src.lastIndexOf('}');
  return open >= 0 && close > open ? src.slice(open + 1, close).trim() : src.trim();
}

function findCustomScripts(html: string): string[] {
  const out: string[] = [];
  const runtimeEnd = html.indexOf('mainComposition=new Composition(');
  const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
  for (const m of html.matchAll(re)) {
    if (m.index! > runtimeEnd && !m[1]!.includes('mainComposition=new Composition(') && m[1]!.trim().length > 0) {
      out.push(m[1]!.trim());
    }
  }
  return out;
}

// ---- element conversion --------------------------------------------------

const GEOM_DEFAULTS: Record<string, number> = { rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 };
const PASSTHROUGH = [
  'fontSize', 'letterSpacing', 'lineHeight', 'color', 'backgroundColor', 'borderRadius',
  'filterOpacity', 'filterBlur', 'filterBrightness', 'filterContrast', 'filterGrayscale',
  'filterHueRotate', 'filterInvert', 'filterSaturate', 'filterSepia',
];
const PASSTHROUGH_DEFAULTS: Record<string, unknown> = {
  letterSpacing: 0, lineHeight: 1.2, borderRadius: 0,
  filterOpacity: 1, filterBlur: 0, filterBrightness: 1, filterContrast: 1,
  filterGrayscale: 0, filterHueRotate: 0, filterInvert: 0, filterSaturate: 1, filterSepia: 0,
};

async function convertElement(
  x: XElement,
  frameOffset: number,
  warnings: string[],
  storeAsset: (ref: string) => Promise<string>,
): Promise<SceneElement> {
  const s = (x.style ?? {}) as Record<string, XProp | { x?: number; y?: number } | undefined>;
  const origin = x.transformOrigin ?? (s['transformOrigin'] as { x?: number; y?: number } | undefined) ?? {};
  const style: ElementStyle = {
    x: shift(prop(s['x'] as XProp, frameOffset), -(origin.x ?? 0)),
    y: shift(prop(s['y'] as XProp, frameOffset), -(origin.y ?? 0)),
  };
  for (const g of ['width', 'height'] as const) {
    if (s[g]) style[g] = prop(s[g] as XProp, frameOffset);
  }
  for (const [g, def] of Object.entries(GEOM_DEFAULTS)) {
    if (meaningful(s[g] as XProp, def)) style[g] = prop(s[g] as XProp, frameOffset);
  }
  for (const p of PASSTHROUGH) {
    if (meaningful(s[p] as XProp, PASSTHROUGH_DEFAULTS[p])) style[p] = prop(s[p] as XProp, frameOffset);
  }
  // drop shadow (all elements) / text shadow (texts) → shadow* props
  const shadowSets: [string, string, string, string][] = [
    ['dropShadowX', 'dropShadowY', 'dropShadowBlur', 'dropShadowColor'],
    ['textShadowShiftRight', 'textShadowShiftBottom', 'textShadowBlur', 'textShadowColor'],
  ];
  for (const [sx, sy, sb, sc] of shadowSets) {
    if (meaningful(s[sx] as XProp, 0) || meaningful(s[sy] as XProp, 0) || meaningful(s[sb] as XProp, 0)) {
      style['shadowX'] = prop(s[sx] as XProp, frameOffset);
      style['shadowY'] = prop(s[sy] as XProp, frameOffset);
      style['shadowBlur'] = prop(s[sb] as XProp, frameOffset);
      const c = (s[sc] as XProp | undefined)?.value;
      if (c) style['shadowColor'] = { value: String(c) };
    }
  }

  const base = { id: x.id, style } as { id: string; key?: string; style: ElementStyle };
  if (x.key) base.key = x.key;
  const str = (n: string): string | undefined => {
    const v = (s[n] as XProp | undefined)?.value;
    return v == null ? undefined : String(v);
  };

  switch (x.type) {
    case 'TEXT': {
      const el: TextElement = { ...base, type: 'text', content: x.content ?? '' };
      el.fontFamily = str('fontFamily') ?? 'sans-serif';
      const w = str('fontWeight');
      if (w && w !== 'normal') el.fontWeight = w;
      const fs = str('fontStyle');
      if (fs && fs !== 'normal') el.fontStyle = fs;
      const al = str('textAlign');
      if (al) el.textAlign = al as TextElement['textAlign'];
      const va = str('verticalTextAlign');
      if (va) el.verticalAlign = va === 'center' ? 'middle' : (va as TextElement['verticalAlign']);
      const tt = str('textTransform');
      if (tt && tt !== 'none') el.textTransform = tt;
      const pads = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map((n) => {
        const v = (s[n] as XProp | undefined)?.value;
        return typeof v === 'number' ? v : 0;
      });
      if (pads.some((p) => p !== 0)) el.padding = pads as [number, number, number, number];
      if (x.autoSize) el.autoSize = true;
      if (x.autoSqueeze) el.autoSqueeze = true;
      if (x.multiline) el.multiline = true;
      return el;
    }
    case 'IMAGE': {
      const ref = x.src ?? x.content; // export: {content: "<path or data uri>"}
      return { ...base, type: 'image', asset: ref ? await storeAsset(ref) : '' };
    }
    case 'IMAGE_SEQUENCE': {
      const frames: string[] = [];
      for (const ref of x.imageSequence ?? x.images ?? []) frames.push(await storeAsset(ref));
      return { ...base, type: 'imageSequence', frames };
    }
    case 'IMAGE_LOADER': {
      const fit = (x.size ?? 'contain').toLowerCase();
      const map: Record<string, 'original' | 'contain' | 'cover' | 'stretch' | 'fitWidth' | 'fitHeight'> = {
        original: 'original', contain: 'contain', cover: 'cover', stretch: 'stretch',
        fitwidth: 'fitWidth', fitheight: 'fitHeight',
      };
      return { ...base, type: 'imageLoader', fit: map[fit] ?? 'contain' };
    }
    case 'RECTANGLE':
      return { ...base, type: 'rectangle' };
    case 'ELLIPSE':
      return { ...base, type: 'ellipse' };
    default:
      warnings.push(`unsupported element type ${x.type} — placeholder`);
      return { ...base, type: 'rectangle' };
  }
}

function prop(p: XProp | undefined, frameOffset: number): StyleProperty {
  if (!p) return { value: 0 };
  const out: StyleProperty = { value: (p.value as StyleProperty['value']) ?? 0 };
  const kfs = p.keyframes ?? [];
  if (kfs.length > 0) {
    out.keyframes = kfs
      .map((k): Keyframe => {
        const kf: Keyframe = {
          frame: k.frame + frameOffset,
          value: (k._value ?? k.value) as Keyframe['value'],
        };
        if (k.easing && !(k.easing.p1x === k.easing.p1y && k.easing.p2x === k.easing.p2y)) kf.easing = k.easing;
        return kf;
      })
      .sort((a, b) => a.frame - b.frame);
  }
  return out;
}

function shift(p: StyleProperty, delta: number): StyleProperty {
  if (delta === 0) return p;
  if (typeof p.value === 'number') p.value += delta;
  for (const k of p.keyframes ?? []) if (typeof k.value === 'number') k.value += delta;
  return p;
}

function meaningful(p: XProp | undefined, def: unknown): boolean {
  if (!p) return false;
  if ((p.keyframes?.length ?? 0) > 0) return true;
  return p.value !== undefined && p.value !== def;
}

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*\s]/g, '_');
}
