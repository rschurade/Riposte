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
  // CasparCG 2.3.x bundles CEF 78 (Chromium 78). Optional chaining (?.) and
  // nullish coalescing (??) are es2020 (Chromium 80) — untranspiled they throw
  // "Unexpected token ." on air before riposte/update/play are defined. Target
  // es2019 so esbuild downlevels them. Virtual CasparCG runs in modern Chrome,
  // so this only ever surfaces on real Caspar.
  target: ['es2019'],
  define: { __RIPOSTE_VERSION__: JSON.stringify(version) },
});

console.log(`dist/riposte.js (v${version})`);
