/**
 * @riposte/importer — converts Loopic projects (.loo, primary) and Loopic
 * HTML exports (fallback, planned) into Riposte set projects.
 *
 * Asset identity = content hash; filenames are labels only. Same bytes under
 * different names dedup to one canonical file; same name with different
 * bytes is never overwritten (hash-suffixed + reported). A pixel-level
 * near-duplicate report for visually-identical-but-byte-different assets is
 * planned; it will flag, never auto-merge.
 */

export { importLoo, type LooImportResult } from './import-loo.ts';
export { convertComposition, type AssetResolver } from './convert.ts';
export { AssetPool, decodeContent } from './assets.ts';
export { migrateSceneScripts, restructureHoldLayers, type MigrateResult } from './migrate-scripts.ts';
export type * from './loo-format.ts';
