/**
 * DOM renderer: builds the element tree for a scene and applies per-frame
 * style state. Rendering is plain DOM+CSS — exactly what CasparCG's CEF
 * renders, so editor preview and on-air output cannot diverge.
 *
 * Conventions carried over from Loopic for import fidelity:
 * - x/y are the element box CENTER (implemented via translate(-50%,-50%),
 *   which also handles auto-sized text).
 * - masks clip the layer's element; mask x/y/width/height are animatable.
 */

import type {
  Composition,
  ElementStyle,
  Layer,
  SceneDoc,
  SceneElement,
  StyleProperty,
} from '@riposte/shared';
import { numberAtFrame, valueAtFrame } from './interpolate.ts';

export interface BuildOptions {
  /** Prefix for asset paths in the scene (default: '' = relative to the page). */
  assetBase?: string;
  /** Render guide layers (editor preview); default false (on-air). */
  showGuides?: boolean;
  /**
   * Component scene docs by set-relative file (e.g. "scenes/nest.json") —
   * targets of CompositionElement. Provided by the host (bench/editor/export).
   */
  components?: Record<string, SceneDoc | null | undefined>;
  /** Internal recursion guard for nested compositions. */
  nestingDepth?: number;
}

export interface ElementHandle {
  readonly id: string;
  readonly key: string | undefined;
  readonly type: string;
  readonly node: HTMLElement;
  /** Loopic API alias for `node` — imported scripts use element.domNode. */
  readonly domNode: HTMLElement;
  /** Text elements: set content (HTML allowed, Loopic setContent parity). */
  setContent(html: string): void;
  /** Image loaders: point at a new image URL/path. */
  setImage(url: string): void;
}

export interface LayerHandle {
  /** The scene-doc layer (live object — read for matching, mutate with care). */
  readonly doc: Layer;
  /** The layer wrapper div — transforms here move element AND masks together. */
  readonly node: HTMLElement;
}

export interface BuiltScene {
  readonly rootEl: HTMLElement;
  readonly byKey: Map<string, ElementHandle>;
  /** Every element (keyed or not) by element id — editor hit-testing/drag. */
  readonly byId: Map<string, ElementHandle>;
  /** Built layers in paint order — custom-code relayout (see Schedule). */
  readonly layers: LayerHandle[];
  setFrame(frame: number): void;
  show(): void;
  hide(): void;
  readonly isVisible: () => boolean;
  destroy(): void;
}

interface DynamicBinding {
  apply(frame: number): void;
}

const SQUEEZE_ORIGIN: Record<string, string> = { left: 'left center', center: 'center center', right: 'right center' };

export function buildScene(scene: SceneDoc, root: HTMLElement, opts: BuildOptions = {}): BuiltScene {
  const comp = scene.composition;
  const assetBase = opts.assetBase ?? '';

  const rootEl = document.createElement('div');
  rootEl.className = 'riposte-comp';
  Object.assign(rootEl.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: `${comp.width}px`,
    height: `${comp.height}px`,
    overflow: 'hidden',
    visibility: 'hidden',
  });
  root.appendChild(rootEl);

  const byKey = new Map<string, ElementHandle>();
  const byId = new Map<string, ElementHandle>();
  const layers: LayerHandle[] = [];
  const dynamics: DynamicBinding[] = [];

  for (const layer of comp.layers) {
    if (layer.isGuide && !opts.showGuides) continue;
    const node = buildLayer(layer, comp, rootEl, assetBase, byKey, byId, dynamics, opts);
    layers.push({ doc: layer, node });
  }

  let visible = false;
  return {
    rootEl,
    byKey,
    byId,
    layers,
    setFrame(frame) {
      for (const d of dynamics) d.apply(frame);
    },
    show() {
      visible = true;
      rootEl.style.visibility = 'visible';
    },
    hide() {
      visible = false;
      rootEl.style.visibility = 'hidden';
    },
    isVisible: () => visible,
    destroy() {
      rootEl.remove();
    },
  };
}

function buildLayer(
  layer: Layer,
  comp: Composition,
  rootEl: HTMLElement,
  assetBase: string,
  byKey: Map<string, ElementHandle>,
  byId: Map<string, ElementHandle>,
  dynamics: DynamicBinding[],
  opts: BuildOptions,
): HTMLElement {
  const layerEl = document.createElement('div');
  layerEl.dataset['layer'] = layer.name;
  Object.assign(layerEl.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: `${comp.width}px`,
    height: `${comp.height}px`,
    opacity: layer.isGuide ? '0.5' : '',
  });
  rootEl.appendChild(layerEl);

  if (layer.hidden) {
    layerEl.style.display = 'none';
  } else {
    // Layer in/out visibility over time
    const start = layer.startFrame;
    const end = layer.startFrame + layer.duration;
    dynamics.push({
      apply(frame) {
        layerEl.style.display = frame >= start && frame < end ? '' : 'none';
      },
    });
  }

  // Masks: each mask nests a clipping wrapper + inverse-offset inner div so
  // the element keeps composition-space coordinates.
  let parent: HTMLElement = layerEl;
  for (const mask of layer.masks ?? []) {
    parent = buildMask(mask, parent, dynamics);
  }

  const handle = buildElement(layer.element, comp, layer, parent, assetBase, dynamics, opts, byKey);
  if (handle) {
    byId.set(layer.element.id, handle);
    if (layer.element.key) byKey.set(layer.element.key, handle);
  }
  return layerEl;
}

function buildMask(mask: SceneElement, parent: HTMLElement, dynamics: DynamicBinding[]): HTMLElement {
  const wrap = document.createElement('div');
  const inner = document.createElement('div');
  Object.assign(wrap.style, { position: 'absolute', overflow: 'hidden', left: '0', top: '0' });
  Object.assign(inner.style, { position: 'absolute', left: '0', top: '0' });
  wrap.appendChild(inner);
  parent.appendChild(wrap);

  if (mask.type === 'path') {
    // Static path mask via clip-path; geometry animation not supported yet.
    wrap.style.width = '100%';
    wrap.style.height = '100%';
    wrap.style.clipPath = `path('${mask.d}')`;
    return inner;
  }

  const s = mask.style;
  const apply = (frame: number) => {
    const w = numberAtFrame(s.width, frame, 0);
    const h = numberAtFrame(s.height, frame, 0);
    const left = numberAtFrame(s.x, frame, 0) - w / 2;
    const top = numberAtFrame(s.y, frame, 0) - h / 2;
    wrap.style.transform = `translate(${left}px, ${top}px)`;
    wrap.style.width = `${w}px`;
    wrap.style.height = `${h}px`;
    inner.style.transform = `translate(${-left}px, ${-top}px)`;
  };
  if (hasAnimatedGeometry(s)) dynamics.push({ apply });
  else apply(0);
  return inner;
}

function hasAnimatedGeometry(s: ElementStyle): boolean {
  return GEOMETRY_PROPS.some((p) => (s[p]?.keyframes?.length ?? 0) > 0);
}

const GEOMETRY_PROPS = ['x', 'y', 'width', 'height', 'scaleX', 'scaleY', 'rotation'] as const;

function buildElement(
  el: SceneElement,
  comp: Composition,
  layer: Layer,
  parent: HTMLElement,
  assetBase: string,
  dynamics: DynamicBinding[],
  opts: BuildOptions,
  parentByKey: Map<string, ElementHandle>,
): ElementHandle | null {
  let node: HTMLElement;
  let contentEl: HTMLElement | null = null;
  let img: HTMLImageElement | null = null;
  let squeeze: (() => void) | null = null;

  switch (el.type) {
    case 'text': {
      node = document.createElement('div');
      contentEl = document.createElement('span');
      contentEl.innerHTML = el.content;
      node.appendChild(contentEl);
      Object.assign(node.style, {
        display: 'flex',
        alignItems: el.verticalAlign === 'top' ? 'flex-start' : el.verticalAlign === 'bottom' ? 'flex-end' : 'center',
        justifyContent: el.textAlign === 'left' ? 'flex-start' : el.textAlign === 'right' ? 'flex-end' : 'center',
        whiteSpace: el.multiline ? 'pre-wrap' : 'nowrap',
        textAlign: el.textAlign ?? 'center',
        fontFamily: el.fontFamily ?? 'sans-serif',
        fontWeight: el.fontWeight != null ? String(el.fontWeight) : '',
        fontStyle: el.fontStyle ?? '',
        textTransform: el.textTransform ?? '',
        textDecoration: el.textDecoration ?? '',
        padding: el.padding ? el.padding.map((p) => `${p}px`).join(' ') : '',
      });
      if (el.autoSqueeze && !el.multiline) {
        const align = el.textAlign ?? 'center';
        contentEl.style.transformOrigin = SQUEEZE_ORIGIN[align]!;
        const target = el;
        squeeze = () => {
          const c = contentEl!;
          c.style.transform = '';
          const box = numberAtFrame(target.style.width, 0, 0);
          if (box > 0 && c.scrollWidth > box) {
            c.style.transform = `scaleX(${box / c.scrollWidth})`;
          }
        };
      }
      break;
    }
    case 'image': {
      img = document.createElement('img');
      img.src = assetBase + el.asset;
      img.draggable = false;
      img.style.display = 'block';
      img.style.width = '100%';
      img.style.height = '100%';
      node = document.createElement('div');
      node.appendChild(img);
      break;
    }
    case 'imageSequence': {
      img = document.createElement('img');
      img.draggable = false;
      img.style.display = 'block';
      img.style.width = '100%';
      img.style.height = '100%';
      node = document.createElement('div');
      node.appendChild(img);
      const frames = el.frames.map((f) => assetBase + f);
      for (const f of frames) new Image().src = f; // preload
      let lastIdx = -1;
      const seqImg = img;
      dynamics.push({
        apply(frame) {
          if (frames.length === 0) return;
          const idx = Math.min(Math.max(frame - layer.startFrame, 0), frames.length - 1);
          if (idx !== lastIdx) {
            lastIdx = idx;
            seqImg.src = frames[idx]!;
          }
        },
      });
      break;
    }
    case 'imageLoader': {
      node = document.createElement('div');
      node.style.overflow = 'hidden';
      img = document.createElement('img');
      img.draggable = false;
      if (el.placeholder) img.src = assetBase + el.placeholder;
      else img.style.display = 'none'; // hidden until first setImage
      applyFit(img, el.fit);
      node.appendChild(img);
      break;
    }
    case 'rectangle': {
      node = document.createElement('div');
      node.style.background = el.fill ?? 'transparent';
      if (el.borderRadius) {
        const br = el.borderRadius;
        if (br.keyframes?.length) {
          dynamics.push({ apply: (f) => (node.style.borderRadius = `${numberAtFrame(br, f, 0)}px`) });
        } else {
          node.style.borderRadius = `${Number(br.value) || 0}px`;
        }
      }
      break;
    }
    case 'ellipse': {
      node = document.createElement('div');
      node.style.background = el.fill ?? 'transparent';
      node.style.borderRadius = '50%';
      break;
    }
    case 'path': {
      node = document.createElement('div');
      const svgNs = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNs, 'svg');
      svg.setAttribute('width', String(comp.width));
      svg.setAttribute('height', String(comp.height));
      svg.setAttribute('viewBox', `0 0 ${comp.width} ${comp.height}`);
      const path = document.createElementNS(svgNs, 'path');
      path.setAttribute('d', el.d);
      path.setAttribute('fill', el.fill ?? 'none');
      if (el.stroke) path.setAttribute('stroke', el.stroke);
      if (el.strokeWidth) path.setAttribute('stroke-width', String(el.strokeWidth));
      svg.appendChild(path);
      node.appendChild(svg);
      break;
    }
    case 'composition': {
      const depth = opts.nestingDepth ?? 0;
      const doc = opts.components?.[el.compositionId];
      node = document.createElement('div');
      if (!doc || depth >= 4) {
        console.warn(`riposte: component "${el.compositionId}" ${doc ? 'nested too deep' : 'not provided'} — skipped`);
        break;
      }
      const sub = buildScene(doc, node, { ...opts, nestingDepth: depth + 1 });
      sub.rootEl.style.visibility = 'visible';
      node.style.width = `${doc.composition.width}px`;
      node.style.height = `${doc.composition.height}px`;
      const subLast = doc.composition.duration - 1;
      const start = layer.startFrame;
      // Child timeline follows the parent playhead (detachPlayhead pending).
      dynamics.push({
        apply(frame) {
          sub.setFrame(Math.min(Math.max(frame - start, 0), subLast));
        },
      });
      // Loopic data convention: nested keys addressed as "_comp._key"
      if (el.key) {
        for (const [k, h] of sub.byKey) parentByKey.set(`${el.key}.${k}`, h);
      }
      break;
    }
    default: {
      console.warn(`riposte: unknown element type "${(el as { type: string }).type}" — skipped`);
      return null;
    }
  }

  node.dataset['element'] = el.id;
  if (el.key) node.dataset['key'] = el.key;
  node.style.position = 'absolute';
  node.style.left = '0';
  node.style.top = '0';
  parent.appendChild(node);

  bindStyle(el, node, dynamics);
  if (squeeze) requestAnimationFrame(squeeze);

  const loaderImg = img;
  const contentTarget = contentEl;
  return {
    id: el.id,
    key: el.key,
    type: el.type,
    node,
    domNode: node,
    setContent(html) {
      if (contentTarget) {
        contentTarget.innerHTML = html;
        if (squeeze) squeeze();
      }
    },
    setImage(url) {
      if (loaderImg) {
        loaderImg.style.display = url ? 'block' : 'none';
        loaderImg.src = url;
      }
    },
  };
}

function applyFit(img: HTMLImageElement, fit: string): void {
  img.style.width = '100%';
  img.style.height = '100%';
  switch (fit) {
    case 'original':
      img.style.width = 'auto';
      img.style.height = 'auto';
      break;
    case 'contain':
      img.style.objectFit = 'contain';
      break;
    case 'cover':
      img.style.objectFit = 'cover';
      break;
    case 'stretch':
      img.style.objectFit = 'fill';
      break;
    case 'fitWidth':
      img.style.height = 'auto';
      break;
    case 'fitHeight':
      img.style.width = 'auto';
      break;
  }
}

/** CSS mapping for non-geometry style props applied directly. */
const CSS_PROPS: Record<string, { css: string; px?: boolean }> = {
  opacity: { css: 'opacity' },
  fontSize: { css: 'fontSize', px: true },
  color: { css: 'color' },
  backgroundColor: { css: 'backgroundColor' },
  letterSpacing: { css: 'letterSpacing', px: true },
  lineHeight: { css: 'lineHeight' }, // unitless multiplier (Loopic semantics)
  borderRadius: { css: 'borderRadius', px: true },
};

/** Style props composed into the CSS `filter` string. [css function, default, unit] */
const FILTER_PROPS: Record<string, { fn: string; def: number; unit: string }> = {
  filterBlur: { fn: 'blur', def: 0, unit: 'px' },
  filterBrightness: { fn: 'brightness', def: 1, unit: '' },
  filterContrast: { fn: 'contrast', def: 1, unit: '' },
  filterGrayscale: { fn: 'grayscale', def: 0, unit: '' },
  filterHueRotate: { fn: 'hue-rotate', def: 0, unit: 'deg' },
  filterInvert: { fn: 'invert', def: 0, unit: '' },
  filterOpacity: { fn: 'opacity', def: 1, unit: '' },
  filterSaturate: { fn: 'saturate', def: 1, unit: '' },
  filterSepia: { fn: 'sepia', def: 0, unit: '' },
};

/** Drop-shadow / text-shadow style props (importer emits shadowX/Y/Blur/Color). */
const SHADOW_PROPS = ['shadowX', 'shadowY', 'shadowBlur', 'shadowColor'] as const;

function bindStyle(el: SceneElement, node: HTMLElement, dynamics: DynamicBinding[]): void {
  const s = el.style;
  const autoSized = el.type === 'text' && el.autoSize;

  const applyGeometry = (frame: number) => {
    const x = numberAtFrame(s.x, frame, 0);
    const y = numberAtFrame(s.y, frame, 0);
    const sx = numberAtFrame(s.scaleX, frame, 1);
    const sy = numberAtFrame(s.scaleY, frame, 1);
    const rot = numberAtFrame(s.rotation, frame, 0);
    if (!autoSized) {
      if (s.width) node.style.width = `${numberAtFrame(s.width, frame, 0)}px`;
      if (s.height) node.style.height = `${numberAtFrame(s.height, frame, 0)}px`;
    }
    // translate to center point, center self, then rotate/scale about center
    node.style.transform =
      `translate(${x}px, ${y}px) translate(-50%, -50%)` +
      (rot ? ` rotate(${rot}deg)` : '') +
      (sx !== 1 || sy !== 1 ? ` scale(${sx}, ${sy})` : '');
  };

  if (hasAnimatedGeometry(s)) dynamics.push({ apply: applyGeometry });
  else applyGeometry(0);

  for (const [prop, def] of Object.entries(CSS_PROPS)) {
    const sp: StyleProperty | undefined = s[prop];
    if (!sp) continue;
    const style = node.style as unknown as Record<string, string>;
    const apply = (frame: number) => {
      const v = valueAtFrame(sp, frame);
      style[def.css] = def.px && typeof v === 'number' ? `${v}px` : String(v);
    };
    if (sp.keyframes?.length) dynamics.push({ apply });
    else apply(0);
  }

  // CSS filter chain — only bound when any filter prop is present.
  const filterKeys = Object.keys(FILTER_PROPS).filter((k) => s[k]);
  if (filterKeys.length > 0) {
    const applyFilters = (frame: number) => {
      const parts: string[] = [];
      for (const k of filterKeys) {
        const def = FILTER_PROPS[k]!;
        const v = numberAtFrame(s[k], frame, def.def);
        if (v !== def.def) parts.push(`${def.fn}(${v}${def.unit})`);
      }
      node.style.filter = parts.join(' ');
    };
    if (filterKeys.some((k) => s[k]?.keyframes?.length)) dynamics.push({ apply: applyFilters });
    else applyFilters(0);
  }

  // Drop shadow (text elements get text-shadow, others a drop-shadow filter
  // appended after the filter chain — beware ordering if both animate).
  if (SHADOW_PROPS.some((k) => s[k])) {
    const applyShadow = (frame: number) => {
      const x = numberAtFrame(s['shadowX'], frame, 0);
      const y = numberAtFrame(s['shadowY'], frame, 0);
      const blur = numberAtFrame(s['shadowBlur'], frame, 0);
      const color = s['shadowColor'] ? String(valueAtFrame(s['shadowColor'], frame)) : '#000';
      const css = x || y || blur ? `${x}px ${y}px ${blur}px ${color}` : '';
      if (el.type === 'text') {
        node.style.textShadow = css;
      } else {
        const base = node.style.filter.replace(/ ?drop-shadow\([^)]*\)/, '');
        node.style.filter = css ? `${base} drop-shadow(${css})`.trim() : base;
      }
    };
    if (SHADOW_PROPS.some((k) => s[k]?.keyframes?.length)) dynamics.push({ apply: applyShadow });
    else applyShadow(0);
  }
}
