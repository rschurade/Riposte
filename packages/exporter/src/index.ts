/**
 * @riposte/exporter — turns a set project into deployable CasparCG templates.
 *
 * 'external' (default): per-scene HTML shells (few KB: runtime + inlined
 * scene JSON) next to ONE shared assets folder, relative references only —
 * the exported folder works anywhere under the CasparCG template root.
 * 'baked': self-contained single-file HTML per scene, for compatibility.
 */

import type { SetDoc } from '@riposte/shared';

export interface ExportResult {
  outputDir: string;
  scenes: string[];
  /** Bytes shared via the common assets folder instead of duplicated per scene. */
  assetBytesShared: number;
}

export function exportSet(_set: SetDoc, _setDir: string, _outputDir: string): Promise<ExportResult> {
  throw new Error('not implemented yet (phase 1: shell generation; phase 3: full export UI)');
}
