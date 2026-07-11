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
  export: ExportSettings;
}

export interface ExportSettings {
  /**
   * 'external' — HTML shells + shared assets folder (default deployment).
   * 'baked'    — self-contained single-file HTML per scene (compatibility).
   */
  mode: 'external' | 'baked';
  /**
   * Fetch every referenced asset at template load, before first play —
   * prevents asset-load flash on the first ADD after a server restart.
   */
  preloadAssets: boolean;
  /** Last used output directory (absolute; machine-local convenience). */
  outputDir?: string;
}
