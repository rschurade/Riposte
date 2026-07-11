#!/usr/bin/env node
/** CLI: riposte-import <loopic-export.html> <set-dir> */

const [input, setDir] = process.argv.slice(2);

if (!input || !setDir) {
  console.error('Usage: riposte-import <loopic-export.html> <set-dir>');
  process.exit(2);
}

console.error('not implemented yet (phase 2)');
process.exit(1);
