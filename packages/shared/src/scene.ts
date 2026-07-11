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
  composition: Composition;
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
  name: string;
  startFrame: number;
  /** Duration in frames; the layer is hidden outside [startFrame, startFrame + duration). */
  duration: number;
  /** Guide layers render in the editor but are skipped on export. */
  isGuide?: boolean;
  /** Hidden layers exist in the scene but never render (Loopic isVisible=false). */
  hidden?: boolean;
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
  style: ElementStyle;
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
}

export interface RectangleElement extends BaseElement {
  type: 'rectangle';
  fill?: string;
  borderRadius?: StyleProperty;
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
