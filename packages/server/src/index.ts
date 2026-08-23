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
import { mkdir, readFile, readdir, stat, writeFile, unlink, rename, rmdir, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, extname, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { exportSet, syncDir, checkContract, type ContractReport } from '@riposte/exporter';
import { importLoo } from '@riposte/importer';
import { startAmcp, getAmcpState, setAmcpPorts } from './amcp.ts';
import { loadConfig, getConfig, saveConfig } from './config.ts';
import { zipSync, unzipSync } from 'fflate';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * Two layouts:
 * - repo (dev): src/index.ts inside packages/server — bench at /, editor via vite :5719
 * - packaged (portable zip): server.js at the dist root with public/, editor/,
 *   runtime/, projects/, examples/ as siblings — the built editor is served at /
 *   and the bench moves to /bench. Detection: a public/ dir next to the script.
 */
const packaged = existsSync(join(here, 'public'));
const serverRoot = packaged ? here : resolve(here, '..');
const repoRoot = packaged ? here : resolve(serverRoot, '..', '..');
const publicDir = join(serverRoot, 'public');
// riposte.config.json next to the server — env vars override it per run
const cfg = loadConfig(serverRoot);
const examplesDir = process.env['RIPOSTE_EXAMPLES_DIR'] ?? cfg.examplesDir ?? join(repoRoot, 'examples');
const projectsDir = process.env['RIPOSTE_PROJECTS_DIR'] ?? cfg.projectsDir ?? join(repoRoot, 'projects');
const runtimeJs = packaged ? join(here, 'runtime', 'riposte.js') : join(repoRoot, 'packages', 'runtime', 'dist', 'riposte.js');
const editorDist = packaged ? join(here, 'editor') : null;

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

const port = Number(process.env['RIPOSTE_PORT'] ?? cfg.port);

const httpServer = createServer((req, res) => {
  void handle(req, res).catch((err: Error & { status?: number }) => {
    console.error(err);
    res.writeHead(err.status ?? 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message ?? 'internal error' }));
  });
});
// Node's 5s keep-alive default races clients that reuse idle sockets without
// retry (the vite proxy): a request written onto a socket we're just closing
// dies with a reset — the editor flashed "failed to fetch" while the work
// (e.g. an export) completed anyway. headersTimeout must stay above it.
httpServer.keepAliveTimeout = 120_000;
httpServer.headersTimeout = 125_000;
httpServer.listen(port, () => {
  console.log(`riposte server listening on http://localhost:${port}${packaged ? ' (packaged mode: editor at /, bench at /bench)' : ''}`);
  if (process.argv.includes('--open')) {
    const url = `http://localhost:${port}`;
    const [cmd, args] =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
      process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).unref();
  }
});

// the zip ships without a projects dir (empty dirs don't survive archives)
void mkdir(projectsDir, { recursive: true }).catch(() => {});

// virtual CasparCG: AMCP in → SSE out → /playout renders it
void startAmcp({
  listSets: async () => [...(await listSets(examplesDir, 'examples')), ...(await listSets(projectsDir, 'projects'))],
  broadcast,
  log: (msg) => console.log(msg),
  ports: {
    main: Number(process.env['RIPOSTE_AMCP_PORT'] ?? cfg.amcpPort),
    preview: Number(process.env['RIPOSTE_AMCP_PREVIEW_PORT'] ?? cfg.amcpPreviewPort),
  },
  persistPorts: (p) => {
    saveConfig({ amcpPort: p['main'] ?? cfg.amcpPort, amcpPreviewPort: p['preview'] ?? cfg.amcpPreviewPort });
  },
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
  if (path === '/api/set/delete' && req.method === 'POST') return apiDeleteSet(req, res);
  if (path === '/api/set/duplicate' && req.method === 'POST') return apiDuplicateSet(req, res);
  if (path === '/api/set/save-file' && req.method === 'POST') return apiSaveSetFile(req, res);
  if (path === '/api/set/open-file' && req.method === 'POST') return apiOpenSetFile(url, req, res);
  if (path === '/api/assets/upload' && req.method === 'POST') return apiUploadAsset(url, req, res);
  if (path === '/api/scene' && req.method === 'PUT') return apiSaveScene(req, res);
  if (path === '/api/scene/create' && req.method === 'POST') return apiCreateScene(req, res);
  if (path === '/api/scene/remove' && req.method === 'POST') return apiRemoveScene(req, res);
  if (path === '/api/scene/rename' && req.method === 'POST') return apiRenameScene(req, res);
  if (path === '/api/scene/convert' && req.method === 'POST') return apiConvertScene(req, res);
  if (path === '/api/preset/save' && req.method === 'POST') return apiSavePreset(req, res);
  if (path === '/api/preset/delete' && req.method === 'POST') return apiDeletePreset(req, res);
  if (path === '/api/preset/stock' && req.method === 'POST') return apiStockPresets(req, res);
  if (path === '/api/assets/delete' && req.method === 'POST') return apiDeleteAssets(req, res);
  if (path === '/api/assets/rename' && req.method === 'POST') return apiRenameAsset(req, res);
  if (path === '/api/assets/rename-sequence' && req.method === 'POST') return apiRenameSequence(req, res);
  if (path === '/api/export' && req.method === 'POST') return apiExport(req, res);
  if (path === '/api/deploy' && req.method === 'POST') return apiDeploy(req, res);
  if (path === '/api/events') return apiEvents(req, res);
  if (path === '/api/mediafile') return apiMediaFile(url, res);
  if (path === '/api/amcp' && req.method === 'POST') return json(res, await setAmcpPorts((await readBody(req)) as Record<string, unknown>));
  if (path === '/api/amcp') return json(res, getAmcpState());
  if (path === '/api/contract-config' && req.method === 'POST') return apiContractConfig(req, res);
  if (path === '/api/config') return json(res, getConfig()); // read-only; writes go through the specific actions or the file itself
  if (path === '/api/contract') return apiContract(url, res);
  if (path === '/api/set/settings' && req.method === 'POST') return apiSetSettings(req, res);
  if (path === '/api/bench' && req.method === 'POST') return apiBench(req, res);
  if (path === '/api/open' && req.method === 'POST') return apiOpen(req, res);
  if (path === '/runtime.js') return file(res, runtimeJs);
  // /bench works in both modes (in dev / is also the bench; the editor's Bench button uses this)
  if (path === '/bench') return file(res, join(publicDir, 'index.html'));
  if (path.startsWith('/examples/')) return file(res, safeJoin(examplesDir, path.slice('/examples/'.length)));
  if (path.startsWith('/projects/')) return file(res, safeJoin(projectsDir, path.slice('/projects/'.length)));

  if (editorDist) {
    // packaged: the built editor owns / (its bundles live under /assets/); bench keeps working at /bench
    if (path === '/' || path === '/index.html') return file(res, join(editorDist, 'index.html'));
    if (path.startsWith('/assets/')) return file(res, safeJoin(editorDist, path.slice(1)));
  }

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
  // NOT 'open' — that name collides with EventSource's native connect event
  // (fires with no data on every reconnect → JSON.parse crash in the client).
  broadcast('open-scene', { root: body.root, name: body.name, file: body.file, frame: body.frame });
  return json(res, { ok: true, listeners: sseClients.size });
}

/** Resolve a set directory from ?root=&name=, guarding against traversal. */
/** A set name must be a plain folder name — never a path. Rejects `..`,
 * dot/space-only names, and anything the char whitelist doesn't cover. */
function validSetName(name: string): boolean {
  return /^[\w .()-]+$/.test(name) && !name.includes('..') && !/^[ .]+$/.test(name);
}

function setDirOf(url: URL): string {
  const root = ROOTS[url.searchParams.get('root') ?? ''];
  const name = url.searchParams.get('name') ?? '';
  if (!root || !validSetName(name)) throw Object.assign(new Error('bad set ref'), { status: 400 });
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
  // Intro/outro presets ({intros,outros}/*.json) — name (sans .json) → preset doc.
  const presets = async (folder: string): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = {};
    try {
      for (const entry of await readdir(join(dir, folder), { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          out[entry.name.slice(0, -5)] = JSON.parse(await readFile(join(dir, folder, entry.name), 'utf8'));
        } catch {
          /* unreadable preset — skip */
        }
      }
    } catch {
      /* no folder */
    }
    return out;
  };
  return json(res, { set, scenes, outros: await presets('outros'), intros: await presets('intros') });
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

// ---- intro/outro effect presets ({outros,intros}/<name>.json) -----------------

const PRESET_FOLDERS = new Set(['outros', 'intros']);
const PRESET_NAME_RE = /^[\w-]+$/;

function presetPathOf(body: { root: string; name: string; folder: string }, presetName: string): string {
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const dir = setDirOf(url);
  if (!PRESET_FOLDERS.has(body.folder) || !PRESET_NAME_RE.test(presetName))
    throw Object.assign(new Error('bad preset ref'), { status: 400 });
  return join(dir, body.folder, `${presetName}.json`);
}

/**
 * Stock presets shipped with the app (server/stock in the repo, stock/ in the
 * packaged dist). Copied into sets — never resolved at runtime, so sets stay
 * self-contained and portable.
 */
const stockDir = join(serverRoot, 'stock');

/** Copy stock presets MISSING from the set (no overwrites); names per folder. */
async function seedStockPresets(dir: string): Promise<Record<string, string[]>> {
  const added: Record<string, string[]> = { intros: [], outros: [] };
  for (const folder of ['intros', 'outros']) {
    let entries: string[];
    try {
      entries = await readdir(join(stockDir, folder));
    } catch {
      continue; // no stock shipped — nothing to seed
    }
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      const target = join(dir, folder, f);
      if (existsSync(target)) continue;
      await mkdir(join(dir, folder), { recursive: true });
      await writeFile(target, await readFile(join(stockDir, folder, f), 'utf8'), 'utf8');
      added[folder]!.push(f.slice(0, -5));
    }
  }
  return added;
}

/** Copy missing stock presets into an existing set (the Set Options button). */
async function apiStockPresets(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string };
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const dir = setDirOf(url);
  const added = await seedStockPresets(dir);
  for (const folder of ['intros', 'outros']) {
    for (const n of added[folder] ?? []) {
      const preset: unknown = JSON.parse(await readFile(join(dir, folder, `${n}.json`), 'utf8'));
      broadcast('preset-saved', { root: body.root, name: body.name, folder, preset });
    }
  }
  return json(res, { ok: true, added });
}

async function apiSavePreset(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; folder: string; preset: { name?: unknown } };
  const presetName = typeof body.preset?.name === 'string' ? body.preset.name : '';
  const path = presetPathOf(body, presetName);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(body.preset, null, 2) + '\n', 'utf8');
  broadcast('preset-saved', { root: body.root, name: body.name, folder: body.folder, preset: body.preset });
  return json(res, { ok: true });
}

async function apiDeletePreset(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; folder: string; presetName: string };
  await unlink(presetPathOf(body, body.presetName));
  broadcast('preset-deleted', { root: body.root, name: body.name, folder: body.folder, presetName: body.presetName });
  return json(res, { ok: true });
}

/** Export a set to CasparCG templates. Default target: <set-dir>/export. */
async function apiExport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; mode?: 'external' | 'baked' | 'ograf' | 'spx'; outDir?: string; spxFields?: { field?: string; ftype: string; title?: string; value?: string }[]; spxScene?: string; ografAssets?: 'shared' | 'bundled'; fitToWindow?: boolean };
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const setDir = setDirOf(url);
  // relative paths resolve against the repo root, not the server CWD
  const outDir = body.outDir?.trim() ? resolve(repoRoot, body.outDir.trim()) : join(setDir, 'export');
  if (body.fitToWindow !== undefined && typeof body.fitToWindow !== 'boolean') {
    throw Object.assign(new Error('fitToWindow must be boolean'), { status: 400 });
  }
  // mode/ografAssets/fitToWindow are per-export overrides (undefined = the set's settings)
  const result = await exportSet(setDir, outDir, { mode: body.mode, ografAssets: body.ografAssets, fitToWindow: body.fitToWindow, spxFields: body.spxFields, spxScene: body.spxScene });
  // remember the target per set (survives browser switches, unlike localStorage);
  // an explicit empty target forgets it → back to <set>/export
  const dirs = { ...getConfig().exportDirs };
  if (body.outDir?.trim()) dirs[`${body.root}/${body.name}`] = body.outDir.trim();
  else delete dirs[`${body.root}/${body.name}`];
  saveConfig({ exportDirs: dirs });
  return json(res, { ...result, contract: await runContractChecks(setDir) });
}

// ---- mapping-contract check ---------------------------------------------------
// The ControlCenter graphics_sets folder is per-machine config (in
// riposte.config.json). Every export/deploy re-checks the contract and the
// editor surfaces dead mappings — a break shows on air as a silently blank field.
function getContractDir(): string | null {
  return getConfig().contractDir;
}

/** Run the contract check against every graphics-set config in the folder. */
async function runContractChecks(setDir: string): Promise<ContractReport[] | null> {
  const dir = getContractDir();
  if (!dir) return null;
  const reports: ContractReport[] = [];
  try {
    for (const f of await readdir(dir)) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      try {
        const r = await checkContract(setDir, join(dir, f));
        if (r.scenes.length > 0) reports.push(r); // configs for other sets: skip
      } catch {
        // unparseable config — not ours to police
      }
    }
  } catch {
    return null; // folder missing/unreadable — behave like "not configured"
  }
  return reports;
}

async function apiContract(url: URL, res: ServerResponse): Promise<void> {
  const setDir = setDirOf(url);
  const dir = getContractDir();
  return json(res, { dir, reports: await runContractChecks(setDir) });
}

async function apiContractConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { dir?: string };
  const dir = (body.dir ?? '').trim();
  if (dir) {
    try {
      if (!(await stat(dir)).isDirectory()) throw new Error();
    } catch {
      throw Object.assign(new Error(`not a folder: ${dir}`), { status: 400 });
    }
  }
  saveConfig({ contractDir: dir || null });
  return json(res, { dir: dir || null });
}

/**
 * Deploy = fresh incremental export to <set-dir>/export, then incremental
 * sync into the CasparCG template dir. Additive only — never deletes files
 * the target dir has and the export doesn't.
 */
async function apiDeploy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; targetDir: string; mode?: 'external' | 'baked' | 'ograf' | 'spx'; force?: boolean };
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
  const synced = await syncDir(exportDir, targetDir, body.force === true);
  saveConfig({ deployDir: body.targetDir.trim() }); // seed for the next Deploy dialog, any browser
  return json(res, { exported, synced, targetDir, contract: await runContractChecks(setDir) });
}

/**
 * Remote-control the live bench tab (MCP bench_* tools): broadcast the command
 * over SSE; the bench page applies it (open scene / fill variables / transport).
 */
async function apiBench(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { action?: string };
  const actions = ['open', 'update', 'play', 'next', 'stop', 'reset', 'seek'];
  if (!actions.includes(body.action ?? '')) {
    throw Object.assign(new Error(`action must be one of ${actions.join('/')}`), { status: 400 });
  }
  broadcast('bench', body);
  return json(res, { ok: true, listeners: sseClients.size });
}

/** Merge validated export settings into a set's set.json. */
async function apiSetSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as {
    root: string;
    name: string;
    export?: { mode?: string; preloadAssets?: boolean; fitToWindow?: boolean; imageFormat?: string; webpQuality?: number | string; ografAssets?: string };
  };
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const dir = setDirOf(url);
  const e = body.export ?? {};
  const patch: Record<string, unknown> = {};
  if (e.mode !== undefined) {
    if (e.mode !== 'external' && e.mode !== 'baked' && e.mode !== 'ograf' && e.mode !== 'spx') throw Object.assign(new Error('bad mode'), { status: 400 });
    patch['mode'] = e.mode;
  }
  if (e.preloadAssets !== undefined) patch['preloadAssets'] = !!e.preloadAssets;
  if (e.fitToWindow !== undefined) {
    if (typeof e.fitToWindow !== 'boolean') throw Object.assign(new Error('fitToWindow must be boolean'), { status: 400 });
    patch['fitToWindow'] = e.fitToWindow;
  }
  if (e.imageFormat !== undefined) {
    if (e.imageFormat !== 'png' && e.imageFormat !== 'webp') throw Object.assign(new Error('bad imageFormat'), { status: 400 });
    patch['imageFormat'] = e.imageFormat;
  }
  if (e.webpQuality !== undefined) {
    const q = e.webpQuality === 'lossless' ? 'lossless' : Number(e.webpQuality);
    if (q !== 'lossless' && (!Number.isFinite(q) || q < 1 || q > 100)) {
      throw Object.assign(new Error('webpQuality must be 1-100 or "lossless"'), { status: 400 });
    }
    patch['webpQuality'] = q;
  }
  if (e.ografAssets !== undefined) {
    if (e.ografAssets !== 'shared' && e.ografAssets !== 'bundled') throw Object.assign(new Error('bad ografAssets'), { status: 400 });
    patch['ografAssets'] = e.ografAssets;
  }
  const setPath = join(dir, 'set.json');
  const set = JSON.parse(await readFile(setPath, 'utf8')) as { export?: Record<string, unknown> };
  set.export = { mode: 'external', preloadAssets: true, ...set.export, ...patch };
  await writeFile(setPath, JSON.stringify(set, null, 2) + '\n', 'utf8');
  return json(res, { ok: true, export: set.export });
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
  if (!validSetName(name)) throw Object.assign(new Error('bad set name'), { status: 400 });
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
  await seedStockPresets(dir); // every new set starts with the stock intros/outros
  broadcast('set-created', { root: 'projects', name });
  return json(res, { ok: true, name });
}

/** Delete a set folder entirely. Only allowed for sets in projects/ (not examples/). */
async function apiDeleteSet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string };
  if (body.root !== 'projects') throw Object.assign(new Error('can only delete sets in projects/'), { status: 400 });
  // rm -rf on user input: the name must be a validated plain folder name
  if (!validSetName(body.name ?? '')) throw Object.assign(new Error('bad set name'), { status: 400 });
  const dir = join(projectsDir, body.name);
  try {
    await stat(join(dir, 'set.json'));
  } catch {
    throw Object.assign(new Error(`set "${body.name}" not found`), { status: 404 });
  }
  await rm(dir, { recursive: true, force: true });
  broadcast('set-deleted', { root: body.root, name: body.name });
  return json(res, { ok: true });
}

/** Duplicate a set under a new name. Copies to projects/<newName>/. */
async function apiDuplicateSet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; newName: string };
  const newName = (body.newName ?? '').trim();
  if (!validSetName(newName)) {
    throw Object.assign(new Error('bad set name'), { status: 400 });
  }
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const srcDir = setDirOf(url);
  const dstDir = join(projectsDir, newName);
  try {
    await stat(join(dstDir, 'set.json'));
    throw Object.assign(new Error(`set "${newName}" already exists`), { status: 409 });
  } catch (err) {
    if ((err as { status?: number }).status === 409) throw err;
  }
  await copyDir(srcDir, dstDir);
  // Update the set name in the copied set.json
  const set = JSON.parse(await readFile(join(dstDir, 'set.json'), 'utf8')) as { name: string };
  set.name = newName;
  await writeFile(join(dstDir, 'set.json'), JSON.stringify(set, null, 2) + '\n', 'utf8');
  broadcast('set-created', { root: 'projects', name: newName });
  return json(res, { ok: true, name: newName });
}

/** Regenerable per-set dirs that a duplicate must not drag along (a big set's
 * export/ + .webp-cache/ can be hundreds of MB of derivable data). */
const COPY_SKIP = new Set(['export', '_export', '_ab', '.webp-cache', '.git']);

/** Recursive directory copy for set duplication. */
async function copyDir(src: string, dst: string): Promise<void> {
  await cp(src, dst, {
    recursive: true,
    // s === src: never filter the root itself (a set could be named "export")
    filter: (s) => s === src || !COPY_SKIP.has(basename(s)),
  });
}

// ---- .set archives (whole-set transport between machines) ---------------------
// A .set file is a zip of the set folder (set.json at the archive root), minus
// the regenerable COPY_SKIP dirs. Import merges nothing: it lands as a fresh
// set folder in projects/ (overwrite = replace, never merge).

/** No recompression for formats that are already compressed. */
const STORED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.woff', '.woff2', '.mp4']);

/** Zip a .set file and write it to a caller-chosen path (folder remembered). */
async function apiSaveSetFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; targetPath: string };
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const setDir = setDirOf(url);
  let target = resolve(repoRoot, (body.targetPath ?? '').trim());
  if (!body.targetPath?.trim()) throw Object.assign(new Error('targetPath required'), { status: 400 });
  try {
    if ((await stat(target)).isDirectory()) target = join(target, `${body.name}.set`);
  } catch {
    // not an existing dir — treat as a file path
  }
  if (!target.toLowerCase().endsWith('.set')) target += '.set';
  try {
    if (!(await stat(dirname(target))).isDirectory()) throw new Error();
  } catch {
    throw Object.assign(new Error(`target folder does not exist: ${dirname(target)}`), { status: 400 });
  }

  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  let files = 0;
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(join(setDir, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!COPY_SKIP.has(e.name)) await walk(relPath);
      } else if (e.isFile()) {
        entries[relPath] = [await readFile(join(setDir, relPath)), { level: STORED_EXT.has(extname(e.name).toLowerCase()) ? 0 : 6 }];
        files++;
      }
    }
  };
  await walk('');
  const bytes = zipSync(entries);
  await writeFile(target, bytes);
  saveConfig({ setFileDir: dirname(target) }); // seed the next save prompt
  return json(res, { ok: true, file: target, files, bytes: bytes.length });
}

/** Zip entry names must stay strictly inside the target set folder. */
const SET_ENTRY_RE = /^[\w .()-]+(\/[\w .()-]+)*$/;

/**
 * Import an uploaded .set archive as a new set in projects/
 * (?filename=&mode=&newName=). Collision without mode → 409 {exists} and the
 * editor asks; mode=overwrite replaces the folder, mode=rename uses newName.
 */
async function apiOpenSetFile(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bytes = await readRawBody(req);
  if (bytes.length === 0) throw Object.assign(new Error('empty upload'), { status: 400 });
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw Object.assign(new Error('not a .set archive (unzip failed)'), { status: 400 });
  }
  // tolerate an archive that wraps the set in a single top-level folder
  if (!entries['set.json']) {
    const tops = new Set(Object.keys(entries).map((k) => k.split('/')[0]));
    const top = tops.size === 1 ? [...tops][0] : null;
    if (top && entries[`${top}/set.json`]) {
      const inner: Record<string, Uint8Array> = {};
      for (const [k, v] of Object.entries(entries)) inner[k.slice(top.length + 1)] = v;
      entries = inner;
    } else {
      throw Object.assign(new Error('archive has no set.json — not a .set file'), { status: 400 });
    }
  }

  let setDoc: { name?: unknown };
  try {
    setDoc = JSON.parse(Buffer.from(entries['set.json']!).toString('utf8')) as { name?: unknown };
  } catch {
    throw Object.assign(new Error('set.json in the archive is not valid JSON'), { status: 400 });
  }
  const upload = basename(url.searchParams.get('filename') ?? '').replace(/\.set$/i, '');
  const originalName = typeof setDoc.name === 'string' && validSetName(setDoc.name) ? setDoc.name : upload;
  const mode = url.searchParams.get('mode'); // '' | 'overwrite' | 'rename'
  const name = mode === 'rename' ? (url.searchParams.get('newName') ?? '').trim() : originalName;
  if (!validSetName(name)) throw Object.assign(new Error('bad set name'), { status: 400 });

  const dir = join(projectsDir, name);
  const exists = existsSync(join(dir, 'set.json'));
  if (exists && mode !== 'overwrite') {
    if (mode === 'rename') throw Object.assign(new Error(`set "${name}" already exists`), { status: 409 });
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ exists: true, name }));
    return;
  }

  // validate every path BEFORE touching the disk (zip-slip: "../", absolute, drive letters)
  const files = Object.entries(entries).filter(([k]) => !k.endsWith('/'));
  for (const [k] of files) {
    if (!SET_ENTRY_RE.test(k) || k.split('/').some((seg) => seg === '..' || /^[ .]+$/.test(seg))) {
      throw Object.assign(new Error(`unsafe path in archive: ${k}`), { status: 400 });
    }
  }

  if (exists) await rm(dir, { recursive: true, force: true }); // overwrite = replace, never merge
  for (const [k, v] of files) {
    if (COPY_SKIP.has(k.split('/')[0]!)) continue; // stale export/ etc. in a hand-made zip
    await mkdir(dirname(join(dir, k)), { recursive: true });
    await writeFile(join(dir, k), v);
  }
  if (name !== originalName) {
    // renamed on import — keep set.json's name in sync with the folder
    const set = JSON.parse(await readFile(join(dir, 'set.json'), 'utf8')) as { name: string };
    set.name = name;
    await writeFile(join(dir, 'set.json'), JSON.stringify(set, null, 2) + '\n', 'utf8');
  }
  broadcast('set-created', { root: 'projects', name });
  return json(res, { ok: true, name, files: files.length, overwritten: exists });
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
  const body = (await readBody(req)) as { root: string; name: string; file: string; doc: unknown; kind?: string };
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
  const set = JSON.parse(await readFile(setPath, 'utf8')) as { scenes: string[]; components?: string[] };
  if (body.kind === 'component') {
    set.components ??= [];
    if (!set.components.includes(body.file)) set.components.push(body.file);
  } else if (!set.scenes.includes(body.file)) {
    set.scenes.push(body.file);
  }
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
  const set = JSON.parse(await readFile(setPath, 'utf8')) as { scenes: string[]; components?: string[] };
  // removing a component that is still embedded would silently break scenes
  if ((set.components ?? []).includes(body.file)) {
    const embeddedIn = await embedsOf(dir, body.file);
    if (embeddedIn.length > 0) {
      throw Object.assign(new Error(`still embedded in ${embeddedIn.join(', ')} — remove those instances first`), { status: 409 });
    }
  }
  set.scenes = set.scenes.filter((s) => s !== body.file);
  if (set.components) set.components = set.components.filter((s) => s !== body.file);
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

/** Scenes/components of the set that embed `file` as a composition element. */
async function embedsOf(dir: string, file: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of await docFilesOf(dir)) {
    if (f === file) continue;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(await readFile(join(dir, f), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (docElements(doc).some((el) => el['type'] === 'composition' && el['compositionId'] === file)) out.push(f);
  }
  return out;
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
 * Move a doc between set.json's scenes and components lists — the file stays
 * where it is (components live under scenes/ too; membership IS the kind).
 * Demoting a component that is still embedded somewhere is refused: exports
 * resolve embeds from set.components only, so it would break those scenes.
 */
async function apiConvertScene(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root: string; name: string; file: string; to: string };
  const url = new URL(`/?root=${encodeURIComponent(body.root)}&name=${encodeURIComponent(body.name)}`, 'http://x');
  const dir = setDirOf(url);
  if (!DOC_FILE_RE.test(body.file)) throw Object.assign(new Error('bad scene file'), { status: 400 });
  if (body.to !== 'component' && body.to !== 'scene') throw Object.assign(new Error('bad target kind'), { status: 400 });
  if (body.to === 'scene') {
    const embeddedIn = await embedsOf(dir, body.file);
    if (embeddedIn.length > 0) {
      throw Object.assign(new Error(`still embedded in ${embeddedIn.join(', ')} — remove those instances first`), { status: 409 });
    }
  }
  const setPath = join(dir, 'set.json');
  const set = JSON.parse(await readFile(setPath, 'utf8')) as { scenes?: string[]; components?: string[] };
  set.scenes = (set.scenes ?? []).filter((f) => f !== body.file);
  set.components = (set.components ?? []).filter((f) => f !== body.file);
  (body.to === 'component' ? set.components : set.scenes).push(body.file);
  await writeFile(setPath, JSON.stringify(set, null, 2) + '\n', 'utf8');
  return json(res, { ok: true, scenes: set.scenes, components: set.components });
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
  export?: Record<string, unknown>;
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
        export?: Record<string, unknown>;
      };
      out.push({
        root,
        name: entry,
        scenes: doc.scenes ?? [],
        components: doc.components ?? [],
        fonts: doc.fonts ?? [],
        ...(doc.export ? { export: doc.export } : {}),
      });
    } catch {
      // not a set folder — skip
    }
  }
  return out;
}
