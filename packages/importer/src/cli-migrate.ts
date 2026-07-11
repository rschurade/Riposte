#!/usr/bin/env node
/**
 * CLI: riposte-migrate <set-dir> [--dry]
 *
 * Converts Loopic-era composition-action scripts (show/hide switches,
 * setContent redirects, useOnPlay resets) into declarative visibility
 * bindings across every scene/component of a set, and extends single-frame
 * hold layers of bound elements into proper fade envelopes. Unrecognized
 * script code is left untouched. Idempotent — re-running is a no-op.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SceneDoc } from '@riposte/shared';
import { cleanupLayerNames, migrateSceneScripts, restructureHoldLayers } from './migrate-scripts.ts';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const setDir = args.filter((a) => a !== '--dry')[0];
if (!setDir) {
  console.error('Usage: riposte-migrate <set-dir> [--dry]');
  process.exit(2);
}

let touched = 0;
for (const sub of ['scenes', 'components']) {
  const dir = join(setDir, sub);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    continue;
  }
  for (const f of files) {
    const path = join(dir, f);
    const doc = JSON.parse(await readFile(path, 'utf8')) as SceneDoc;
    const steps = [migrateSceneScripts(doc), restructureHoldLayers(doc), cleanupLayerNames(doc)];
    const notes = steps.flatMap((s) => s.notes);
    const changed = steps.some((s) => s.changed);
    if (notes.length > 0 || changed) {
      console.log(`${sub}/${f}${changed ? '' : ' (unchanged)'}`);
      for (const n of notes) console.log(`  ${n}`);
    }
    if (changed) {
      touched++;
      if (!dry) await writeFile(path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    }
  }
}
console.log(`${dry ? '[dry] would update' : 'updated'} ${touched} file(s)`);
