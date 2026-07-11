/**
 * @riposte/importer — converts Loopic single-file HTML exports into Riposte
 * set projects (phase 2).
 *
 * Approach: Loopic exports construct the scene via readable
 * `new Composition/Layer/…` calls. Stub those classes, evaluate the
 * composition block in a sandbox, capture the object graph, translate it to
 * the Riposte scene format. Base64 assets are extracted to files and
 * content-hash deduplicated into the target set's shared assets folder.
 *
 * Asset identity = content hash; filenames are labels only. Same bytes under
 * different names dedup to one canonical file; same name with different
 * bytes is never overwritten (hash-suffixed + reported). A pixel-level
 * near-duplicate report flags visually-identical-but-byte-different assets
 * for manual merging — it never auto-merges.
 */

export interface ImportResult {
  sceneFile: string;
  /** Assets written (or dedup-skipped) in the set's shared pool. */
  assets: { path: string; deduplicated: boolean }[];
}

export function importLoopicTemplate(_html: string, _setDir: string): Promise<ImportResult> {
  throw new Error('not implemented yet (phase 2)');
}
