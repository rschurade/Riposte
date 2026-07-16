// Bundle the runtime IIFE with the ROOT package version injected — exported
// templates then report the product version (0.4.0, …), not the never-bumped
// workspace package version.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'riposte',
  outfile: 'dist/riposte.js',
  define: { __RIPOSTE_VERSION__: JSON.stringify(version) },
});

console.log(`dist/riposte.js (v${version})`);
