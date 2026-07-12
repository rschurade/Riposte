#!/usr/bin/env node
/** CLI: riposte-export [--baked] <set-dir> <out-dir> */

import { exportSet } from './index.ts';

const args = process.argv.slice(2);
const baked = args.includes('--baked');
const [setDir, outDir] = args.filter((a) => a !== '--baked');

if (!setDir || !outDir) {
  console.error('Usage: riposte-export [--baked] <set-dir> <out-dir>');
  process.exit(2);
}

const r = await exportSet(setDir, outDir, baked ? { mode: 'baked' } : {});
console.log(`${r.mode} export -> ${r.outDir}`);
console.log(
  `  templates: ${r.scenesUpdated.length} updated, ${r.scenes.length - r.scenesUpdated.length} unchanged` +
    (r.scenesUpdated.length ? ` (${r.scenesUpdated.join(', ')})` : ''),
);
if (r.mode === 'external') {
  console.log(
    `  assets: ${r.assetsCopied} copied, ${r.assetsUpToDate} up to date, ` +
      `${(r.assetBytes / 1048576).toFixed(1)} MB total; riposte.js ${r.runtimeUpdated ? 'updated' : 'unchanged'}`,
  );
}
for (const w of r.warnings) console.log(`  warn: ${w}`);
