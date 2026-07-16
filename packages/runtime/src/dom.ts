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
  RectangleElement,
  SceneDoc,
  SceneElement,
  StyleProperty,
  VisibilityBinding,
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
  /**
   * Show/hide via CSS visibility — independent of the layer's timeline span
   * and keyframed opacity. "Shown" means inherit, so the element still
   * follows the composition's own show()/hide().
   */
  setVisible(visible: boolean): void;
  show(): void;
  hide(): void;
}

export interface LoopTimeState {
  hold: number;
  exiting: boolean;
  exitFrom: number;
}

/**
 * Frame warp for a layer with a loop region (pure — unit tested). Entrance
 * plays through once; [start, end) wraps, with `hold` continuing the cycle
 * while the scene playhead is parked. The cycle never stops — the exit is a
 * fade-in-place applied on the layer wrapper, not a position jump.
 */
export function loopWarp(
  frame: number,
  startFrame: number,
  loop: { start: number; end: number },
  state: LoopTimeState,
): number {
  const ls = startFrame + loop.start;
  const span = loop.end - loop.start;
  const local = frame + state.hold;
  return local < ls ? local : ls + ((local - ls) % span);
}

/** An element whose visibility is driven by an update() key. */
export interface BoundVisibility {
  binding: VisibilityBinding;
  handle: ElementHandle;
  /**
   * Set when the layer is design-time hidden (Loopic isVisible=false): the
   * binding must also lift the wrapper's visibility, since Loopic's hidden
   * is CSS visibility and the old show/hide scripts pierced it (that's how
   * the LiveScore white lights work — hidden layer, shown by data).
   */
  hiddenLayerNode?: HTMLElement;
}

export interface LayerHandle {
  /** The scene-doc layer (live object — read for matching, mutate with care). */
  readonly doc: Layer;
  /** The layer wrapper div — transforms here move element AND masks together. */
  readonly node: HTMLElement;
}

export interface BuiltScene {
  readonly rootEl: HTMLElement;
  /**
   * Everything except design-time guide layers — the target for scene-level
   * outro effects, so editor guides survive the wipe. Guides render directly
   * on rootEl in their natural paint position (backdrop guides below this
   * element, overlay guides above); in exports the two are equivalent.
   */
  readonly contentEl: HTMLElement;
  readonly byKey: Map<string, ElementHandle>;
  /** Every element (keyed or not) by element id — editor hit-testing/drag. */
  readonly byId: Map<string, ElementHandle>;
  /** Built layers in paint order — custom-code relayout (see Schedule). */
  readonly layers: LayerHandle[];
  /** Elements with a visibility binding (nested bindKeys are dot-prefixed). */
  readonly boundVisibility: BoundVisibility[];
  /**
   * Shared clock state for layers with a loop region. `hold` accumulates
   * extra frames while the scene playhead is parked (advanced by the
   * runtime's hold clock); `exiting` latches when the outro starts and maps
   * every loop layer onto its exit zone from `exitFrom` (scene time).
   */
  readonly timeState: LoopTimeState;
  /** True when any top-level layer has a loop region (hold clock needed). */
  readonly hasLoops: boolean;
  /**
   * Re-measure size-bound rectangles against their source text. Run once
   * after build/fonts and after every update() that may change text.
   */
  applySizeBinds(): void;
  setFrame(frame: number): void;
  show(): void;
  hide(): void;
  readonly isVisible: () => boolean;
  destroy(): void;
}

interface DynamicBinding {
  apply(frame: number): void;
}

/** Build-time registry threaded through buildLayer/buildElement. */
interface BuildRegistry {
  /** Text content span + styled node by element id — size-bind measurement targets. */
  textContent: Map<string, { span: HTMLElement; node: HTMLElement }>;
  /** Rectangles with a sizeBind, resolved after all layers are built. */
  sizeBinds: { el: RectangleElement; node: HTMLElement }[];
  /** Nested compositions' own applySizeBinds, re-run with the parent's. */
  nestedSizeBinds: (() => void)[];
}

const SQUEEZE_ORIGIN: Record<string, string> = { left: 'left center', center: 'center center', right: 'right center' };

/**
 * Measure rendered content size with a probe on document.body carrying the
 * element's computed font. NEVER measure via the live element (scrollWidth/
 * offsetWidth): during the ADD→PLAY lifecycle layers with startFrame > 0 are
 * display:none, where every measurement is 0 — that silently disabled the
 * name-squeeze and the digit boxing once.
 */
function measureContent(node: HTMLElement, html: string): { w: number; h: number } {
  const cs = getComputedStyle(node);
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden';
  probe.style.fontFamily = cs.fontFamily;
  probe.style.fontSize = cs.fontSize;
  probe.style.fontWeight = cs.fontWeight;
  probe.style.fontStyle = cs.fontStyle;
  probe.style.letterSpacing = cs.letterSpacing;
  probe.style.textTransform = cs.textTransform;
  probe.style.fontVariantNumeric = cs.fontVariantNumeric;
  probe.style.lineHeight = cs.lineHeight;
  probe.style.whiteSpace = 'pre';
  probe.innerHTML = html;
  document.body.appendChild(probe);
  const size = { w: probe.offsetWidth, h: probe.offsetHeight };
  probe.remove();
  return size;
}

/**
 * Digit boxing — the tabularNums fallback for fonts without the OpenType
 * `tnum` feature (League Spartan: "1" is half as wide as "0"). Every digit
 * is wrapped in a fixed-width inline-block sized to the widest digit (em, so
 * it scales with font size), centered like real tabular figures. Only text
 * OUTSIDE markup tags is transformed, so setContent HTML stays intact.
 */
export function boxDigits(html: string, em: number): string {
  const style = `display:inline-block;width:${em.toFixed(4)}em;text-align:center`;
  return html
    .split(/(<[^>]*>)/)
    .map((part, i) => (i % 2 ? part : part.replace(/[0-9]/g, (d) => `<span style="${style}">${d}</span>`)))
    .join('');
}

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

  // Appended lazily at the FIRST content layer, so backdrop guides (photo
  // references before any content) stay below it and overlay guides (grids
  // after the content) land above it — guide paint order is preserved.
  const contentEl = document.createElement('div');
  Object.assign(contentEl.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%' });

  const byKey = new Map<string, ElementHandle>();
  const byId = new Map<string, ElementHandle>();
  const layers: LayerHandle[] = [];
  const dynamics: DynamicBinding[] = [];
  const boundVisibility: BoundVisibility[] = [];
  const timeState: LoopTimeState = { hold: 0, exiting: false, exitFrom: 0 };
  const registry: BuildRegistry = { textContent: new Map(), sizeBinds: [], nestedSizeBinds: [] };

  for (const layer of comp.layers) {
    if (layer.isGuide && !opts.showGuides) continue;
    if (!layer.isGuide && !contentEl.parentNode) rootEl.appendChild(contentEl);
    const node = buildLayer(layer, comp, layer.isGuide ? rootEl : contentEl, assetBase, byKey, byId, dynamics, boundVisibility, timeState, opts, registry);
    layers.push({ doc: layer, node });
  }
  if (!contentEl.parentNode) rootEl.appendChild(contentEl); // guide-only scene

  // Dynamic size binding: rectangle follows its source text's measured
  // content (body-probe measurement — composition-space px, immune to the
  // layer being display:none mid-lifecycle) plus padding. grow=left/right
  // pins that edge by countering the symmetric width change with a margin
  // shift, leaving the animated transform untouched.
  const sizeAppliers: (() => void)[] = [];
  for (const { el, node } of registry.sizeBinds) {
    const bind = el.sizeBind!;
    const src = registry.textContent.get(bind.sourceId);
    if (!src) {
      console.warn(`riposte: sizeBind source "${bind.sourceId}" is not a text element — ignored`);
      continue;
    }
    const axis = bind.axis ?? 'x';
    const authoredW = Number(el.style.width?.value) || 0;
    sizeAppliers.push(() => {
      const m = measureContent(src.node, src.span.innerHTML);
      if (m.w <= 0 && m.h <= 0) return; // font mid-swap — keep current size
      if (axis !== 'y') {
        const w = m.w + 2 * (bind.padX ?? 0);
        node.style.width = `${w}px`;
        const grow = bind.grow ?? 'center';
        if (grow !== 'center' && authoredW > 0) {
          const off = (w - authoredW) / 2;
          node.style.marginLeft = `${grow === 'left' ? off : -off}px`;
        }
      }
      if (axis !== 'x') {
        node.style.height = `${m.h + 2 * (bind.padY ?? 0)}px`;
      }
    });
  }
  const applySizeBinds = () => {
    for (const f of sizeAppliers) f();
    for (const f of registry.nestedSizeBinds) f();
  };
  if (sizeAppliers.length > 0) {
    requestAnimationFrame(applySizeBinds);
    document.fonts?.ready.then(applySizeBinds).catch(() => {});
  }

  let visible = false;
  return {
    rootEl,
    contentEl,
    byKey,
    byId,
    layers,
    boundVisibility,
    timeState,
    hasLoops: comp.layers.some((l) => l.loop),
    applySizeBinds,
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
  boundVisibility: BoundVisibility[],
  timeState: LoopTimeState,
  opts: BuildOptions,
  registry: BuildRegistry,
): HTMLElement {
  const dynamicsFrom = dynamics.length;
  const layerEl = document.createElement('div');
  layerEl.dataset['layer'] = layer.name ?? layer.element.key ?? '';
  Object.assign(layerEl.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: `${comp.width}px`,
    height: `${comp.height}px`,
    opacity: layer.isGuide ? '0.5' : '',
  });
  rootEl.appendChild(layerEl);

  // Hidden (Loopic isVisible=false) = CSS visibility, NOT display: a
  // visibility binding on the layer's element can lift it (white lights).
  if (layer.hidden) layerEl.style.visibility = 'hidden';
  {
    // Layer in/out over time — applies to hidden layers too, so a
    // binding-shown element still respects its span and opacity fades.
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

  const handle = buildElement(layer.element, comp, layer, parent, assetBase, dynamics, opts, byKey, boundVisibility, registry);
  if (handle) {
    byId.set(layer.element.id, handle);
    if (layer.element.key) byKey.set(layer.element.key, handle);
    if (layer.element.visibility) {
      boundVisibility.push({
        binding: layer.element.visibility,
        handle,
        ...(layer.hidden ? { hiddenLayerNode: layerEl } : {}),
      });
    }
  }

  // Loop region: warp the frame every dynamic of THIS layer sees. Entrance
  // plays through once, [start, end) wraps — `hold` keeps it cycling while
  // the scene playhead is parked. Once `exiting` latches (outro), the layer
  // KEEPS cycling and fades out in place, in sync with the scene outro — a
  // jump to fixed exit frames looked bad mid-cycle.
  if (layer.loop && layer.loop.end > layer.loop.start) {
    const loop = layer.loop;
    const start = layer.startFrame;
    for (let i = dynamicsFrom; i < dynamics.length; i++) {
      const inner = dynamics[i]!;
      dynamics[i] = { apply: (frame) => inner.apply(loopWarp(frame, start, loop, timeState)) };
    }
    const exitFade = Math.max(1, loop.exitFade ?? 15);
    const restingOpacity = layer.isGuide ? '0.5' : '';
    // NOT warped: the fade runs on raw scene time alongside the outro.
    dynamics.push({
      apply(frame) {
        if (!timeState.exiting) {
          layerEl.style.opacity = restingOpacity;
          return;
        }
        const k = Math.max(0, 1 - (frame - timeState.exitFrom) / exitFade);
        layerEl.style.opacity = String(k);
      },
    });
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

  // Rotated and/or inverted rect masks need a real shape, not an
  // overflow:hidden box: clip-path with an SVG path. Corner radius is not
  // supported here.
  if (mask.inverted || s.rotation) {
    Object.assign(wrap.style, { width: '100%', height: '100%' });
    const applyShape = (frame: number) => {
      wrap.style.clipPath = rectMaskPath(
        numberAtFrame(s.x, frame, 0),
        numberAtFrame(s.y, frame, 0),
        numberAtFrame(s.width, frame, 0),
        numberAtFrame(s.height, frame, 0),
        numberAtFrame(s.rotation, frame, 0),
        mask.inverted === true,
      );
    };
    if (hasAnimatedGeometry(s)) dynamics.push({ apply: applyShape });
    else applyShape(0);
    return inner; // wrap is not translated — inner needs no counter-offset
  }

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
  // Rounded mask corners: a number is uniform, a string is CSS shorthand with
  // per-corner values ("40 0 0 0" = top-left only); bare numbers get px.
  const br = s['borderRadius'];
  if (br) {
    if (br.keyframes?.length) {
      dynamics.push({ apply: (f) => (wrap.style.borderRadius = `${numberAtFrame(br, f, 0)}px`) });
    } else {
      wrap.style.borderRadius = cssRadius(br.value);
    }
  }
  if (hasAnimatedGeometry(s)) dynamics.push({ apply });
  else apply(0);
  return inner;
}

/**
 * clip-path for a center-anchored rect, optionally rotated (degrees) and
 * inverted. Inversion = a huge clockwise outer ring plus the rect as an
 * opposite-winding inner ring — the nonzero fill rule cuts a hole. Shared by
 * layer masks and scene-level outro effects.
 */
export function rectMaskPath(cx: number, cy: number, w: number, h: number, deg: number, inverted: boolean): string {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners: [number, number][] = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  const pts = corners.map(([px, py]) => `${(cx + px * cos - py * sin).toFixed(2)} ${(cy + px * sin + py * cos).toFixed(2)}`);
  const d = inverted
    ? `M -100000 -100000 L 100000 -100000 L 100000 100000 L -100000 100000 Z M ${pts[0]} L ${pts[3]} L ${pts[2]} L ${pts[1]} Z`
    : `M ${pts[0]} L ${pts[1]} L ${pts[2]} L ${pts[3]} Z`;
  return `path('${d}')`;
}

/** "40" → "40px", "40 0 0 0" → "40px 0px 0px 0px"; anything with units passes through. */
function cssRadius(value: number | string): string {
  return String(value)
    .split(/\s+/)
    .map((t) => (/^\d+(\.\d+)?$/.test(t) ? `${t}px` : t))
    .join(' ');
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
  parentBound: BoundVisibility[],
  registry: BuildRegistry,
): ElementHandle | null {
  let node: HTMLElement;
  let contentEl: HTMLElement | null = null;
  let img: HTMLImageElement | null = null;
  let squeeze: (() => void) | null = null;
  let setText: ((html: string) => void) | null = null;

  switch (el.type) {
    case 'text': {
      node = document.createElement('div');
      contentEl = document.createElement('span');
      contentEl.innerHTML = el.content;
      node.appendChild(contentEl);
      registry.textContent.set(el.id, { span: contentEl, node });
      if (el.tabularNums) {
        // Prefer native tabular figures; measure whether the font honors
        // them — if digits still differ, fall back to digit boxing.
        let boxEm = 0;
        let raw = el.content;
        const c = contentEl;
        setText = (html) => {
          raw = html;
          c.innerHTML = boxEm > 0 ? boxDigits(raw, boxEm) : raw;
          if (squeeze) squeeze();
        };
        const measure = () => {
          let min = Infinity;
          let max = 0;
          for (let d = 0; d <= 9; d++) {
            const w = measureContent(node, String(d).repeat(10)).w / 10;
            if (w < min) min = w;
            if (w > max) max = w;
          }
          if (max <= 0) return; // no metrics (font mid-swap) — keep current state
          const fontSize = parseFloat(getComputedStyle(node).fontSize) || 16;
          boxEm = max - min < 0.15 ? 0 : max / fontSize;
          setText!(raw);
        };
        requestAnimationFrame(measure);
        document.fonts?.ready.then(measure).catch(() => {});
      }
      Object.assign(node.style, {
        display: 'flex',
        // Loopic text box model: border-box, whitespace preserved, and an
        // ALWAYS-set line-height (its default 1.2) — leaving CSS 'normal'
        // makes the line box font-dependent and shifts vertical alignment.
        boxSizing: 'border-box',
        alignItems: el.verticalAlign === 'top' ? 'flex-start' : el.verticalAlign === 'bottom' ? 'flex-end' : 'center',
        justifyContent: el.textAlign === 'left' ? 'flex-start' : el.textAlign === 'right' ? 'flex-end' : 'center',
        whiteSpace: el.multiline ? 'pre-wrap' : 'pre',
        lineHeight: '1.2',
        // fixed-advance digits: scores/clocks don't jitter as digits change
        fontVariantNumeric: el.tabularNums ? 'tabular-nums' : '',
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
        const squeezeNode = node;
        squeeze = () => {
          const c = contentEl!;
          const box = numberAtFrame(target.style.width, 0, 0);
          if (box <= 0) return;
          const { w } = measureContent(squeezeNode, c.innerHTML);
          c.style.transform = w > box ? `scaleX(${box / w})` : '';
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
      if (el.sizeBind) registry.sizeBinds.push({ el, node });
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
      registry.nestedSizeBinds.push(() => sub.applySizeBinds());
      // Inherit, don't force 'visible': an explicit 'visible' would pierce a
      // visibility binding hiding the composition element itself (prio lights).
      sub.rootEl.style.visibility = '';
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
        for (const b of sub.boundVisibility)
          parentBound.push({ binding: { ...b.binding, bindKey: `${el.key}.${b.binding.bindKey}` }, handle: b.handle });
      } else {
        parentBound.push(...sub.boundVisibility);
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
      if (setText) {
        setText(html);
      } else if (contentTarget) {
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
    setVisible(visible) {
      // '' = inherit, so the element still follows composition show()/hide()
      node.style.visibility = visible ? '' : 'hidden';
    },
    show() {
      node.style.visibility = '';
    },
    hide() {
      node.style.visibility = 'hidden';
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
  // size-bound axes belong to the bind, not the keyframed geometry
  const bindAxis = el.type === 'rectangle' && el.sizeBind ? (el.sizeBind.axis ?? 'x') : null;

  const applyGeometry = (frame: number) => {
    const x = numberAtFrame(s.x, frame, 0);
    const y = numberAtFrame(s.y, frame, 0);
    const sx = numberAtFrame(s.scaleX, frame, 1);
    const sy = numberAtFrame(s.scaleY, frame, 1);
    const rot = numberAtFrame(s.rotation, frame, 0);
    if (!autoSized) {
      if (s.width && bindAxis !== 'x' && bindAxis !== 'both') node.style.width = `${numberAtFrame(s.width, frame, 0)}px`;
      if (s.height && bindAxis !== 'y' && bindAxis !== 'both') node.style.height = `${numberAtFrame(s.height, frame, 0)}px`;
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
