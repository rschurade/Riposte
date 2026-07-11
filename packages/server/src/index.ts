/**
 * @riposte/server — local Node server (Node ≥ 24, runs TypeScript natively).
 *
 * Surface:
 *   /                → preview bench (public/)
 *   /runtime.js      → @riposte/runtime IIFE build
 *   /examples/**     → example set projects (committed demos)
 *   /projects/**     → user set projects (gitignored, e.g. imported sets)
 *   /api/sets        → list sets from both roots
 *
 * Later: project open/save API, asset upload with content-hash dedup, export.
 */

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const repoRoot = resolve(serverRoot, '..', '..');
const publicDir = join(serverRoot, 'public');
const examplesDir = join(repoRoot, 'examples');
const projectsDir = join(repoRoot, 'projects');
const runtimeJs = join(repoRoot, 'packages', 'runtime', 'dist', 'riposte.js');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

const port = Number(process.env['PORT'] ?? 5720);

createServer((req, res) => {
  void handle(req.url ?? '/', res).catch((err) => {
    console.error(err);
    res.writeHead(500).end('internal error');
  });
}, ).listen(port, () => {
  console.log(`riposte server listening on http://localhost:${port}`);
});

async function handle(rawUrl: string, res: import('node:http').ServerResponse): Promise<void> {
  const url = new URL(rawUrl, 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  if (path === '/api/sets') return json(res, [...(await listSets(examplesDir, 'examples')), ...(await listSets(projectsDir, 'projects'))]);
  if (path === '/runtime.js') return file(res, runtimeJs);
  if (path.startsWith('/examples/')) return file(res, safeJoin(examplesDir, path.slice('/examples/'.length)));
  if (path.startsWith('/projects/')) return file(res, safeJoin(projectsDir, path.slice('/projects/'.length)));

  const rel = path === '/' ? 'index.html' : path.replace(/^\//, '');
  return file(res, safeJoin(publicDir, rel));
}

function safeJoin(root: string, rel: string): string {
  const full = resolve(root, rel);
  if (!full.startsWith(root)) throw Object.assign(new Error('forbidden'), { status: 403 });
  return full;
}

async function file(res: import('node:http').ServerResponse, fullPath: string): Promise<void> {
  try {
    const body = await readFile(fullPath);
    res.writeHead(200, {
      'content-type': MIME[extname(fullPath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

function json(res: import('node:http').ServerResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

interface SetInfo {
  /** URL root the set is served under: 'examples' or 'projects'. */
  root: string;
  name: string;
  scenes: string[];
  fonts: { family: string; file: string }[];
}

async function listSets(dir: string, root: string): Promise<SetInfo[]> {
  const out: SetInfo[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const setFile = join(dir, entry, 'set.json');
    try {
      if (!(await stat(setFile)).isFile()) continue;
      const doc = JSON.parse(await readFile(setFile, 'utf8')) as {
        name?: string;
        scenes?: string[];
        fonts?: { family: string; file: string }[];
      };
      out.push({ root, name: entry, scenes: doc.scenes ?? [], fonts: doc.fonts ?? [] });
    } catch {
      // not a set folder — skip
    }
  }
  return out;
}
