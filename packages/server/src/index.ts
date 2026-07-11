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

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir, stat, writeFile, unlink } from 'node:fs/promises';
import { join, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportSet } from '@riposte/exporter';

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
  void handle(req, res).catch((err: Error & { status?: number }) => {
    console.error(err);
    res.writeHead(err.status ?? 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message ?? 'internal error' }));
  });
}).listen(port, () => {
  console.log(`riposte server listening on http://localhost:${port}`);
});

const ROOTS: Record<string, string> = { examples: '', projects: '' };

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ROOTS['examples'] = examplesDir;
  ROOTS['projects'] = projectsDir;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  if (path === '/api/sets') return json(res, [...(await listSets(examplesDir, 'examples')), ...(await listSets(projectsDir, 'projects'))]);
  if (path === '/api/set') return apiSetBundle(url, res);
  if (path === '/api/assets') return apiAssets(url, res);
  if (path === '/api/scene' && req.method === 'PUT') return apiSaveScene(req, res);
  if (path === '/api/scene/remove' && req.method === 'POST') return apiRemoveScene(req, res);
  if (path === '/api/assets/delete' && req.method === 'POST') return apiDeleteAssets(req, res);
  if (path === '/api/export' && req.method === 'POST') return apiExport(req, res);
  if (path === '/runtime.js') return file(res, runtimeJs);
  if (path.startsWith('/examples/')) return file(res, safeJoin(examplesDir, path.slice('/examples/'.length)));
  if (path.startsWith('/projects/')) return file(res, safeJoin(projectsDir, path.slice('/projects/'.length)));

  const rel = path === '/' ? 'index.html' : path.replace(/^\//, '');
  return file(res, safeJoin(publicDir, rel));
}

/** Resolve a set directory from ?root=&name=, guarding against traversal. */
function setDirOf(url: URL): string {
  const root = ROOTS[url.searchParams.get('root') ?? ''];
  const name = url.searchParams.get('name') ?? '';
  if (!root || !/^[\w .()-]+$/.test(name)) throw Object.assign(new Error('bad set ref'), { status: 400 });
  return join(root, name);
}

/** The whole set in one response: set.json + every scene doc (for usage scans). */
async function apiSetBundle(url: URL, res: ServerResponse): Promise<void> {
  const dir = setDirOf(url);
  const set = JSON.parse(await readFile(join(dir, 'set.json'), 'utf8')) as { scenes?: string[]; components?: string[] };
  const scenes: Record<string, unknown> = {};
  for (const file of [...(set.scenes ?? []), ...(set.components ?? [])]) {
    if (!SCENE_FILE_RE.test(file)) continue;
    try {
      scenes[file] = JSON.parse(await readFile(join(dir, file), 'utf8'));
    } catch {
      scenes[file] = null;
    }
  }
  return json(res, { set, scenes });
}

async function apiAssets(url: URL, res: ServerResponse): Promise<void> {
  const dir = setDirOf(url);
  const out: { file: string; size: number }[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(childRel);
      else out.push({ file: childRel, size: (await stat(join(dir, childRel))).size });
    }
  };
  await walk('assets');
  return json(res, out);
}

const SCENE_FILE_RE = /^scenes\/[\w .()-]+\.json$/;
const ASSET_FILE_RE = /^assets\/[\w .()\/-]+$/;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function apiSaveScene(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; file: string; doc: unknown };
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const dir = setDirOf(url);
  if (!SCENE_FILE_RE.test(body.file)) throw Object.assign(new Error('bad scene file'), { status: 400 });
  await writeFile(join(dir, body.file), JSON.stringify(body.doc, null, 2) + '\n', 'utf8');
  return json(res, { ok: true });
}

/** Export a set to CasparCG templates. Default target: projects/_export/<name>. */
async function apiExport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; mode?: 'external' | 'baked'; outDir?: string };
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const setDir = setDirOf(url);
  // relative paths resolve against the repo root, not the server CWD
  const outDir = body.outDir?.trim() ? resolve(repoRoot, body.outDir.trim()) : join(projectsDir, '_export', body.name);
  const parent = dirname(outDir);
  try {
    if (!(await stat(parent)).isDirectory()) throw new Error();
  } catch {
    throw Object.assign(new Error(`parent folder does not exist: ${parent}`), { status: 400 });
  }
  const result = await exportSet(setDir, outDir, body.mode ? { mode: body.mode } : {});
  return json(res, result);
}

/** Remove a scene from the set (and optionally delete its file). */
async function apiRemoveScene(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; file: string; deleteFile?: boolean };
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const dir = setDirOf(url);
  if (!SCENE_FILE_RE.test(body.file)) throw Object.assign(new Error('bad scene file'), { status: 400 });
  const setPath = join(dir, 'set.json');
  const set = JSON.parse(await readFile(setPath, 'utf8')) as { scenes: string[] };
  set.scenes = set.scenes.filter((s) => s !== body.file);
  await writeFile(setPath, JSON.stringify(set, null, 2) + '\n', 'utf8');
  if (body.deleteFile) {
    try {
      await unlink(join(dir, body.file));
    } catch {
      // already gone
    }
  }
  return json(res, { ok: true, scenes: set.scenes });
}

async function apiDeleteAssets(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; files: string[] };
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const dir = setDirOf(url);
  const deleted: string[] = [];
  for (const f of body.files ?? []) {
    if (!ASSET_FILE_RE.test(f) || f.includes('..')) continue;
    try {
      await unlink(join(dir, f));
      deleted.push(f);
    } catch {
      // already gone — fine
    }
  }
  return json(res, { deleted });
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
  components: string[];
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
        components?: string[];
        fonts?: { family: string; file: string }[];
      };
      out.push({ root, name: entry, scenes: doc.scenes ?? [], components: doc.components ?? [], fonts: doc.fonts ?? [] });
    } catch {
      // not a set folder — skip
    }
  }
  return out;
}
