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
import { mkdir, readFile, readdir, stat, writeFile, unlink, rename, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { exportSet, syncDir } from '@riposte/exporter';
import { importLoo } from '@riposte/importer';
import { startAmcp } from './amcp.ts';

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

// virtual CasparCG: AMCP in → SSE out → /playout renders it
startAmcp({
  listSets: async () => [...(await listSets(examplesDir, 'examples')), ...(await listSets(projectsDir, 'projects'))],
  broadcast,
  log: (msg) => console.log(msg),
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
  if (path === '/api/set/create' && req.method === 'POST') return apiCreateSet(req, res);
  if (path === '/api/set/import-loo' && req.method === 'POST') return apiImportLoo(url, req, res);
  if (path === '/api/assets/upload' && req.method === 'POST') return apiUploadAsset(url, req, res);
  if (path === '/api/scene' && req.method === 'PUT') return apiSaveScene(req, res);
  if (path === '/api/scene/create' && req.method === 'POST') return apiCreateScene(req, res);
  if (path === '/api/scene/remove' && req.method === 'POST') return apiRemoveScene(req, res);
  if (path === '/api/scene/rename' && req.method === 'POST') return apiRenameScene(req, res);
  if (path === '/api/assets/delete' && req.method === 'POST') return apiDeleteAssets(req, res);
  if (path === '/api/assets/rename' && req.method === 'POST') return apiRenameAsset(req, res);
  if (path === '/api/assets/rename-sequence' && req.method === 'POST') return apiRenameSequence(req, res);
  if (path === '/api/export' && req.method === 'POST') return apiExport(req, res);
  if (path === '/api/deploy' && req.method === 'POST') return apiDeploy(req, res);
  if (path === '/api/events') return apiEvents(req, res);
  if (path === '/api/mediafile') return apiMediaFile(url, res);
  if (path === '/api/open' && req.method === 'POST') return apiOpen(req, res);
  if (path === '/runtime.js') return file(res, runtimeJs);
  if (path.startsWith('/examples/')) return file(res, safeJoin(examplesDir, path.slice('/examples/'.length)));
  if (path.startsWith('/projects/')) return file(res, safeJoin(projectsDir, path.slice('/projects/'.length)));

  const rel = path === '/' ? 'index.html' : path.replace(/^\//, '');
  return file(res, safeJoin(publicDir, rel));
}

// ---- server→editor push channel (SSE) ---------------------------------------
// The editor subscribes to /api/events; external writers (MCP, scripts) show
// up live instead of waiting for a reload.

const sseClients = new Set<ServerResponse>();

function apiEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

function broadcast(event: string, payload: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch {
      sseClients.delete(client);
    }
  }
}

/** Navigate the running editor(s) to a set/scene/frame (MCP "open_scene"). */
async function apiOpen(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; file?: string; frame?: number };
  // validates root+name (throws on bad refs)
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  setDirOf(url);
  broadcast('open', { root: body.root, name: body.name, file: body.file, frame: body.frame });
  return json(res, { ok: true, listeners: sseClients.size });
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
  broadcast('scene-saved', { root: body.root, name: body.name, file: body.file });
  return json(res, { ok: true });
}

/** Export a set to CasparCG templates. Default target: <set-dir>/export. */
async function apiExport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; mode?: 'external' | 'baked'; outDir?: string };
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const setDir = setDirOf(url);
  // relative paths resolve against the repo root, not the server CWD
  const outDir = body.outDir?.trim() ? resolve(repoRoot, body.outDir.trim()) : join(setDir, 'export');
  const result = await exportSet(setDir, outDir, body.mode ? { mode: body.mode } : {});
  return json(res, result);
}

/**
 * Deploy = fresh incremental export to <set-dir>/export, then incremental
 * sync into the CasparCG template dir. Additive only — never deletes files
 * the target dir has and the export doesn't.
 */
async function apiDeploy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; targetDir: string; mode?: 'external' | 'baked' };
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const setDir = setDirOf(url);
  const targetDir = resolve(repoRoot, (body.targetDir ?? '').trim());
  if (!body.targetDir?.trim()) throw Object.assign(new Error('targetDir required'), { status: 400 });
  try {
    if (!(await stat(targetDir)).isDirectory()) throw new Error();
  } catch {
    throw Object.assign(new Error(`target folder does not exist: ${targetDir}`), { status: 400 });
  }
  const exportDir = join(setDir, 'export');
  const exported = await exportSet(setDir, exportDir, body.mode ? { mode: body.mode } : {});
  const synced = await syncDir(exportDir, targetDir);
  return json(res, { exported, synced, targetDir });
}

/** Raw request body as a Buffer (binary uploads). */
async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Create an empty set: projects/<name>/ with set.json and assets/. */
async function apiCreateSet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { name: string };
  const name = (body.name ?? '').trim();
  if (!/^[\w .()-]+$/.test(name)) throw Object.assign(new Error('bad set name'), { status: 400 });
  const dir = join(projectsDir, name);
  try {
    await stat(join(dir, 'set.json'));
    throw Object.assign(new Error(`set "${name}" already exists`), { status: 409 });
  } catch (err) {
    if ((err as { status?: number }).status === 409) throw err;
  }
  await mkdir(join(dir, 'assets'), { recursive: true });
  await mkdir(join(dir, 'scenes'), { recursive: true });
  const set = { formatVersion: 1, name, scenes: [], components: [], fonts: [] };
  await writeFile(join(dir, 'set.json'), JSON.stringify(set, null, 2) + '\n', 'utf8');
  return json(res, { ok: true, name });
}

/**
 * Import an uploaded .loo file into a set (?root=&name=&filename=).
 * The body is the raw file; it lands in a temp file so the existing
 * importer (shared asset pool, migration passes) does the real work.
 */
async function apiImportLoo(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const dir = setDirOf(url);
  const filename = basename(url.searchParams.get('filename') ?? 'upload.loo');
  const bytes = await readRawBody(req);
  if (bytes.length === 0) throw Object.assign(new Error('empty upload'), { status: 400 });
  // temp DIR + original file name — the importer names scenes after the file
  const tmpDir = join(tmpdir(), `riposte-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`);
  await mkdir(tmpDir, { recursive: true });
  const tmp = join(tmpDir, filename);
  await writeFile(tmp, bytes);
  try {
    const r = await importLoo(tmp, dir);
    return json(res, {
      ok: true,
      scenes: r.scenes,
      skipped: r.skipped,
      warnings: r.warnings,
      assets: { written: r.assetReport.written.length, deduplicated: r.assetReport.deduplicated.length },
    });
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

const FONT_EXT_RE = /\.(ttf|otf|woff2?)$/i;

/**
 * Upload one asset (?root=&name=&filename=, raw body). Importer collision
 * policy: same name + same bytes → skip; same name + different bytes →
 * hash-suffixed name. Fonts land in assets/fonts/ and are auto-registered
 * in set.json (family derived from the file name).
 */
async function apiUploadAsset(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const dir = setDirOf(url);
  const raw = basename(url.searchParams.get('filename') ?? '');
  if (!/^[\w .()-]+\.\w+$/.test(raw)) throw Object.assign(new Error('bad asset filename'), { status: 400 });
  const bytes = await readRawBody(req);
  if (bytes.length === 0) throw Object.assign(new Error('empty upload'), { status: 400 });

  const isFont = FONT_EXT_RE.test(raw);
  const subdir = isFont ? 'assets/fonts' : 'assets';
  await mkdir(join(dir, subdir), { recursive: true });

  let file = `${subdir}/${raw}`;
  let status = 'written';
  try {
    const existing = await readFile(join(dir, file));
    if (existing.equals(bytes)) {
      status = 'identical — skipped';
    } else {
      const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
      const ext = extname(raw);
      file = `${subdir}/${raw.slice(0, -ext.length)}-${hash}${ext}`;
      status = `name taken — stored as ${basename(file)}`;
      await writeFile(join(dir, file), bytes);
    }
  } catch {
    await writeFile(join(dir, file), bytes);
  }

  let family: string | undefined;
  if (isFont) {
    const setPath = join(dir, 'set.json');
    const set = JSON.parse(await readFile(setPath, 'utf8')) as { fonts?: { family: string; file: string }[] };
    set.fonts ??= [];
    if (!set.fonts.some((f) => f.file === file)) {
      family = raw.replace(/\.\w+$/, '').replace(/[_-]+/g, ' ').trim();
      set.fonts.push({ family, file });
      await writeFile(setPath, JSON.stringify(set, null, 2) + '\n', 'utf8');
    }
  }
  return json(res, { ok: true, file, status, family });
}

/** Create a scene file (new or duplicate) and register it in set.json. */
async function apiCreateScene(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; file: string; doc: unknown };
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const dir = setDirOf(url);
  if (!SCENE_FILE_RE.test(body.file)) throw Object.assign(new Error('bad scene file'), { status: 400 });
  try {
    await stat(join(dir, body.file));
    throw Object.assign(new Error(`"${body.file}" already exists`), { status: 409 });
  } catch (err) {
    if ((err as { status?: number }).status === 409) throw err;
  }
  await writeFile(join(dir, body.file), JSON.stringify(body.doc, null, 2) + '\n', 'utf8');
  const setPath = join(dir, 'set.json');
  const set = JSON.parse(await readFile(setPath, 'utf8')) as { scenes: string[] };
  if (!set.scenes.includes(body.file)) set.scenes.push(body.file);
  await writeFile(setPath, JSON.stringify(set, null, 2) + '\n', 'utf8');
  return json(res, { ok: true, file: body.file });
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

const DOC_FILE_RE = /^(scenes|components)\/[\w .()-]+\.json$/;

/** Every scene + component file registered in set.json. */
async function docFilesOf(dir: string): Promise<string[]> {
  const set = JSON.parse(await readFile(join(dir, 'set.json'), 'utf8')) as { scenes?: string[]; components?: string[] };
  return [...(set.scenes ?? []), ...(set.components ?? [])].filter((f) => DOC_FILE_RE.test(f));
}

/** Load each doc file, run the rewrite; write back the ones it changed. */
async function rewriteDocs(dir: string, rewrite: (doc: Record<string, unknown>) => boolean): Promise<string[]> {
  const changed: string[] = [];
  for (const file of await docFilesOf(dir)) {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(await readFile(join(dir, file), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rewrite(doc)) {
      await writeFile(join(dir, file), JSON.stringify(doc, null, 2) + '\n', 'utf8');
      changed.push(file);
    }
  }
  return changed;
}

/** All elements (layer elements + masks) of a scene doc. */
function docElements(doc: Record<string, unknown>): Record<string, unknown>[] {
  const comp = doc['composition'] as { layers?: { element: Record<string, unknown>; masks?: Record<string, unknown>[] }[] } | undefined;
  const out: Record<string, unknown>[] = [];
  for (const l of comp?.layers ?? []) {
    if (l.element) out.push(l.element);
    out.push(...(l.masks ?? []));
  }
  return out;
}

/**
 * Rename a scene or component: file on disk, set.json entry, doc.name, and —
 * for components — every compositionId reference across the set.
 */
async function apiRenameScene(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; file: string; newName: string };
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const dir = setDirOf(url);
  const newName = (body.newName ?? '').trim();
  if (!DOC_FILE_RE.test(body.file)) throw Object.assign(new Error('bad scene file'), { status: 400 });
  if (!/^[\w .()-]+$/.test(newName)) throw Object.assign(new Error('bad new name'), { status: 400 });
  // components also live under scenes/ — set.json array membership is the kind
  const setPath = join(dir, 'set.json');
  const set = JSON.parse(await readFile(setPath, 'utf8')) as Record<string, string[]>;
  const kind = (set['components'] ?? []).includes(body.file) ? 'components' : 'scenes';
  const newFile = body.file.replace(/[^/]+\.json$/, `${newName}.json`);
  if (newFile === body.file) return json(res, { ok: true, file: body.file });
  try {
    await stat(join(dir, newFile));
    throw Object.assign(new Error(`"${newName}" already exists`), { status: 409 });
  } catch (err) {
    if ((err as { status?: number }).status === 409) throw err; // stat succeeded → clash
  }

  const doc = JSON.parse(await readFile(join(dir, body.file), 'utf8')) as Record<string, unknown>;
  doc['name'] = newName;
  await writeFile(join(dir, newFile), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  await unlink(join(dir, body.file));

  set[kind] = (set[kind] ?? []).map((f) => (f === body.file ? newFile : f));
  await writeFile(setPath, JSON.stringify(set, null, 2) + '\n', 'utf8');

  // components are referenced by file path — keep every instance pointing at it
  const changed =
    kind === 'components'
      ? await rewriteDocs(dir, (d) => {
          let touched = false;
          for (const el of docElements(d)) {
            if (el['type'] === 'composition' && el['compositionId'] === body.file) {
              el['compositionId'] = newFile;
              touched = true;
            }
          }
          return touched;
        })
      : [];
  return json(res, { ok: true, file: newFile, changed });
}

/** Rename an asset file and rewrite every reference to it across the set. */
async function apiRenameAsset(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; from: string; to: string };
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const dir = setDirOf(url);
  const { from } = body;
  const to = (body.to ?? '').trim();
  if (!ASSET_FILE_RE.test(from) || from.includes('..')) throw Object.assign(new Error('bad asset path'), { status: 400 });
  if (!ASSET_FILE_RE.test(to) || to.includes('..')) throw Object.assign(new Error('bad new asset path'), { status: 400 });
  if (from === to) return json(res, { ok: true, changed: [] });
  try {
    await stat(join(dir, to));
    throw Object.assign(new Error(`"${to}" already exists`), { status: 409 });
  } catch (err) {
    if ((err as { status?: number }).status === 409) throw err;
  }
  await rename(join(dir, from), join(dir, to));

  const changed = await rewriteDocs(dir, (doc) => {
    let touched = false;
    for (const el of docElements(doc)) {
      if (el['asset'] === from) {
        el['asset'] = to;
        touched = true;
      }
      if (el['placeholder'] === from) {
        el['placeholder'] = to;
        touched = true;
      }
      const frames = el['frames'];
      if (Array.isArray(frames)) {
        for (let i = 0; i < frames.length; i++) {
          if (frames[i] === from) {
            frames[i] = to;
            touched = true;
          }
        }
      }
    }
    return touched;
  });

  // fonts live in set.json
  const setPath = join(dir, 'set.json');
  const set = JSON.parse(await readFile(setPath, 'utf8')) as { fonts?: { family: string; file: string }[] };
  let fontsTouched = false;
  for (const f of set.fonts ?? []) {
    if (f.file === from) {
      f.file = to;
      fontsTouched = true;
    }
  }
  if (fontsTouched) {
    await writeFile(setPath, JSON.stringify(set, null, 2) + '\n', 'utf8');
    changed.push('set.json');
  }
  return json(res, { ok: true, changed });
}

/**
 * Rename a whole image sequence: every frame moves to assets/<newName>/<frame#>.<ext>
 * — the folder carries the sequence name, so frame files keep only their number —
 * and every reference across the set (asset/placeholder/frames) is rewritten.
 */
async function apiRenameSequence(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; files: string[]; newName: string };
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const dir = setDirOf(url);
  const newName = (body.newName ?? '').trim();
  if (!/^[\w .()-]+$/.test(newName)) throw Object.assign(new Error('bad new name'), { status: 400 });
  const files = body.files ?? [];
  if (files.length === 0) throw Object.assign(new Error('no files'), { status: 400 });

  // target = frame number + extension; a frame without a number keeps its basename
  const targetOf = new Map<string, string>(); // to → from, catches number collisions
  const mapping = new Map<string, string>(); // from → to, only real moves
  for (const from of files) {
    if (!ASSET_FILE_RE.test(from) || from.includes('..')) throw Object.assign(new Error('bad asset path'), { status: 400 });
    const base = basename(from);
    const m = /^.*?(\d{2,})(\.\w+)$/.exec(base);
    const to = `assets/${newName}/${m ? `${m[1] ?? ''}${m[2] ?? ''}` : base}`;
    if (targetOf.has(to)) throw Object.assign(new Error(`frame numbers collide: "${to}"`), { status: 400 });
    targetOf.set(to, from);
    if (to !== from) mapping.set(from, to);
  }
  if (mapping.size === 0) return json(res, { ok: true, changed: [], moved: 0 });

  const sources = new Set(files);
  for (const to of mapping.values()) {
    if (sources.has(to)) continue; // occupied by a frame of this sequence (handled above)
    try {
      await stat(join(dir, to));
      throw Object.assign(new Error(`"${to}" already exists`), { status: 409 });
    } catch (err) {
      if ((err as { status?: number }).status === 409) throw err;
    }
  }

  await mkdir(join(dir, 'assets', newName), { recursive: true });
  for (const [from, to] of mapping) await rename(join(dir, from), join(dir, to));

  // drop source folders the move left empty
  for (const d of new Set(files.map((f) => dirname(f)))) {
    if (d === 'assets' || d === '.') continue;
    try {
      if ((await readdir(join(dir, d))).length === 0) await rmdir(join(dir, d));
    } catch {
      // still in use or already gone — keep
    }
  }

  const changed = await rewriteDocs(dir, (doc) => {
    let touched = false;
    for (const el of docElements(doc)) {
      for (const k of ['asset', 'placeholder']) {
        const v = el[k];
        if (typeof v === 'string' && mapping.has(v)) {
          el[k] = mapping.get(v);
          touched = true;
        }
      }
      const frames = el['frames'];
      if (Array.isArray(frames)) {
        for (let i = 0; i < frames.length; i++) {
          const v = frames[i] as unknown;
          if (typeof v === 'string' && mapping.has(v)) {
            frames[i] = mapping.get(v);
            touched = true;
          }
        }
      }
    }
    return touched;
  });
  return json(res, { ok: true, changed, moved: mapping.size });
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

/**
 * Serve a local media file by absolute path — the playout page rewrites
 * ControlCenter's absolute CasparCG media paths (flags, logos) to this
 * endpoint, since a browser page cannot load disk paths the way Caspar's
 * CEF can. Image/font extensions only.
 */
const MEDIA_EXT_RE = /\.(png|jpe?g|webp|gif|svg|bmp|ttf|otf|woff2?)$/i;
async function apiMediaFile(url: URL, res: ServerResponse): Promise<void> {
  const p = url.searchParams.get('p') ?? '';
  const abs = /^([A-Za-z]:[\\/]|\\\\)/.test(p);
  if (!abs || p.includes('..') || !MEDIA_EXT_RE.test(p)) throw Object.assign(new Error('bad media path'), { status: 400 });
  return file(res, p);
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
