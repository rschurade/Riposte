// Trim Loopic workspace durations down to the actual content of each scene.
// Idempotent; components are left alone (their duration drives nested playback).
//
// Usage: node tools/trim-durations.mjs projects/FIE_2026
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { trimToContent } from '../packages/shared/src/trim.ts';

const setDir = process.argv[2];
if (!setDir) {
  console.error('usage: node tools/trim-durations.mjs <set-dir>');
  process.exit(2);
}

const set = JSON.parse(await readFile(join(setDir, 'set.json'), 'utf8'));
let trimmed = 0;
for (const file of set.scenes ?? []) {
  const path = join(setDir, file);
  const doc = JSON.parse(await readFile(path, 'utf8'));
  const before = doc.composition.duration;
  const after = trimToContent(doc.composition);
  if (after !== null) {
    await writeFile(path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    console.log(`${file}: ${before} -> ${after}`);
    trimmed++;
  }
}
console.log(`${trimmed} of ${(set.scenes ?? []).length} scenes trimmed`);
