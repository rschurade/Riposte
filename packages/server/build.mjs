// Server bundle for the portable dist. The banner matters: the bundle is ESM,
// but CJS deps (pngjs via the exporter's WebP path) call require('util') at
// load time — esbuild's ESM shim throws "Dynamic require of X is not
// supported" unless a real require exists. This broke every shipped zip's
// server.js from 0.3.0 (WebP introduction) through 0.6.0.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/server.js',
  banner: {
    js: "import { createRequire as __riposteCreateRequire } from 'node:module';\nconst require = __riposteCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
