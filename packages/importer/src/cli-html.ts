#!/usr/bin/env node
/** CLI: riposte-import-html <set-dir> <loopic-export.html> */

import { importLoopicHtml } from './import-html.ts';

const [setDir, htmlFile] = process.argv.slice(2);
if (!setDir || !htmlFile) {
  console.error('Usage: riposte-import-html <set-dir> <loopic-export.html>');
  process.exit(2);
}

const r = await importLoopicHtml(htmlFile, setDir);
console.log(`imported ${r.scene}`);
console.log(`  assets: ${r.assetReport.written.length} written, ${r.assetReport.deduplicated.length} deduplicated, ${r.assetReport.collisions.length} collisions`);
for (const w of r.warnings) console.log(`  warn: ${w}`);
if (r.customScripts.length > 0) {
  console.log(`  NOTE: ${r.customScripts.length} hand-added script block(s) found — port to the composition action:`);
  r.customScripts.forEach((s, i) => console.log(`    [${i}] ${s.slice(0, 100).replace(/\s+/g, ' ')}…`));
}
