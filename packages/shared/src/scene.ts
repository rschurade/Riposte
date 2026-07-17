/**
 * Riposte scene format, v1 — one JSON document per scene inside a set project.
 *
 * The model deliberately stays close to Loopic's object graph
 * (Composition → Layer → Element → keyframed style properties) so the
 * importer is a near-mechanical translation. Divergences are marked.
 */

export const SCENE_FORMAT_VERSION = 1;

export interface SceneDoc {
  formatVersion: typeof SCENE_FORMAT_VERSION;
  /** Scene name; also the exported template file name. */
  name: string;
  /**
   * Design-time sample payload (key → value). Editor script-preview and the
   * bench apply it like an on-air update(); never shipped to CasparCG.
   */
  previewData?: Record<string, string>;
  /** Design-time ruler guides (editor only; renderers and exports ignore them). */
  guides?: { v: number[]; h: number[]; locked?: boolean };
  /**
   * Outro preset name (a file in the set's `outros/` folder, without .json).
   * When set, `stop()` (or `next()` off the last pause — the ControlCenter
   * lifecycle) runs the preset on the scene root — affecting every layer at
   * once — INSTEAD of the marker-based outro.
   */
  outro?: string;
  /**
   * Intro preset name (a file in the set's `intros/` folder, without .json).
   * Played FORWARD on `play()` over the scene root while the timeline plays
   * its normal build-up underneath. Authored from hidden (frame 0) to
   * neutral (last frame) — reversing an outro's keyframes is a handy way to
   * write one, but intros are their own definitions with their own names.
   */
  intro?: string;
  composition: Composition;
}

/**
 * A reusable scene-level outro effect, stored as `outros/<name>.json` in a
 * set. On stop() the runtime animates the SCENE ROOT with these keyframed
 * properties over `duration` frames (frame 0 = the stop moment), then hides
 * the scene. Data, not code — adding an effect means adding a JSON file.
 */
export interface OutroPreset {
  name: string;
  /** Effect length in frames (at the scene's fps). */
  duration: number;
  /**
   * Keyframed root properties: `opacity`, `scaleX`, `scaleY`, `rotation`,
   * `x`, `y` (translation offsets in px). Scale/rotate pivot on the
   * composition center.
   */
  style?: Record<string, StyleProperty>;
  /**
   * Rect mask on the scene root: `width`/`height` (+ optional `x`/`y`,
   * defaulting to the composition center, and `rotation` in degrees).
   * `inverted` cuts a hole instead — e.g. the growing-diamond wipe. Mask
   * geometry may extend far beyond the composition bounds.
   */
  mask?: { inverted?: boolean; style: Record<string, StyleProperty> };
}

export interface Composition {
  width: number;
  height: number;
  fps: number;
  /** Total length in frames. */
  duration: number;
  /**
   * Divergence from Loopic: pause/outro/loop are first-class timeline
   * markers, not `this.pause()` code snippets in frame actions.
   */
  markers: Marker[];
  layers: Layer[];
  /** Composition action: JS source run once on load (custom-code escape hatch). */
  action?: string;
}

export type Marker =
  | { frame: number; type: 'pause' }
  /** `stop()` plays from here to the end. At most one per composition. */
  | { frame: number; type: 'outro' }
  | { frame: number; type: 'loop'; loopToFrame: number }
  /** Frame action: JS source run when the playhead reaches the frame. */
  | { frame: number; type: 'action'; source: string };

export interface Layer {
  id: string;
  /**
   * Optional display name — only for layers whose element has no key (the
   * key IS the identity of bound elements) and where a human wrote
   * something meaningful. Editors derive a label from the element
   * (type/asset/content) when absent.
   */
  name?: string;
  startFrame: number;
  /** Duration in frames; the layer is hidden outside [startFrame, startFrame + duration). */
  duration: number;
  /** Guide layers render in the editor but are skipped on export. */
  isGuide?: boolean;
  /** Hidden layers exist in the scene but never render (Loopic isVisible=false). */
  hidden?: boolean;
  /** Locked layers can't be selected or moved on the editor stage (editor only). */
  locked?: boolean;
  /**
   * Independent loop region in LAYER-LOCAL frames (relative to startFrame):
   * content before `start` is the entrance, [start, end) cycles on the
   * layer's own clock — it keeps animating while the scene playhead holds
   * at a pause marker. When the outro begins the layer keeps cycling and
   * fades out in place over `exitFade` frames (default 15), in sync with
   * the scene outro; frames after `end` are never played on air.
   */
  loop?: { start: number; end: number; exitFade?: number };
  /** Mask elements clip this layer's element (rectangle or path shapes). */
  masks?: SceneElement[];
  element: SceneElement;
}

/**
 * Element types. The set is open by design: unknown `type` strings must
 * survive load/save round-trips so future additions (e.g. `video`) do not
 * require a format-version bump. Renderers ignore types they don't know.
 */
export type SceneElement =
  | TextElement
  | ImageElement
  | ImageSequenceElement
  | ImageLoaderElement
  | RectangleElement
  | EllipseElement
  | PathElement
  | CompositionElement;

export interface BaseElement {
  id: string;
  /**
   * Data binding: `update()` payload keys map to elements by key
   * (convention `_name`; dot paths address nested compositions).
   * Empty/absent = not data-bound.
   */
  key?: string;
  /**
   * Data-driven show/hide, evaluated on every update() of `bindKey`.
   * Drives CSS `visibility` on the element node — independent of the
   * layer's in/out span (display) and keyframed opacity, so a "shown"
   * element still fades in/out with its opacity gradient.
   */
  visibility?: VisibilityBinding;
  /**
   * Masks only: invert the shape — the layer is visible OUTSIDE it (the mask
   * cuts a hole). Combined with style.rotation this gives e.g. a growing
   * diamond outro. Ignored on regular elements.
   */
  inverted?: boolean;
  style: ElementStyle;
}

/**
 * Replaces the Loopic-era `useOnUpdate` show/hide scripts: the element is
 * shown or hidden by the value of an update() key. Exactly one of
 * `showWhen`/`hideWhen` applies; with neither set, `hideWhen: ["0"]` is
 * assumed (the ubiquitous `_xSwitch` convention).
 */
export interface VisibilityBinding {
  /** update() key that drives visibility, e.g. "_greenSwitch". */
  bindKey: string;
  /** Visible ONLY for these values; hidden for anything else. */
  showWhen?: string[];
  /** Hidden for these values; visible for anything else. Default ["0"]. */
  hideWhen?: string[];
  /** State before `bindKey` first arrives. Default 'visible'. */
  initial?: 'visible' | 'hidden';
}

/**
 * Keyframable style properties. x/y are the element box CENTER
 * (Loopic convention, kept for import fidelity).
 */
export interface ElementStyle {
  x: StyleProperty;
  y: StyleProperty;
  width?: StyleProperty;
  height?: StyleProperty;
  /** 0–1 */
  opacity?: StyleProperty;
  scaleX?: StyleProperty;
  scaleY?: StyleProperty;
  /** Degrees. */
  rotation?: StyleProperty;
  /** Additional properties (color, fontSize, borderRadius, filters, …). */
  [prop: string]: StyleProperty | undefined;
}

export type StyleValue = number | string;

export interface StyleProperty {
  /** Static value — IGNORED whenever keyframes exist (Loopic semantics). */
  value: StyleValue;
  unit?: 'px' | '%' | 'deg' | 'color';
  keyframes?: Keyframe[];
}

export interface Keyframe {
  frame: number;
  value: StyleValue;
  /** Cubic-bezier easing toward the NEXT keyframe; linear when omitted. */
  easing?: BezierEasing;
}

export interface BezierEasing {
  p1x: number;
  p1y: number;
  p2x: number;
  p2y: number;
}

export interface TextElement extends BaseElement {
  type: 'text';
  /** Design-time default, shown until the first update(). */
  content: string;
  fontFamily?: string;
  fontWeight?: number | string;
  fontStyle?: string;
  textAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  textTransform?: string;
  textDecoration?: string;
  /** CSS padding [top, right, bottom, left] in px. */
  padding?: [number, number, number, number];
  multiline?: boolean;
  /** Auto-size box to content (disables width/height). */
  autoSize?: boolean;
  /** Single-line only: shrink text to fit width — the CasparCG name-squeeze. */
  autoSqueeze?: boolean;
  /**
   * Fixed-advance digits (font-variant-numeric: tabular-nums): scores,
   * clocks and counters don't jitter horizontally as their digits change.
   */
  tabularNums?: boolean;
}

/** Static image from the set's shared asset pool. */
export interface ImageElement extends BaseElement {
  type: 'image';
  /** Path relative to the set root, e.g. "assets/frame.png". */
  asset: string;
}

/** Frame-synchronized image sequence (flourishes etc.). */
export interface ImageSequenceElement extends BaseElement {
  type: 'imageSequence';
  /** Paths relative to the set root, in frame order. */
  frames: string[];
}

/** Dynamic image container — content set at runtime via update(). */
export interface ImageLoaderElement extends BaseElement {
  type: 'imageLoader';
  fit: 'original' | 'contain' | 'cover' | 'stretch' | 'fitWidth' | 'fitHeight';
  /** Design-time placeholder asset shown until update() provides a source. */
  placeholder?: string;
}

export interface RectangleElement extends BaseElement {
  type: 'rectangle';
  fill?: string;
  borderRadius?: StyleProperty;
  /**
   * Dynamic size binding: the rectangle resizes to the measured content of a
   * text element (by element id) plus padding — re-evaluated on build and on
   * every update(), so a background bar always fits the name it carries.
   */
  sizeBind?: SizeBind;
}

export interface SizeBind {
  /** Element id of the source text layer. */
  sourceId: string;
  /** Which dimensions follow the text. Default 'x'. */
  axis?: 'x' | 'y' | 'both';
  /** Padding added around the measured text, per side, in px. Default 0. */
  padX?: number;
  padY?: number;
  /** Which edge stays put when the width changes. Default 'center'. */
  grow?: 'center' | 'left' | 'right';
}

export interface EllipseElement extends BaseElement {
  type: 'ellipse';
  fill?: string;
}

export interface PathElement extends BaseElement {
  type: 'path';
  /** SVG path data. */
  d: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

/** Nested composition instance (reusable component). */
export interface CompositionElement extends BaseElement {
  type: 'composition';
  /** Set-relative scene file of the embedded component, e.g. "scenes/nest.json". */
  compositionId: string;
  /** Loopic semantics: child runs its own clock instead of syncing to the parent. */
  detachPlayhead?: boolean;
  /** With detachPlayhead: child starts playing as soon as it becomes visible. */
  autoPlay?: boolean;
}
