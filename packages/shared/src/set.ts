/**
 * Riposte set format, v1 — `set.json` at the root of a project folder.
 *
 * A project is a SET: many scenes sharing ONE `assets/` folder. This is the
 * core divergence from Loopic (one opaque project file per graphic with
 * embedded assets). Exports mirror the layout: HTML shells + one shared
 * assets folder, relative references only.
 */

export const SET_FORMAT_VERSION = 1;

export interface SetDoc {
  formatVersion: typeof SET_FORMAT_VERSION;
  /** Set name; also the default exported folder name. */
  name: string;
  /** Scene files relative to the set root, e.g. "scenes/Schedule.json". */
  scenes: string[];
  /**
   * Component scenes: embedded by other scenes (nested compositions), not
   * standalone graphics — not exported as templates, listed separately.
   */
  components?: string[];
  /** Fonts shared by the set's scenes; renderers emit @font-face for each. */
  fonts?: SetFont[];
  export: ExportSettings;
}

export interface SetFont {
  /** CSS font-family name scenes reference (Loopic: the resource name). */
  family: string;
  /** Font file relative to the set root, e.g. "assets/fonts/League Spartan Bold.ttf". */
  file: string;
}

export interface ExportSettings {
  /**
   * 'external' — HTML shells + shared assets folder (default deployment).
   * 'baked'    — self-contained single-file HTML per scene (compatibility).
   */
  mode: 'external' | 'baked' | 'ograf' | 'spx';
  /**
   * Fetch every referenced asset at template load, before first play —
   * prevents asset-load flash on the first ADD after a server restart.
   */
  preloadAssets: boolean;
  /** Last used output directory (absolute; machine-local convenience). */
  outputDir?: string;
  /**
   * 'webp': re-encode PNG assets to WebP at export time (typically 3–10×
   * smaller; CasparCG's CEF decodes WebP natively). Scene JSONs never
   * change — only the exported copies and their rewritten references.
   * Default 'png' (copy untouched).
   */
  imageFormat?: 'png' | 'webp';
  /**
   * Lossy WebP quality 1–100 (default 92). The exporter also tries lossless
   * per image and ships whichever is smaller, so flat-color frames stay
   * bit-perfect. 'lossless' forces bit-perfect everywhere.
   */
  webpQuality?: number | 'lossless';
  /**
   * OGraf asset layout.
   * 'shared'  — one assets/ folder (incl. riposte.js) next to the per-scene
   *             graphic folders; bridges reference ../assets/. The set stays
   *             one deduplicated unit — deploy the export dir as a whole.
   *             (default; matches the set model)
   * 'bundled' — every graphic folder carries its own riposte.js + assets copy.
   *             Spec-portable: a single folder can be handed to any OGraf host,
   *             at the cost of duplicating assets per scene.
   */
  ografAssets?: 'shared' | 'bundled';
}
