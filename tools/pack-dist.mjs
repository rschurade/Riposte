// Assemble the portable Riposte distribution: a folder anyone can run with
// nothing but a Node.js LTS install — unzip, double-click start.
//
//   npm run dist          (root: builds runtime + editor + server bundle, then this)
//
// Output: dist/riposte/ + dist/riposte-<version>.zip
// Layout (the server auto-detects it by the public/ dir next to server.js):
//   server.js  public/  editor/  runtime/riposte.js  examples/demo/  projects/  start.cmd  start.sh
import { cp, mkdir, rm, writeFile, chmod, readFile, stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version;
const out = join(repo, 'dist', 'riposte');
const zip = join(repo, 'dist', `riposte-${version}.zip`);

async function mustExist(p, hint) {
  try {
    await stat(p);
  } catch {
    console.error(`missing: ${p}\n  → ${hint}`);
    process.exit(1);
  }
}

await mustExist(join(repo, 'packages/server/dist/server.js'), 'run: npm run build');
await mustExist(join(repo, 'packages/editor/dist/index.html'), 'run: npm run build');
await mustExist(join(repo, 'packages/runtime/dist/riposte.js'), 'run: npm run build');

await rm(out, { recursive: true, force: true });
await rm(zip, { force: true });
await mkdir(join(out, 'runtime'), { recursive: true });
await mkdir(join(out, 'projects'), { recursive: true });

await cp(join(repo, 'packages/server/dist/server.js'), join(out, 'server.js'));
// WebP encoder wasm — the exporter looks for it next to server.js when packaged
await cp(
  join(repo, 'node_modules/@jsquash/webp/codec/enc/webp_enc_simd.wasm'),
  join(out, 'webp_enc_simd.wasm'),
);
await cp(join(repo, 'packages/server/public'), join(out, 'public'), { recursive: true });
await cp(join(repo, 'packages/editor/dist'), join(out, 'editor'), { recursive: true });
await cp(join(repo, 'packages/runtime/dist/riposte.js'), join(out, 'runtime/riposte.js'));
await cp(join(repo, 'examples/demo'), join(out, 'examples/demo'), {
  recursive: true,
  filter: (src) => !/[\\/]export([\\/]|$)/.test(src),
});
await cp(join(repo, 'CHANGELOG.md'), join(out, 'CHANGELOG.md'));

await writeFile(
  join(out, 'projects', 'README.txt'),
  'Your graphics sets live here — one folder per set (set.json, scenes/, assets/).\r\nCopy a set folder in and it appears in the editor.\r\n',
);

await writeFile(
  join(out, 'start.cmd'),
  '@echo off\r\n' +
    'cd /d "%~dp0"\r\n' +
    'where node >nul 2>nul || (echo Riposte needs Node.js ^(LTS^) - install it from https://nodejs.org and run this again. & pause & exit /b 1)\r\n' +
    'node server.js --open\r\n' +
    'pause\r\n',
);

await writeFile(
  join(out, 'start.sh'),
  '#!/bin/sh\n' +
    'cd "$(dirname "$0")"\n' +
    'command -v node >/dev/null 2>&1 || { echo "Riposte needs Node.js (LTS) - install it from https://nodejs.org and run this again."; exit 1; }\n' +
    'node server.js --open\n',
);
await chmod(join(out, 'start.sh'), 0o755);

await writeFile(
  join(out, 'README.txt'),
  `Riposte ${version} — local template studio for CasparCG HTML graphics
========================================================================

Requirements: Node.js LTS (https://nodejs.org). Nothing else.

Run:      Windows:   start.cmd
          Mac/Linux: sh start.sh
          (the zip is built on Windows and can't carry the Unix executable
          bit, so "sh start.sh" — or chmod +x start.sh once — is the way)
          Your browser opens the editor at http://localhost:5720
Bench:    http://localhost:5720/bench   (manual template testing)
Playout:  http://localhost:5720/playout.html
          A virtual CasparCG - point ControlCenter (or any Caspar client)
          at this machine, ports 6250 (main) / 6251 (preview).
          The port is shown in the page header; click it to change it.

Sets:     copy set folders into projects\\ - they appear in the editor.
Deploy:   the editor's Deploy button exports templates and copies them
          into your CasparCG template directory.

Stop the server by closing its console window (or Ctrl+C).
`,
);

console.log(`packed ${out}`);

if (process.platform === 'win32') {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${out}' -DestinationPath '${zip}' -Force"`,
    { stdio: 'inherit' },
  );
} else {
  execSync(`cd "${dirname(out)}" && zip -qr "${zip}" riposte`, { stdio: 'inherit' });
}
console.log(`zipped ${zip}`);
