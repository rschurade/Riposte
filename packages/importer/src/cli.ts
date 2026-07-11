#!/usr/bin/env node
/**
 * CLI: riposte-import <set-dir> <file.loo> [more.loo ...]
 * Imports Loopic projects into one Riposte set with a shared asset pool.
 */

import { importLoo } from './import-loo.ts';

const [setDir, ...files] = process.argv.slice(2);

if (!setDir || files.length === 0) {
  console.error('Usage: riposte-import <set-dir> <file.loo> [more.loo ...]');
  process.exit(2);
}

let failed = false;
for (const file of files) {
  try {
    const result = await importLoo(file, setDir);
    const r = result.assetReport;
    console.log(
      `${file}\n  scenes: ${result.scenes.join(', ')}\n` +
        `  assets: ${r.written.length} written, ${r.deduplicated.length} deduplicated, ${r.collisions.length} name collisions`,
    );
    for (const c of r.collisions) console.log(`  COLLISION: ${c.name} -> stored as ${c.storedAs}`);
    for (const w of result.warnings) console.log(`  warn: ${w}`);
  } catch (err) {
    failed = true;
    console.error(`${file}: import failed`, err);
  }
}
process.exit(failed ? 1 : 0);
