/**
 * Minimal typings for the parts of Loopic's .loo project format we read.
 * Mapped by inspection of the FIE_2026 project family (July 2026).
 *
 * Semantics learned by cross-checking against the corresponding HTML exports:
 * - composition.workspaceDuration is the REAL total duration (the export's
 *   Composition.duration); composition.duration is the workspace-bar length.
 * - actions[] are frame actions; `asOutro: true` marks the outroFrame;
 *   the code `this.pause();` is Loopic's stop-point idiom.
 * - FONT resources hold raw base64 (no data: prefix); their `name` is the
 *   CSS font-family the text elements reference.
 * - IMAGE_SEQUENCE resources carry `images[]`; elements reference a subset
 *   and ordering via `imageIds`.
 */

export interface LooDoc {
  activeCompositionId?: string;
  compositions: LooComposition[];
  resources?: { resources?: LooResource[] };
}

export interface LooComposition {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  workspaceDuration?: number;
  compositionAction?: string;
  actions?: LooFrameAction[];
  layers: LooLayer[];
}

export interface LooFrameAction {
  id: string;
  frame: number;
  code: string;
  asOutro?: boolean;
}

export interface LooLayer {
  id: string;
  name: string;
  startFrame: number;
  duration: number;
  isVisible?: boolean;
  isGuide?: boolean;
  element: LooElement;
  maskLayers?: LooLayer[];
}

export interface LooProperty {
  value: unknown;
  keyframes?: LooKeyframe[];
}

export interface LooKeyframe {
  id?: string;
  frame: number;
  value: unknown;
  easing?: { p1x: number; p1y: number; p2x: number; p2y: number };
}

export interface LooColorProperty {
  isGradient?: boolean;
  color: LooProperty | string;
}

export interface LooElement {
  id: string;
  key?: string;
  type: string; // TEXT | IMAGE | IMAGE_SEQUENCE | IMAGE_LOADER | RECTANGLE | ELLIPSE | PATH | COMPOSITION | LOTTIE
  transformProperties?: Record<string, LooProperty>;
  sizeProperties?: Record<string, LooProperty>;
  filterProperties?: Record<string, LooProperty>;
  borderRadiusProperties?: Record<string, LooProperty>;
  dropShadowPropertyGroup?: { x?: LooProperty; y?: LooProperty; blur?: LooProperty; color?: LooColorProperty };
  transformOrigin?: { x?: LooProperty; y?: LooProperty };
  // TEXT
  content?: string;
  autoSize?: boolean;
  autoSqueeze?: boolean;
  multiline?: boolean;
  textProperties?: Record<string, LooProperty | LooColorProperty>;
  textShadowProperties?: Record<string, LooProperty | LooColorProperty>;
  // IMAGE / IMAGE_SEQUENCE
  imageResourceId?: string;
  imageSequenceResourceId?: string;
  imageIds?: string[];
  // IMAGE_LOADER
  size?: string; // fit mode: original|contain|cover|stretch|...
  placeholderId?: string;
  // RECTANGLE / ELLIPSE / PATH share pathProperties for fill/stroke
  pathProperties?: {
    fill?: LooColorProperty;
    strokeColor?: LooColorProperty;
    strokeWidth?: LooProperty;
    [k: string]: unknown;
  };
}

export interface LooResource {
  id: string;
  name: string;
  resourceType: string; // FILE | IMAGE_SEQUENCE
  fileResourceType?: string; // IMAGE | FONT
  fileType?: string; // png | jpg | ttf | ...
  content?: string; // data URI for images, raw base64 for fonts
  images?: LooResource[]; // IMAGE_SEQUENCE children
}
