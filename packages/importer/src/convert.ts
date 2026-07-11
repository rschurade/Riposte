/**
 * Pure translation: Loopic composition → Riposte scene document.
 * Asset resolution is delegated to a callback so this stays testable
 * without touching the filesystem.
 */

import type {
  Composition,
  Layer,
  Marker,
  SceneDoc,
  SceneElement,
  ElementStyle,
  StyleProperty,
  Keyframe,
  StyleValue,
  TextElement,
} from '@riposte/shared';
import { SCENE_FORMAT_VERSION } from '@riposte/shared';
import type {
  LooColorProperty,
  LooComposition,
  LooElement,
  LooLayer,
  LooProperty,
} from './loo-format.ts';

/** Resolves a Loopic resource reference to a set-relative asset path. */
export interface AssetResolver {
  image(resourceId: string): Promise<string>;
  sequenceFrames(resourceId: string, imageIds: string[]): Promise<string[]>;
}

export interface ConvertWarnings {
  warnings: string[];
}

const PAUSE_RE = /^\s*this\.pause\(\)\s*;?\s*$/;

export async function convertComposition(
  loo: LooComposition,
  resolve: AssetResolver,
): Promise<{ scene: SceneDoc; warnings: string[] }> {
  const warnings: string[] = [];
  const ctx: Ctx = { resolve, warnings };

  const markers: Marker[] = [];
  for (const action of loo.actions ?? []) {
    if (PAUSE_RE.test(action.code)) {
      markers.push({ frame: action.frame, type: 'pause' });
    } else if (action.code.trim() !== '') {
      markers.push({ frame: action.frame, type: 'action', source: action.code });
    }
    if (action.asOutro) markers.push({ frame: action.frame, type: 'outro' });
  }
  markers.sort((a, b) => a.frame - b.frame);

  // Loopic layers are bottom-first (its runtime appends DOM in array order)
  // — same convention as the Riposte format, so order is preserved.
  const layers: Layer[] = [];
  for (const looLayer of loo.layers) {
    layers.push(await convertLayer(looLayer, ctx));
  }

  const composition: Composition = {
    width: loo.width,
    height: loo.height,
    fps: loo.fps,
    // workspaceDuration is the REAL length (verified against the HTML export)
    duration: loo.workspaceDuration ?? loo.duration,
    markers,
    layers,
  };
  if (loo.compositionAction && loo.compositionAction.trim() !== '') {
    composition.action = loo.compositionAction;
  }

  return {
    scene: { formatVersion: SCENE_FORMAT_VERSION, name: loo.name, composition },
    warnings,
  };
}

interface Ctx {
  resolve: AssetResolver;
  warnings: string[];
}

async function convertLayer(loo: LooLayer, ctx: Ctx): Promise<Layer> {
  // Loopic keyframe frames are LAYER-LOCAL; the Riposte format is
  // composition-global — offset by the layer's startFrame on import.
  const element = await convertElement(loo.element, ctx, loo.name, loo.startFrame);
  const layer: Layer = {
    id: loo.id,
    name: loo.name,
    startFrame: loo.startFrame,
    duration: loo.duration,
    element,
  };
  if (loo.isGuide) layer.isGuide = true;
  if (loo.isVisible === false) layer.hidden = true;

  const masks: SceneElement[] = [];
  for (const maskLayer of loo.maskLayers ?? []) {
    masks.push(await convertElement(maskLayer.element, ctx, `${loo.name}/mask`, maskLayer.startFrame));
  }
  if (masks.length > 0) layer.masks = masks;
  return layer;
}

async function convertElement(loo: LooElement, ctx: Ctx, where: string, frameOffset: number): Promise<SceneElement> {
  const style = convertStyle(loo, ctx, where, frameOffset);
  const base = { id: loo.id, style } as { id: string; key?: string; style: ElementStyle };
  if (loo.key) base.key = loo.key;

  switch (loo.type) {
    case 'TEXT': {
      const el: TextElement = {
        ...base,
        type: 'text',
        content: loo.content ?? '',
      };
      applyTextProperties(el, loo, style, frameOffset);
      if (loo.autoSize) el.autoSize = true;
      if (loo.autoSqueeze) el.autoSqueeze = true;
      if (loo.multiline) el.multiline = true;
      return el;
    }
    case 'IMAGE': {
      const asset = loo.imageResourceId ? await ctx.resolve.image(loo.imageResourceId) : '';
      if (!asset) ctx.warnings.push(`${where}: IMAGE without resolvable resource`);
      return { ...base, type: 'image', asset };
    }
    case 'IMAGE_SEQUENCE': {
      const frames =
        loo.imageSequenceResourceId && loo.imageIds
          ? await ctx.resolve.sequenceFrames(loo.imageSequenceResourceId, loo.imageIds)
          : [];
      if (frames.length === 0) ctx.warnings.push(`${where}: IMAGE_SEQUENCE without frames`);
      return { ...base, type: 'imageSequence', frames };
    }
    case 'IMAGE_LOADER':
      return { ...base, type: 'imageLoader', fit: mapFit(loo.size, ctx, where) };
    case 'RECTANGLE': {
      applyShapeFill(loo, style, ctx, where);
      return { ...base, type: 'rectangle' };
    }
    case 'ELLIPSE': {
      applyShapeFill(loo, style, ctx, where);
      return { ...base, type: 'ellipse' };
    }
    default:
      ctx.warnings.push(`${where}: unsupported element type ${loo.type} — imported as hidden placeholder`);
      return { ...base, type: 'rectangle' };
  }
}

const FIT_MAP: Record<string, 'original' | 'contain' | 'cover' | 'stretch' | 'fitWidth' | 'fitHeight'> = {
  original: 'original',
  contain: 'contain',
  cover: 'cover',
  stretch: 'stretch',
  fitwidth: 'fitWidth',
  fitheight: 'fitHeight',
  fit_width: 'fitWidth',
  fit_height: 'fitHeight',
};

function mapFit(size: string | undefined, ctx: Ctx, where: string): 'original' | 'contain' | 'cover' | 'stretch' | 'fitWidth' | 'fitHeight' {
  if (!size) return 'contain';
  const mapped = FIT_MAP[size.toLowerCase()];
  if (!mapped) {
    ctx.warnings.push(`${where}: unknown IMAGE_LOADER size "${size}" — using contain`);
    return 'contain';
  }
  return mapped;
}

// ---- style conversion -------------------------------------------------------

const FILTER_DEFAULTS: Record<string, number> = {
  blur: 0,
  brightness: 1,
  contrast: 1,
  grayscale: 0,
  hueRotate: 0,
  invert: 0,
  opacity: 1,
  saturate: 1,
  sepia: 0,
};

const FILTER_TARGET: Record<string, string> = {
  blur: 'filterBlur',
  brightness: 'filterBrightness',
  contrast: 'filterContrast',
  grayscale: 'filterGrayscale',
  hueRotate: 'filterHueRotate',
  invert: 'filterInvert',
  opacity: 'filterOpacity',
  saturate: 'filterSaturate',
  sepia: 'filterSepia',
};

function convertStyle(loo: LooElement, ctx: Ctx, where: string, off: number): ElementStyle {
  const t = loo.transformProperties ?? {};
  // Loopic x/y is the position of the transform-origin (anchor) point;
  // origin x/y is the anchor's offset from the element CENTER. Riposte x/y
  // is always the center, so shift by -origin on import.
  const ox = numberValue(loo.transformOrigin?.x, 0);
  const oy = numberValue(loo.transformOrigin?.y, 0);
  const style: ElementStyle = {
    x: shiftProp(prop(t['x'], 0, off), -ox),
    y: shiftProp(prop(t['y'], 0, off), -oy),
  };
  if (isMeaningful(t['rotation'], 0)) style.rotation = prop(t['rotation'], 0, off);
  if (isMeaningful(t['scaleX'], 1)) style.scaleX = prop(t['scaleX'], 1, off);
  if (isMeaningful(t['scaleY'], 1)) style.scaleY = prop(t['scaleY'], 1, off);
  if (isMeaningful(t['opacity'], 1)) style.opacity = prop(t['opacity'], 1, off);

  const s = loo.sizeProperties ?? {};
  if (s['width']) style.width = prop(s['width'], 0, off);
  if (s['height']) style.height = prop(s['height'], 0, off);

  for (const [name, p] of Object.entries(loo.filterProperties ?? {})) {
    const def = FILTER_DEFAULTS[name];
    const target = FILTER_TARGET[name];
    if (def === undefined || !target) continue;
    if (isMeaningful(p, def)) style[target] = prop(p, def, off);
  }

  const ds = loo.dropShadowPropertyGroup;
  if (ds && (isMeaningful(ds.x, 0) || isMeaningful(ds.y, 0) || isMeaningful(ds.blur, 0))) {
    style['shadowX'] = prop(ds.x, 0, off);
    style['shadowY'] = prop(ds.y, 0, off);
    style['shadowBlur'] = prop(ds.blur, 0, off);
    const color = colorValue(ds.color);
    if (color) style['shadowColor'] = { value: color };
  }

  const br = loo.borderRadiusProperties;
  if (br && isMeaningful(br['radius'], 0)) {
    style.borderRadius = prop(br['radius'], 0, off);
    for (const corner of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']) {
      if (isMeaningful(br[corner], 0)) {
        ctx.warnings.push(`${where}: per-corner border radius not supported — uniform radius used`);
        break;
      }
    }
  }

  // Position is fully corrected above; rotation/scale still pivot on the
  // center in our runtime, so only warn when that distinction matters.
  if ((ox !== 0 || oy !== 0) && (isMeaningful(t['rotation'], 0) || isMeaningful(t['scaleX'], 1) || isMeaningful(t['scaleY'], 1))) {
    ctx.warnings.push(`${where}: rotation/scale with non-center origin pivots differently`);
  }

  return style;
}

/** Add a constant delta to a property's value and every keyframe value. */
function shiftProp(p: StyleProperty, delta: number): StyleProperty {
  if (delta === 0) return p;
  if (typeof p.value === 'number') p.value += delta;
  for (const k of p.keyframes ?? []) {
    if (typeof k.value === 'number') k.value += delta;
  }
  return p;
}

function applyTextProperties(el: TextElement, loo: LooElement, style: ElementStyle, off: number): void {
  const tp = loo.textProperties ?? {};
  const str = (name: string): string | undefined => {
    const p = tp[name];
    if (!p || !('value' in p)) return undefined;
    const v = (p as LooProperty).value;
    return v == null ? undefined : String(v);
  };

  el.fontFamily = str('fontFamily') ?? 'sans-serif';
  const weight = str('fontWeight');
  if (weight && weight !== 'normal') el.fontWeight = weight;
  const fontStyle = str('fontStyle');
  if (fontStyle && fontStyle !== 'normal') el.fontStyle = fontStyle;
  const align = str('textAlign');
  if (align) el.textAlign = align as TextElement['textAlign'];
  const vAlign = str('verticalTextAlign');
  if (vAlign) el.verticalAlign = vAlign === 'center' ? 'middle' : (vAlign as TextElement['verticalAlign']);
  const transform = str('textTransform');
  if (transform && transform !== 'none') el.textTransform = transform;
  const decoration = str('textDecoration');
  if (decoration && decoration !== 'none') el.textDecoration = decoration;

  const pads = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map((n) =>
    numberValue(tp[n] as LooProperty | undefined, 0),
  );
  if (pads.some((p) => p !== 0)) el.padding = pads as [number, number, number, number];

  if (tp['fontSize']) style['fontSize'] = prop(tp['fontSize'] as LooProperty, 24, off);
  if (isMeaningful(tp['letterSpacing'] as LooProperty, 0)) {
    style['letterSpacing'] = prop(tp['letterSpacing'] as LooProperty, 0, off);
  }
  if (tp['lineHeight'] && isMeaningful(tp['lineHeight'] as LooProperty, 1.2)) {
    style['lineHeight'] = prop(tp['lineHeight'] as LooProperty, 1.2, off);
  }

  const color = colorValue(tp['color'] as LooColorProperty | undefined);
  if (color) style['color'] = { value: color, unit: 'color' };
  const bg = colorValue(tp['backgroundColor'] as LooColorProperty | undefined);
  if (bg && !isTransparent(bg)) style['backgroundColor'] = { value: bg, unit: 'color' };

  const tsh = loo.textShadowProperties;
  if (tsh) {
    const x = numberValue(tsh['x'] as LooProperty | undefined, 0);
    const y = numberValue(tsh['y'] as LooProperty | undefined, 0);
    const blur = numberValue(tsh['blur'] as LooProperty | undefined, 0);
    if (x !== 0 || y !== 0 || blur !== 0) {
      style['shadowX'] = { value: x };
      style['shadowY'] = { value: y };
      style['shadowBlur'] = { value: blur };
      const c = colorValue(tsh['color'] as LooColorProperty | undefined);
      if (c) style['shadowColor'] = { value: c };
    }
  }
}

function applyShapeFill(loo: LooElement, style: ElementStyle, ctx: Ctx, where: string): void {
  const fill = colorValue(loo.pathProperties?.fill);
  if (fill && !isTransparent(fill)) style['backgroundColor'] = { value: fill, unit: 'color' };
  const strokeWidth = numberValue(loo.pathProperties?.strokeWidth, 0);
  if (strokeWidth > 0) ctx.warnings.push(`${where}: shape stroke not supported yet`);
}

// ---- property helpers -------------------------------------------------------

function prop(p: LooProperty | undefined, fallback: StyleValue, frameOffset: number): StyleProperty {
  if (!p) return { value: fallback };
  const out: StyleProperty = { value: (p.value as StyleValue) ?? fallback };
  if (p.keyframes && p.keyframes.length > 0) {
    out.keyframes = [...p.keyframes]
      .sort((a, b) => a.frame - b.frame)
      .map((k): Keyframe => {
        const kf: Keyframe = { frame: k.frame + frameOffset, value: k.value as StyleValue };
        if (k.easing && !isLinear(k.easing)) kf.easing = k.easing;
        return kf;
      });
  }
  return out;
}

function isLinear(e: { p1x: number; p1y: number; p2x: number; p2y: number }): boolean {
  return e.p1x === e.p1y && e.p2x === e.p2y;
}

function isMeaningful(p: LooProperty | undefined, def: number): boolean {
  if (!p) return false;
  if (p.keyframes && p.keyframes.length > 0) return true;
  return typeof p.value === 'number' ? p.value !== def : p.value != null && p.value !== def;
}

function numberValue(p: LooProperty | undefined, fallback: number): number {
  const v = p?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function colorValue(c: LooColorProperty | undefined): string | undefined {
  if (!c) return undefined;
  if (typeof c.color === 'string') return c.color;
  if (c.isGradient) return undefined; // gradients not supported yet
  const v = c.color?.value;
  return v == null ? undefined : String(v);
}

function isTransparent(color: string): boolean {
  const c = color.replace(/\s/g, '').toLowerCase();
  return c === 'transparent' || c === '#ffffff00' || /^#.{6}00$/.test(c) || /,0\)$/.test(c);
}
