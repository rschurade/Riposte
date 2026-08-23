#!/usr/bin/env node
/**
 * @riposte/mcp — MCP server exposing Riposte to AI clients (Claude Desktop,
 * Claude Code, claude.ai) as SEMANTIC tools: list/inspect scenes, edit
 * element properties (validated), render frames to images (the visual
 * feedback loop), export and deploy.
 *
 * Thin adapter: all reads/writes go through the running Riposte server
 * (RIPOSTE_URL, default http://localhost:5720) so save/mirror behavior stays
 * in one place. Rendering drives the bench headless via Edge/Chrome.
 *
 * Register (Claude Code):
 *   claude mcp add riposte -- node <repo>/packages/mcp/src/index.ts
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Layer, SceneDoc, SceneElement } from '@riposte/shared';

const BASE = process.env['RIPOSTE_URL'] ?? 'http://localhost:5720';

// ---- riposte server API ------------------------------------------------------

interface SetInfo {
  root: string;
  name: string;
  scenes: string[];
  components: string[];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new Error(`Riposte server not reachable at ${BASE} — start it with \`npm run server\` in the riposte repo.`);
  }
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `server responded ${res.status}`);
  return body;
}

async function findSet(name: string): Promise<SetInfo> {
  const sets = await api<SetInfo[]>('/api/sets');
  const hit = sets.find((s) => s.name === name);
  if (!hit) throw new Error(`no set named "${name}" — available: ${sets.map((s) => s.name).join(', ')}`);
  return hit;
}

interface Bundle {
  info: SetInfo;
  scenes: Record<string, SceneDoc | null>;
  outros: Record<string, { name: string; duration: number }>;
  intros: Record<string, { name: string; duration: number }>;
}

async function loadBundle(setName: string): Promise<Bundle> {
  const info = await findSet(setName);
  const bundle = await api<Omit<Bundle, 'info'>>(
    `/api/set?root=${encodeURIComponent(info.root)}&name=${encodeURIComponent(info.name)}`,
  );
  return { info, scenes: bundle.scenes, outros: bundle.outros ?? {}, intros: bundle.intros ?? {} };
}

/** Bundle + resolved scene file + non-null doc, or a helpful error. */
async function sceneDoc(set: string, scene: string): Promise<Bundle & { file: string; doc: SceneDoc }> {
  const bundle = await loadBundle(set);
  const file = sceneFileOf(bundle.info, bundle.scenes, scene);
  const doc = bundle.scenes[file];
  if (!doc) throw new Error(`scene file ${file} is unreadable`);
  return { ...bundle, file, doc };
}

async function saveDoc(info: SetInfo, file: string, doc: SceneDoc): Promise<void> {
  await api('/api/scene', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: info.root, name: info.name, file, doc }),
  });
}

function post(path: string, body: Record<string, unknown>): Promise<unknown> {
  return api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const shortName = (file: string) => file.replace(/^scenes\//, '').replace(/\.json$/, '');

function sceneFileOf(info: SetInfo, scenes: Record<string, SceneDoc | null>, sceneName: string): string {
  const file = Object.keys(scenes).find(
    (f) => f.replace(/^scenes\//, '').replace(/\.json$/, '') === sceneName,
  );
  if (!file) {
    const names = Object.keys(scenes).map((f) => f.replace(/^scenes\//, '').replace(/\.json$/, ''));
    throw new Error(`no scene "${sceneName}" in set "${info.name}" — available: ${names.join(', ')}`);
  }
  return file;
}

// ---- headless rendering ------------------------------------------------------

function findBrowser(): string {
  const candidates = [
    process.env['RIPOSTE_BROWSER'],
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter((c): c is string => !!c);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('no Edge/Chrome found — set RIPOSTE_BROWSER to a Chromium binary');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Best-effort: kill a headless browser that outlived the render deadline
// (matched by the unique screenshot path in its command line).
async function killStrayRenderer(out: string): Promise<void> {
  if (process.platform !== 'win32') return;
  await new Promise<void>((resolve) => {
    const p = spawn('powershell', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match [regex]::Escape('${out}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: 'ignore' });
    p.on('error', () => resolve());
    p.on('exit', () => resolve());
  });
}

async function renderPng(url: string): Promise<Buffer> {
  const browser = findBrowser();
  const dir = await mkdtemp(join(tmpdir(), 'riposte-mcp-'));
  const out = join(dir, 'shot.png');
  try {
    const p = spawn(browser, [
      '--headless',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--virtual-time-budget=8000',
      `--screenshot=${out}`,
      url,
    ], { stdio: 'ignore' });
    p.on('error', () => {});
    // Edge relaunches itself through a compat layer: the process we spawned
    // exits within ~50ms while the real browser renders detached. Waiting on
    // its exit is meaningless — poll for the screenshot file instead.
    const deadline = Date.now() + 30_000;
    while (!existsSync(out)) {
      if (Date.now() > deadline) {
        await killStrayRenderer(out);
        throw new Error('render timed out after 30s — no screenshot written. Is the riposte server up, and does the scene load in the bench?');
      }
      await sleep(250);
    }
    await sleep(200); // let the browser finish closing the file
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- element editing ---------------------------------------------------------

const NUMERIC_STYLE = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'fontSize', 'lineHeight', 'letterSpacing'] as const;
const COLOR_STYLE = ['color', 'backgroundColor'] as const;

const propsShape = {
  content: z.string().optional().describe('Text content (text elements)'),
  x: z.number().optional().describe('Box center X'),
  y: z.number().optional().describe('Box center Y'),
  width: z.number().optional(),
  height: z.number().optional(),
  rotation: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
  fontSize: z.number().optional(),
  lineHeight: z.number().optional(),
  letterSpacing: z.number().optional(),
  color: z.string().optional().describe('CSS color (text elements)'),
  backgroundColor: z.string().optional(),
  fontFamily: z.string().optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  verticalAlign: z.enum(['top', 'middle', 'bottom']).optional(),
  hidden: z.boolean().optional().describe('Layer hidden flag'),
  key: z.string().optional().describe('Data key for update() addressing; "" clears; duplicates refused'),
  fill: z.string().optional().describe('Fill color (rectangle/ellipse/path)'),
  borderRadius: z.number().optional().describe('Corner radius px (rectangle)'),
  fontWeight: z.union([z.number(), z.string()]).optional().describe('Text: 400/700/"bold"…'),
  textTransform: z.string().optional().describe('Text: uppercase/lowercase/none'),
  autoSqueeze: z.boolean().optional().describe('Text: shrink to fit the box width (name-squeeze)'),
  tabularNums: z.boolean().optional().describe('Text: fixed-advance digits for clocks/scores'),
  multiline: z.boolean().optional().describe('Text: wrap instead of single line'),
  autoSize: z.boolean().optional().describe('Text: box auto-sizes to content'),
  padding: z.array(z.number()).length(4).optional().describe('Text: [top,right,bottom,left] px'),
  name: z.string().optional().describe('Layer display name; "" clears'),
  locked: z.boolean().optional().describe('Layer locked (stage-drag-proof)'),
  isGuide: z.boolean().optional().describe('Design-time guide layer — excluded from export and scene effects'),
  fit: z.enum(['original', 'contain', 'cover', 'stretch', 'fitWidth', 'fitHeight']).optional().describe('Image loader: fit mode'),
  placeholder: z.string().optional().describe('Image loader: design-time asset; "" clears'),
  asset: z.string().optional().describe('Image: swap the asset path'),
};

const TEXT_FIELDS = ['content', 'fontFamily', 'textAlign', 'verticalAlign', 'fontWeight', 'textTransform', 'autoSqueeze', 'tabularNums', 'multiline', 'autoSize'] as const;
const LAYER_FLAGS = ['locked', 'isGuide'] as const;

function findLayer(doc: SceneDoc, target: string): Layer {
  const hit = doc.composition.layers.find(
    (l) => l.element.key === target || l.name === target || l.element.id === target,
  );
  if (!hit) {
    const known = doc.composition.layers
      .map((l) => l.element.key ?? l.name ?? l.element.type)
      .join(', ');
    throw new Error(`no element "${target}" — layers: ${known}`);
  }
  return hit;
}

function applyProps(doc: SceneDoc, layer: Layer, props: Record<string, unknown>): { applied: string[]; skipped: string[] } {
  const el = layer.element as SceneElement & Record<string, unknown>;
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if ((NUMERIC_STYLE as readonly string[]).includes(key)) {
      const prop = el.style[key];
      if (prop?.keyframes && prop.keyframes.length > 0) {
        skipped.push(`${key} (animated — edit keyframes in the editor)`);
        continue;
      }
      el.style[key] = { ...(prop ?? {}), value: value as number };
      applied.push(key);
    } else if ((COLOR_STYLE as readonly string[]).includes(key)) {
      el.style[key] = { value: value as string, unit: 'color' };
      applied.push(key);
    } else if (key === 'hidden') {
      layer.hidden = (value as boolean) || undefined;
      applied.push(key);
    } else if (key === 'key') {
      const k = String(value).trim();
      if (k && doc.composition.layers.some((l) => l !== layer && l.element.key === k)) {
        skipped.push(`key (already used by another element)`);
        continue;
      }
      if (k) el.key = k;
      else delete el.key;
      applied.push(key);
    } else if (key === 'fill') {
      if (el.type !== 'rectangle' && el.type !== 'ellipse' && el.type !== 'path') {
        skipped.push(`fill (element is ${el.type})`);
        continue;
      }
      el['fill'] = value as string;
      applied.push(key);
    } else if (key === 'borderRadius') {
      if (el.type !== 'rectangle') {
        skipped.push(`borderRadius (element is ${el.type}, not rectangle)`);
        continue;
      }
      if ((value as number) > 0) el['borderRadius'] = { value: value as number };
      else delete el['borderRadius'];
      applied.push(key);
    } else if ((TEXT_FIELDS as readonly string[]).includes(key)) {
      if (el.type !== 'text') {
        skipped.push(`${key} (element is ${el.type}, not text)`);
        continue;
      }
      if (value === false) delete (el as Record<string, unknown>)[key];
      else (el as Record<string, unknown>)[key] = value;
      applied.push(key);
    } else if (key === 'padding') {
      if (el.type !== 'text') {
        skipped.push(`padding (element is ${el.type}, not text)`);
        continue;
      }
      const pads = value as [number, number, number, number];
      if (pads.every((p) => p === 0)) delete el['padding'];
      else el['padding'] = pads;
      applied.push(key);
    } else if (key === 'name') {
      const n = String(value).trim();
      if (n) layer.name = n;
      else delete layer.name;
      applied.push(key);
    } else if ((LAYER_FLAGS as readonly string[]).includes(key)) {
      if (value) (layer as unknown as Record<string, unknown>)[key] = true;
      else delete (layer as unknown as Record<string, unknown>)[key];
      applied.push(key);
    } else if (key === 'fit' || key === 'placeholder') {
      if (el.type !== 'imageLoader') {
        skipped.push(`${key} (element is ${el.type}, not imageLoader)`);
        continue;
      }
      if (key === 'placeholder' && !String(value).trim()) delete el['placeholder'];
      else (el as Record<string, unknown>)[key] = value;
      applied.push(key);
    } else if (key === 'asset') {
      if (el.type !== 'image') {
        skipped.push(`asset (element is ${el.type}, not image)`);
        continue;
      }
      el['asset'] = value as string;
      applied.push(key);
    }
  }
  return { applied, skipped };
}

// ---- MCP server ----------------------------------------------------------------

const server = new McpServer({ name: 'riposte', version: '0.1.0' });

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

server.tool('list_sets', 'List all Riposte graphics sets (projects) with their scene counts.', {}, async () => {
  const sets = await api<SetInfo[]>('/api/sets');
  return text(sets.map((s) => ({ set: s.name, root: s.root, scenes: s.scenes.length, components: s.components.length })));
});

server.tool(
  'list_scenes',
  'List the scenes of a set with their data keys — the real update() input surface: ' +
    'content keys of texts/image loaders plus visibility switch keys (values "0"/"1").',
  { set: z.string().describe('Set name, e.g. "FIE_2026"') },
  async ({ set }) => {
    const { scenes } = await loadBundle(set);
    const out = Object.entries(scenes).map(([file, doc]) => {
      const content = new Set<string>();
      const switches = new Set<string>();
      for (const l of doc?.composition.layers ?? []) {
        const el = l.element;
        if (el.key && (el.type === 'text' || el.type === 'imageLoader')) content.add(el.key);
        if (el.visibility?.bindKey) switches.add(el.visibility.bindKey);
      }
      return {
        scene: file.replace(/^scenes\//, '').replace(/\.json$/, ''),
        keys: [...content],
        switches: [...switches],
      };
    });
    return text(out);
  },
);

// ---- live bench control ------------------------------------------------------
// The bench (http://localhost:5720/) is the manual template test page. These
// tools drive the tab the USER is watching — the shared feedback loop. For
// headless self-verification use render_scene instead.

async function benchPost(body: Record<string, unknown>): Promise<string> {
  const r = await api<{ listeners: number }>('/api/bench', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.listeners > 0 ? 'ok' : 'sent, but no bench tab is connected — open http://localhost:5720';
}

server.tool(
  'bench_open',
  'Load a scene into the live bench tab (and optionally seek a frame). The user watches this page.',
  { set: z.string(), scene: z.string(), frame: z.number().optional() },
  async ({ set, scene, frame }) => text(await benchPost({ action: 'open', set, scene, frame })),
);

server.tool(
  'bench_update',
  'Fill template variables in the live bench tab, like a ControlCenter update. ' +
    'Keys come from list_scenes; switch keys take "1"/"0". The bench form mirrors what you send.',
  { data: z.record(z.string()).describe('e.g. {"_name1": "SMITH, John", "_timeSwitch": "1"}') },
  async ({ data }) => text(await benchPost({ action: 'update', data })),
);

server.tool(
  'bench_transport',
  'Drive the live bench tab like CasparCG would: play (intro to first pause), next (resume past pause / outro), ' +
    'stop (outro), reset (reload the scene), or seek to a frame.',
  {
    action: z.enum(['play', 'next', 'stop', 'reset', 'seek']),
    frame: z.number().optional().describe('Required for seek'),
  },
  async ({ action, frame }) => text(await benchPost({ action, frame })),
);

server.tool(
  'open_scene',
  'Navigate the running Riposte editor UI to a set (and optionally a scene and playhead frame) — ' +
    'use it so the user is looking at the same thing you are working on. ' +
    'Unsaved edits in the editor are protected by a confirm dialog on its side.',
  { set: z.string(), scene: z.string().optional(), frame: z.number().optional().describe('Move the editor playhead to this frame') },
  async ({ set, scene, frame }) => {
    const { info, scenes } = await loadBundle(set);
    const file = scene ? sceneFileOf(info, scenes, scene) : undefined;
    const r = await api<{ listeners: number }>('/api/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: info.root, name: info.name, file, frame }),
    });
    return text(
      r.listeners > 0
        ? `editor navigated to ${info.name}${scene ? ' / ' + scene : ''}${frame !== undefined ? ` @ frame ${frame}` : ''}`
        : 'no editor is currently connected — open http://localhost:5719',
    );
  },
);

server.tool(
  'get_scene',
  'Full scene document (layers, elements, keyframes, markers) as JSON.',
  { set: z.string(), scene: z.string() },
  async ({ set, scene }) => {
    const { info, scenes } = await loadBundle(set);
    const file = sceneFileOf(info, scenes, scene);
    return text(scenes[file]);
  },
);

server.tool(
  'set_element',
  'Edit an element of a scene: position/size, text content and styling, layer visibility. ' +
    'Target by element key (e.g. "_title"), layer name, or element id. Animated properties are protected. ' +
    'Saves through the Riposte server; an open editor updates live. render_scene afterwards to see the result.',
  {
    set: z.string(),
    scene: z.string(),
    element: z.string().describe('Element key (preferred), layer name, or element id'),
    props: z.object(propsShape).describe('Properties to change'),
  },
  async ({ set, scene, element, props }) => {
    const { info, file, doc } = await sceneDoc(set, scene);
    const layer = findLayer(doc, element);
    const { applied, skipped } = applyProps(doc, layer, props);
    if (applied.length === 0) return text({ applied, skipped, saved: false });
    await saveDoc(info, file, doc);
    return text({ applied, skipped, saved: true });
  },
);

server.tool(
  'render_scene',
  'Render a scene at a frame (default: its hold frame — the first pause marker) with optional template data, ' +
    'and return the image. This is the visual feedback loop: use it after every edit.',
  {
    set: z.string(),
    scene: z.string(),
    frame: z.number().optional().describe('Frame to render; defaults to the first pause marker'),
    data: z.record(z.string()).optional().describe('Template data, e.g. {"_title": "FINALS"}'),
  },
  async ({ set, scene, frame, data }) => {
    const { info, scenes } = await loadBundle(set);
    const file = sceneFileOf(info, scenes, scene);
    const doc = scenes[file];
    const holdFrame = doc?.composition.markers.find((m) => m.type === 'pause')?.frame ?? 0;
    const f = frame ?? holdFrame;
    let url = `${BASE}/?set=${encodeURIComponent(info.name)}&scene=${encodeURIComponent(scene)}&frame=${f}&bare=1`;
    if (data && Object.keys(data).length > 0) url += `&data=${encodeURIComponent(JSON.stringify(data))}`;
    const png = await renderPng(url);
    return {
      content: [
        { type: 'text' as const, text: `frame ${f} of ${info.name}/${scene} (1920x1080)` },
        { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
      ],
    };
  },
);

// Probe intrinsic size of set assets (PNG header / SVG attributes) so new
// image layers land at natural size; other formats fall back to a default.
async function probeAssetSize(info: SetInfo, asset: string): Promise<{ w: number; h: number } | null> {
  try {
    const res = await fetch(`${BASE}/${info.root}/${encodeURIComponent(info.name)}/${asset}`);
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) {
      return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
    }
    if (/\.svg$/i.test(asset)) {
      const head = bytes.subarray(0, 2048).toString('utf8');
      const w = /width="([\d.]+)/.exec(head)?.[1];
      const h = /height="([\d.]+)/.exec(head)?.[1];
      if (w && h) return { w: Number(w), h: Number(h) };
      const vb = /viewBox="[\d. -]*?([\d.]+)\s+([\d.]+)"/.exec(head);
      if (vb) return { w: Number(vb[1]), h: Number(vb[2]) };
    }
  } catch {
    /* fall through to default */
  }
  return null;
}

const ASSET_EXT_RE = /\.(png|jpe?g|webp|svg|gif|ttf|otf|woff2?)$/i;
const IMPORT_CAP = 500;

server.tool(
  'import_assets',
  'Import image/font files from a local folder (USB stick, downloads, …) into a set\'s shared asset pool. ' +
    'Scans recursively; same policy as the editor upload: identical bytes are skipped, name clashes get a ' +
    'content-hash suffix, fonts are registered in the set automatically.',
  {
    set: z.string(),
    sourceDir: z.string().describe('Absolute folder to scan, e.g. "E:\\\\" or "E:\\\\logos"'),
    filter: z.string().optional().describe('Only files whose name contains this text (case-insensitive)'),
  },
  async ({ set, sourceDir, filter }) => {
    const info = await findSet(set);
    if (!existsSync(sourceDir)) throw new Error(`folder not found: ${sourceDir}`);

    const entries = await readdir(sourceDir, { recursive: true, withFileTypes: true });
    const needle = filter?.toLowerCase();
    const files = entries
      .filter((e) => e.isFile() && ASSET_EXT_RE.test(e.name))
      .filter((e) => !needle || e.name.toLowerCase().includes(needle))
      .map((e) => join(e.parentPath, e.name));
    const capped = files.length > IMPORT_CAP;
    const batch = files.slice(0, IMPORT_CAP);

    const added: string[] = [];
    const skippedIdentical: string[] = [];
    const renamed: string[] = [];
    const fonts: string[] = [];
    const failed: string[] = [];
    const q = `root=${encodeURIComponent(info.root)}&name=${encodeURIComponent(info.name)}`;
    for (const path of batch) {
      try {
        const bytes = await readFile(path);
        const r = await api<{ file: string; status: string; family?: string }>(
          `/api/assets/upload?${q}&filename=${encodeURIComponent(basename(path))}`,
          { method: 'POST', body: new Uint8Array(bytes) },
        );
        if (r.status === 'written') added.push(r.file);
        else if (r.status.startsWith('identical')) skippedIdentical.push(basename(path));
        else renamed.push(`${basename(path)} → ${r.file}`);
        if (r.family) fonts.push(r.family);
      } catch (err) {
        failed.push(`${basename(path)}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return text({
      scanned: files.length,
      ...(capped ? { note: `more than ${IMPORT_CAP} matches — imported the first ${IMPORT_CAP}, run again with a filter` } : {}),
      added,
      skippedIdentical: skippedIdentical.length,
      renamed,
      fontsRegistered: fonts,
      failed,
    });
  },
);

server.tool(
  'add_layer',
  'Add a new topmost layer to a scene: an image from the asset pool, a text element, a rectangle/ellipse panel, ' +
    'or an embedded component instance. Position is the box CENTER (defaults to scene center); ' +
    'images and components default to their natural size. An open editor updates live; render_scene to verify.',
  {
    set: z.string(),
    scene: z.string(),
    type: z.enum(['image', 'text', 'rectangle', 'ellipse', 'component', 'imageLoader', 'imageSequence']),
    asset: z.string().optional().describe('Image only: asset path from the pool, e.g. "assets/logo.png"'),
    content: z.string().optional().describe('Text only: the text to show'),
    component: z.string().optional().describe('Component only: component name or file (see list_sets/list_scenes)'),
    fit: z.enum(['original', 'contain', 'cover', 'stretch', 'fitWidth', 'fitHeight']).optional().describe('Image loader only (default contain)'),
    placeholder: z.string().optional().describe('Image loader only: design-time asset'),
    sequence: z.string().optional().describe('Image sequence only: pattern from list_assets, e.g. "assets/flame/frame_###.png" — the layer spans one timeline frame per image'),
    key: z.string().optional().describe('Data key so update() can address it, e.g. "_sponsor"'),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    fontSize: z.number().optional().describe('Text only (default 40)'),
    color: z.string().optional().describe('Text only: CSS color (default #ffffff)'),
    fill: z.string().optional().describe('Rectangle/ellipse: CSS fill color (default #3a6ea5)'),
    borderRadius: z.number().optional().describe('Rectangle only: corner radius px'),
  },
  async ({ set, scene, type, asset, content, component, fit, placeholder, sequence, key, x, y, width, height, fontSize, color, fill, borderRadius }) => {
    const { info, file, doc, scenes } = await sceneDoc(set, scene);
    if (type === 'image' && !asset) throw new Error('image layers need an `asset` (see list_assets)');

    let compFile: string | undefined;
    let frames: string[] = [];
    let w = width ?? (type === 'ellipse' ? 200 : type === 'imageLoader' ? 400 : 300);
    let h = height ?? (type === 'ellipse' ? 200 : type === 'imageLoader' ? 300 : 100);
    if (type === 'image' && asset && (width === undefined || height === undefined)) {
      const nat = await probeAssetSize(info, asset);
      if (nat) {
        w = width ?? nat.w;
        h = height ?? nat.h;
      }
    }
    if (type === 'imageSequence') {
      if (!sequence || !sequence.includes('###')) throw new Error('image sequences need `sequence` with a ### pattern (see list_assets)');
      const all = await api<{ file: string; size: number }[]>(
        `/api/assets?root=${encodeURIComponent(info.root)}&name=${encodeURIComponent(info.name)}`,
      );
      const [pre, suf] = sequence.split('###');
      const re = new RegExp(`^${pre!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d{2,}${suf!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
      frames = all.map((a) => a.file).filter((f) => re.test(f)).sort();
      if (frames.length === 0) throw new Error(`no files match "${sequence}"`);
      if (width === undefined || height === undefined) {
        const nat = await probeAssetSize(info, frames[0]!);
        if (nat) {
          w = width ?? nat.w;
          h = height ?? nat.h;
        }
      }
    }
    if (type === 'component') {
      if (!component) throw new Error(`component layers need \`component\` — this set has: ${info.components.map(shortName).join(', ') || '(none)'}`);
      compFile = info.components.find((f) => f === component || shortName(f) === component);
      if (!compFile) throw new Error(`no component "${component}" — available: ${info.components.map(shortName).join(', ') || '(none)'}`);
      const compDoc = scenes[compFile];
      w = width ?? compDoc?.composition.width ?? 1920;
      h = height ?? compDoc?.composition.height ?? 1080;
    }
    const comp = doc.composition;
    const id = `layer-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const style: Record<string, unknown> = {
      x: { value: Math.round(x ?? comp.width / 2) },
      y: { value: Math.round(y ?? comp.height / 2) },
      width: { value: Math.round(w) },
      height: { value: Math.round(h) },
    };
    const base = { id: `${id}-el`, ...(key ? { key } : {}), style };
    const element =
      type === 'image'
        ? { ...base, type, asset: asset! }
        : type === 'text'
          ? {
              ...base,
              type,
              content: content ?? 'Text',
              textAlign: 'center',
              style: { ...style, fontSize: { value: fontSize ?? 40 }, color: { value: color ?? '#ffffff', unit: 'color' } },
            }
          : type === 'component'
            ? { ...base, type: 'composition', compositionId: compFile! }
            : type === 'imageLoader'
              ? { ...base, type, fit: fit ?? 'contain', ...(placeholder ? { placeholder } : {}) }
              : type === 'imageSequence'
                ? { ...base, type, frames }
                : {
                    ...base,
                    type,
                    fill: fill ?? '#3a6ea5',
                    ...(type === 'rectangle' && borderRadius ? { borderRadius: { value: borderRadius } } : {}),
                  };
    doc.composition.layers.push({
      id,
      startFrame: 0,
      duration: type === 'imageSequence' ? frames.length : comp.duration,
      element,
    } as unknown as Layer);
    await saveDoc(info, file, doc);
    return text({ layerId: id, key: key ?? null, at: { x: x ?? comp.width / 2, y: y ?? comp.height / 2, w, h } });
  },
);

server.tool(
  'render_filmstrip',
  'Render a scene at several frames in ONE call — review the whole animation (intro, hold, outro), ' +
    'not just a single frame. Defaults to 5 frames spread across the timeline around the pause marker.',
  {
    set: z.string(),
    scene: z.string(),
    frames: z.array(z.number()).max(10).optional().describe('Frames to render (max 10); omit for an automatic spread'),
    data: z.record(z.string()).optional().describe('Template data applied before rendering'),
  },
  async ({ set, scene, frames, data }) => {
    const { info, scenes } = await loadBundle(set);
    const file = sceneFileOf(info, scenes, scene);
    const doc = scenes[file];
    if (!doc) throw new Error(`scene file ${file} is unreadable`);
    const dur = doc.composition.duration;
    const pause = doc.composition.markers.find((m) => m.type === 'pause')?.frame ?? Math.floor(dur / 2);
    const list =
      frames && frames.length > 0
        ? frames
        : [...new Set([0, Math.floor(pause / 2), pause, Math.floor((pause + dur - 1) / 2), dur - 1])];
    const dataQ = data && Object.keys(data).length > 0 ? `&data=${encodeURIComponent(JSON.stringify(data))}` : '';
    const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [];
    for (const f of list) {
      const url = `${BASE}/?set=${encodeURIComponent(info.name)}&scene=${encodeURIComponent(scene)}&frame=${f}&bare=1${dataQ}`;
      const png = await renderPng(url);
      content.push({ type: 'text', text: `frame ${f}${f === pause ? ' (hold)' : ''}:` });
      content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
    }
    return { content };
  },
);

server.tool(
  'export_set',
  'Incrementally export a set to CasparCG templates (the set\'s export/ folder). Reports what changed.',
  { set: z.string() },
  async ({ set }) => {
    const info = await findSet(set);
    const r = await api<{ scenes: string[]; scenesUpdated: string[]; assetsCopied: number; assetsUpToDate: number }>(
      '/api/export',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: info.root, name: info.name }),
      },
    );
    return text({
      templatesUpdated: r.scenesUpdated,
      templatesUnchanged: r.scenes.length - r.scenesUpdated.length,
      assetsCopied: r.assetsCopied,
      assetsUpToDate: r.assetsUpToDate,
    });
  },
);

server.tool(
  'deploy_set',
  'Export a set and sync changed files into a CasparCG template directory (additive — never deletes).',
  { set: z.string(), targetDir: z.string().describe('Absolute path of the CasparCG template directory') },
  async ({ set, targetDir }) => {
    const info = await findSet(set);
    const r = await api<{ synced: { copied: number; upToDate: number; copiedBytes: number }; targetDir: string }>(
      '/api/deploy',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: info.root, name: info.name, targetDir }),
      },
    );
    return text({
      target: r.targetDir,
      filesCopied: r.synced.copied,
      filesUpToDate: r.synced.upToDate,
      mbTransferred: Math.round((r.synced.copiedBytes / 1048576) * 10) / 10,
    });
  },
);

// ---- set management ----------------------------------------------------------

server.tool(
  'create_set',
  'Create a new empty set under projects/. It starts with the stock intro/outro presets.',
  { name: z.string().describe('Set name (letters, digits, space, . ( ) -)') },
  async ({ name }) => text(await post('/api/set/create', { name })),
);

server.tool(
  'import_loo',
  'Import a Loopic .loo project file into an EXISTING set (create_set first for a fresh one). ' +
    'Scenes land in the set with a shared, content-deduplicated asset pool; legacy scripts are migrated.',
  { set: z.string(), file: z.string().describe('Absolute path of the .loo file') },
  async ({ set, file }) => {
    const info = await findSet(set);
    if (!existsSync(file)) throw new Error(`file not found: ${file}`);
    const bytes = await readFile(file);
    const q = `root=${encodeURIComponent(info.root)}&name=${encodeURIComponent(info.name)}&filename=${encodeURIComponent(basename(file))}`;
    return text(await api(`/api/set/import-loo?${q}`, { method: 'POST', body: new Uint8Array(bytes) }));
  },
);

server.tool(
  'set_export_settings',
  "Change a set's export settings: mode (external = shells + shared assets / baked = single-file / " +
    'spx = external + embedded SPXGCTemplateDefinition / ograf = EBU manifest + graphic.mjs per scene), ' +
    'asset preloading, fit-to-window scaling, image format (png / webp) and WebP quality (number or "lossless").',
  {
    set: z.string(),
    mode: z.enum(['external', 'baked', 'spx', 'ograf']).optional(),
    preloadAssets: z.boolean().optional(),
    fitToWindow: z.boolean().optional(),
    imageFormat: z.enum(['png', 'webp']).optional(),
    webpQuality: z.union([z.number(), z.literal('lossless')]).optional(),
  },
  async ({ set, ...patch }) => {
    const info = await findSet(set);
    return text(await post('/api/set/settings', { root: info.root, name: info.name, export: patch }));
  },
);

// ---- scene / component CRUD --------------------------------------------------

server.tool(
  'create_scene',
  'Create a new empty scene or component in a set. Canvas defaults are borrowed from an existing scene ' +
    '(else 1920x1080@50). Scenes start with a pause marker at half duration; components start without markers.',
  {
    set: z.string(),
    name: z.string(),
    kind: z.enum(['scene', 'component']).optional().describe('Default: scene'),
    width: z.number().optional(),
    height: z.number().optional(),
    fps: z.number().optional(),
    duration: z.number().optional().describe('Frames (default 100)'),
  },
  async ({ set, name, kind, width, height, fps, duration }) => {
    const { info, scenes } = await loadBundle(set);
    const donor = Object.values(scenes).find((d) => d)?.composition;
    const dur = duration ?? 100;
    const doc = {
      formatVersion: 1,
      name,
      composition: {
        width: width ?? donor?.width ?? 1920,
        height: height ?? donor?.height ?? 1080,
        fps: fps ?? donor?.fps ?? 50,
        duration: dur,
        markers: kind === 'component' ? [] : [{ frame: Math.floor(dur / 2), type: 'pause' }],
        layers: [],
      },
    };
    const r = await post('/api/scene/create', {
      root: info.root,
      name: info.name,
      file: `scenes/${name}.json`,
      doc,
      kind: kind ?? 'scene',
    });
    return text(r);
  },
);

server.tool(
  'duplicate_scene',
  'Copy a scene or component under a new name (same kind as the source).',
  { set: z.string(), scene: z.string(), newName: z.string() },
  async ({ set, scene, newName }) => {
    const { info, file, doc } = await sceneDoc(set, scene);
    const copy = JSON.parse(JSON.stringify(doc)) as SceneDoc;
    copy.name = newName;
    const kind = info.components.includes(file) ? 'component' : 'scene';
    return text(await post('/api/scene/create', { root: info.root, name: info.name, file: `scenes/${newName}.json`, doc: copy, kind }));
  },
);

server.tool(
  'rename_scene',
  'Rename a scene or component (file, set registration, and — for components — every embed reference).',
  { set: z.string(), scene: z.string(), newName: z.string() },
  async ({ set, scene, newName }) => {
    const { info, file } = await sceneDoc(set, scene);
    return text(await post('/api/scene/rename', { root: info.root, name: info.name, file, newName }));
  },
);

server.tool(
  'remove_scene',
  'Unregister a scene/component from the set — and optionally delete its file. ' +
    'Removing a component that is still embedded somewhere is refused with the list of scenes using it.',
  {
    set: z.string(),
    scene: z.string(),
    deleteFile: z.boolean().optional().describe('Also delete the .json file (default: false — unregister only)'),
  },
  async ({ set, scene, deleteFile }) => {
    const { info, file } = await sceneDoc(set, scene);
    return text(await post('/api/scene/remove', { root: info.root, name: info.name, file, deleteFile: deleteFile ?? false }));
  },
);

server.tool(
  'convert_scene',
  'Move a doc between the Scenes and Components lists (membership IS the kind; the file stays put). ' +
    'Demoting a still-embedded component is refused.',
  { set: z.string(), scene: z.string(), to: z.enum(['component', 'scene']) },
  async ({ set, scene, to }) => {
    const { info, file } = await sceneDoc(set, scene);
    return text(await post('/api/scene/convert', { root: info.root, name: info.name, file, to }));
  },
);

// ---- layer structure ---------------------------------------------------------

server.tool(
  'delete_layer',
  'Remove a layer from a scene (by element key, layer name, or element id).',
  { set: z.string(), scene: z.string(), element: z.string() },
  async ({ set, scene, element }) => {
    const { info, file, doc } = await sceneDoc(set, scene);
    const layer = findLayer(doc, element);
    doc.composition.layers = doc.composition.layers.filter((l) => l !== layer);
    await saveDoc(info, file, doc);
    return text({ deleted: layer.element.key ?? layer.name ?? layer.element.type, layersLeft: doc.composition.layers.length });
  },
);

server.tool(
  'reorder_layer',
  'Change a layer\'s paint order: to the very front/back, one step, or directly above/below another element.',
  {
    set: z.string(),
    scene: z.string(),
    element: z.string(),
    move: z.enum(['front', 'back', 'forward', 'backward']).optional(),
    above: z.string().optional().describe('Place directly above this element (ignored if `move` is set)'),
    below: z.string().optional(),
  },
  async ({ set, scene, element, move, above, below }) => {
    const { info, file, doc } = await sceneDoc(set, scene);
    const layer = findLayer(doc, element);
    const ls = doc.composition.layers;
    const fi = ls.indexOf(layer);
    ls.splice(fi, 1); // scene array is bottom-first: end = front
    let to: number;
    if (move === 'front') to = ls.length;
    else if (move === 'back') to = 0;
    else if (move === 'forward') to = Math.min(ls.length, fi + 1);
    else if (move === 'backward') to = Math.max(0, fi - 1);
    else if (above) to = ls.indexOf(findLayer(doc, above)) + 1;
    else if (below) to = ls.indexOf(findLayer(doc, below));
    else {
      ls.splice(fi, 0, layer);
      throw new Error('pass `move`, `above`, or `below`');
    }
    ls.splice(to, 0, layer);
    await saveDoc(info, file, doc);
    return text({ paintOrder: ls.map((l) => l.element.key ?? l.name ?? l.element.type) });
  },
);

const EASING_PRESETS: Record<string, { p1x: number; p1y: number; p2x: number; p2y: number }> = {
  'ease-out': { p1x: 0, p1y: 0, p2x: 0.5, p2y: 1 },
  'ease-in': { p1x: 0.42, p1y: 0, p2x: 1, p2y: 1 },
  'ease-in-out': { p1x: 0.42, p1y: 0, p2x: 0.58, p2y: 1 },
  ease: { p1x: 0.25, p1y: 0.1, p2x: 0.25, p2y: 1 },
};

server.tool(
  'set_keyframes',
  'Replace the keyframe list of one style property on an element — or one of its masks (frames are ABSOLUTE scene frames). ' +
    'Animatable props: x, y, width, height, opacity (0-1), scaleX, scaleY, rotation, fontSize, and filter props; masks: x, y, width, height, rotation. ' +
    'Easing shapes the segment TOWARD THE NEXT keyframe. Pass keyframes: null to clear back to a static value.',
  {
    set: z.string(),
    scene: z.string(),
    element: z.string(),
    mask: z.number().optional().describe('Target mask #N of the element instead of the element itself'),
    prop: z.string().describe('Style property name, e.g. "x"'),
    keyframes: z
      .array(
        z.object({
          frame: z.number(),
          value: z.number(),
          easing: z
            .union([z.enum(['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out']), z.object({ p1x: z.number(), p1y: z.number(), p2x: z.number(), p2y: z.number() })])
            .optional()
            .describe('Default linear'),
        }),
      )
      .nullable(),
  },
  async ({ set, scene, element, mask, prop, keyframes }) => {
    const { info, file, doc } = await sceneDoc(set, scene);
    const layer = findLayer(doc, element);
    let style = layer.element.style;
    if (mask !== undefined) {
      const m = layer.masks?.[mask];
      if (!m) throw new Error(`element has ${layer.masks?.length ?? 0} mask(s) — no mask #${mask}`);
      style = m.style;
    }
    if (keyframes === null) {
      const cur = style[prop];
      if (cur) delete cur.keyframes;
      await saveDoc(info, file, doc);
      return text({ prop, staticValue: style[prop]?.value ?? null });
    }
    if (keyframes.length < 2) throw new Error('need at least 2 keyframes (or null to clear)');
    const list = keyframes
      .map((k) => ({
        frame: Math.round(k.frame),
        value: k.value,
        ...(k.easing && k.easing !== 'linear'
          ? { easing: typeof k.easing === 'string' ? EASING_PRESETS[k.easing]! : k.easing }
          : {}),
      }))
      .sort((a, b) => a.frame - b.frame);
    style[prop] = { ...(style[prop] ?? {}), value: list[0]!.value, keyframes: list };
    await saveDoc(info, file, doc);
    return text({ prop, keyframes: list });
  },
);

server.tool(
  'extract_to_component',
  'Move elements of a scene into a NEW component and replace them with one embedded instance ' +
    '(same canvas size, so nothing moves visually). Mirrors the editor\'s multi-select extract.',
  {
    set: z.string(),
    scene: z.string(),
    elements: z.array(z.string()).min(1).describe('Element keys / layer names / ids to extract'),
    name: z.string().describe('Name of the new component'),
  },
  async ({ set, scene, elements, name }) => {
    const { info, file, doc } = await sceneDoc(set, scene);
    const picked = elements.map((e) => findLayer(doc, e));
    const ids = new Set(picked.map((l) => l.id));
    // paint order from the scene, not the argument order
    const layers = doc.composition.layers.filter((l) => ids.has(l.id));
    const comp = doc.composition;
    const compDoc = {
      formatVersion: 1,
      name,
      composition: {
        width: comp.width,
        height: comp.height,
        fps: comp.fps,
        duration: comp.duration,
        markers: [],
        layers: JSON.parse(JSON.stringify(layers)) as Layer[],
      },
    };
    const compFile = `scenes/${name}.json`;
    await post('/api/scene/create', { root: info.root, name: info.name, file: compFile, doc: compDoc, kind: 'component' });
    const nid = `layer-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const at = Math.min(...layers.map((l) => comp.layers.indexOf(l)));
    comp.layers = comp.layers.filter((l) => !ids.has(l.id));
    comp.layers.splice(at, 0, {
      id: nid,
      startFrame: 0,
      duration: comp.duration,
      element: {
        id: `${nid}-el`,
        type: 'composition',
        compositionId: compFile,
        style: { x: { value: comp.width / 2 }, y: { value: comp.height / 2 }, width: { value: comp.width }, height: { value: comp.height } },
      },
    } as unknown as Layer);
    await saveDoc(info, file, doc);
    const keyed = layers.filter((l) => l.element.key).map((l) => l.element.key);
    return text({
      component: name,
      moved: layers.length,
      instanceLayerId: nid,
      ...(keyed.length > 0
        ? { note: `data keys moved inside: ${keyed.join(', ')} — give the instance a key to address them as _instance._key` }
        : {}),
    });
  },
);

server.tool(
  'set_visibility_binding',
  'Set or clear the data-driven show/hide of an element: an update() key controls its visibility ' +
    '(the "_xSwitch" convention). Clear by passing bindKey: "".',
  {
    set: z.string(),
    scene: z.string(),
    element: z.string(),
    bindKey: z.string().describe('update() key, e.g. "_greenSwitch"; "" removes the binding'),
    mode: z.enum(['hide', 'show']).optional().describe('hide = hidden for `values` (default, values default ["0"]); show = visible ONLY for `values`'),
    values: z.array(z.string()).optional(),
    initial: z.enum(['visible', 'hidden']).optional().describe('State before the key first arrives (default visible)'),
  },
  async ({ set, scene, element, bindKey, mode, values, initial }) => {
    const { info, file, doc } = await sceneDoc(set, scene);
    const layer = findLayer(doc, element);
    if (!bindKey.trim()) {
      delete layer.element.visibility;
    } else {
      const b: Record<string, unknown> = { bindKey: bindKey.trim() };
      if (mode === 'show') b['showWhen'] = values ?? ['1'];
      else if (values && !(values.length === 1 && values[0] === '0')) b['hideWhen'] = values;
      if (initial === 'hidden') b['initial'] = 'hidden';
      layer.element.visibility = b as unknown as Layer['element']['visibility'];
    }
    await saveDoc(info, file, doc);
    return text({ element, visibility: layer.element.visibility ?? null });
  },
);

server.tool(
  'set_loop',
  'Set or clear a layer\'s loop region (layer-local frames): [start, end) cycles while the scene holds ' +
    'on a pause marker; the exit is a fade-in-place of `exitFade` frames (default 15). Clear with start: null.',
  {
    set: z.string(),
    scene: z.string(),
    element: z.string(),
    start: z.number().nullable().describe('Loop start frame (layer-local); null clears the loop'),
    end: z.number().optional(),
    exitFade: z.number().optional(),
  },
  async ({ set, scene, element, start, end, exitFade }) => {
    const { info, file, doc } = await sceneDoc(set, scene);
    const layer = findLayer(doc, element);
    if (start === null) {
      delete layer.loop;
    } else {
      if (end === undefined || end <= start) throw new Error('`end` must be > `start`');
      layer.loop = { start: Math.round(start), end: Math.round(end), ...(exitFade ? { exitFade: Math.round(exitFade) } : {}) };
    }
    await saveDoc(info, file, doc);
    return text({ element, loop: layer.loop ?? null });
  },
);

server.tool(
  'set_markers',
  'Replace a scene\'s marker list. Markers drive the CasparCG lifecycle: play() parks at each `pause`; ' +
    'stop() jumps to `outro`; `loop` jumps back to loopToFrame while playing; `action` runs JS at its frame.',
  {
    set: z.string(),
    scene: z.string(),
    markers: z.array(
      z.object({
        frame: z.number(),
        type: z.enum(['pause', 'outro', 'loop', 'action']),
        loopToFrame: z.number().optional().describe('loop markers only'),
        source: z.string().optional().describe('action markers only: JS source'),
      }),
    ),
  },
  async ({ set, scene, markers }) => {
    const { info, file, doc } = await sceneDoc(set, scene);
    for (const m of markers) {
      if (m.type === 'loop' && m.loopToFrame === undefined) throw new Error('loop markers need loopToFrame');
      if (m.type === 'action' && !m.source) throw new Error('action markers need source');
    }
    doc.composition.markers = markers.sort((a, b) => a.frame - b.frame) as unknown as SceneDoc['composition']['markers'];
    await saveDoc(info, file, doc);
    return text({ markers: doc.composition.markers });
  },
);

server.tool(
  'set_mask',
  'Add, edit, or remove a rectangle mask clipping an element. A new mask defaults to the element\'s own box. ' +
    'x/y are the mask CENTER; `inverted` shows the element OUTSIDE the rect (cut-a-hole wipes); ' +
    '`radius` rounds corners (number = uniform, "40 0 0 0" = per corner). Animate geometry via set_keyframes with `mask`.',
  {
    set: z.string(),
    scene: z.string(),
    element: z.string(),
    index: z.number().optional().describe('Mask #N (default 0); an index past the end appends a new mask'),
    remove: z.boolean().optional().describe('Delete the mask at `index`'),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    rotation: z.number().optional(),
    inverted: z.boolean().optional(),
    radius: z.union([z.number(), z.string()]).optional().describe('0 / "" clears'),
  },
  async ({ set, scene, element, index, remove, x, y, width, height, rotation, inverted, radius }) => {
    const { info, file, doc } = await sceneDoc(set, scene);
    const layer = findLayer(doc, element);
    const masks = (layer.masks ??= []);
    const i = Math.min(index ?? 0, masks.length);
    if (remove) {
      if (!masks[i]) throw new Error(`no mask #${i}`);
      masks.splice(i, 1);
      if (masks.length === 0) delete layer.masks;
      await saveDoc(info, file, doc);
      return text({ element, masks: masks.length });
    }
    let m = masks[i];
    if (!m) {
      const es = layer.element.style;
      m = {
        id: `${layer.id}-mask${masks.length}`,
        type: 'rectangle',
        style: {
          x: { value: Number(es.x?.value) || doc.composition.width / 2 },
          y: { value: Number(es.y?.value) || doc.composition.height / 2 },
          width: { value: Number(es.width?.value) || doc.composition.width },
          height: { value: Number(es.height?.value) || doc.composition.height },
        },
      } as unknown as NonNullable<Layer['masks']>[number];
      masks.push(m);
    }
    const skipped: string[] = [];
    for (const [prop, v] of Object.entries({ x, y, width, height, rotation })) {
      if (v === undefined) continue;
      if (m.style[prop]?.keyframes?.length) {
        skipped.push(`${prop} (animated — use set_keyframes with mask)`);
        continue;
      }
      m.style[prop] = { ...(m.style[prop] ?? {}), value: v };
    }
    if (inverted !== undefined) {
      if (inverted) m.inverted = true;
      else delete m.inverted;
    }
    if (radius !== undefined) {
      if (radius === 0 || radius === '') delete m.style['borderRadius'];
      else m.style['borderRadius'] = { value: radius };
    }
    await saveDoc(info, file, doc);
    return text({ element, mask: i, style: m.style, inverted: m.inverted ?? false, ...(skipped.length ? { skipped } : {}) });
  },
);

server.tool(
  'set_layer_span',
  'Set a layer\'s visible span on the timeline (the bar): startFrame + duration in scene frames. ' +
    'Keyframes are stored in ABSOLUTE frames and do not move with the span.',
  { set: z.string(), scene: z.string(), element: z.string(), startFrame: z.number(), duration: z.number() },
  async ({ set, scene, element, startFrame, duration }) => {
    if (duration < 1) throw new Error('duration must be >= 1');
    const { info, file, doc } = await sceneDoc(set, scene);
    const layer = findLayer(doc, element);
    layer.startFrame = Math.max(0, Math.round(startFrame));
    layer.duration = Math.round(duration);
    await saveDoc(info, file, doc);
    return text({ element, startFrame: layer.startFrame, duration: layer.duration });
  },
);

server.tool(
  'set_size_bind',
  'Bind a rectangle\'s size to a text element\'s measured content (+padding) — the "bar always fits the name" ' +
    'pattern, re-measured on every update(). source: null clears the bind.',
  {
    set: z.string(),
    scene: z.string(),
    element: z.string().describe('The rectangle'),
    source: z.string().nullable().describe('The text element to follow; null removes the bind'),
    axis: z.enum(['x', 'y', 'both']).optional().describe('Which dimensions follow (default x)'),
    padX: z.number().optional(),
    padY: z.number().optional(),
    grow: z.enum(['center', 'left', 'right']).optional().describe('Which edge stays put (default center)'),
  },
  async ({ set, scene, element, source, axis, padX, padY, grow }) => {
    const { info, file, doc } = await sceneDoc(set, scene);
    const layer = findLayer(doc, element);
    if (layer.element.type !== 'rectangle') throw new Error(`sizeBind lives on rectangles — "${element}" is ${layer.element.type}`);
    if (source === null) {
      delete layer.element.sizeBind;
    } else {
      const src = findLayer(doc, source);
      if (src.element.type !== 'text') throw new Error(`sizeBind source must be a text element — "${source}" is ${src.element.type}`);
      layer.element.sizeBind = {
        sourceId: src.element.id,
        ...(axis && axis !== 'x' ? { axis } : {}),
        ...(padX ? { padX } : {}),
        ...(padY ? { padY } : {}),
        ...(grow && grow !== 'center' ? { grow } : {}),
      };
    }
    await saveDoc(info, file, doc);
    return text({ element, sizeBind: layer.element.sizeBind ?? null });
  },
);

server.tool(
  'set_composition',
  'Change a scene\'s canvas/timing: width, height, fps, duration. NOTE: layers, keyframes and markers are ' +
    'NOT rescaled or clamped — adjust them separately if needed.',
  {
    set: z.string(),
    scene: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
    fps: z.number().optional(),
    duration: z.number().optional(),
  },
  async ({ set, scene, width, height, fps, duration }) => {
    const { info, file, doc } = await sceneDoc(set, scene);
    const c = doc.composition;
    if (width !== undefined) c.width = Math.round(width);
    if (height !== undefined) c.height = Math.round(height);
    if (fps !== undefined) c.fps = fps;
    if (duration !== undefined) c.duration = Math.round(duration);
    await saveDoc(info, file, doc);
    return text({ width: c.width, height: c.height, fps: c.fps, duration: c.duration });
  },
);

server.tool(
  'set_scene_action',
  'Set or clear the composition action — custom JS run once at template load (the escape hatch for genuinely ' +
    'dynamic behavior). API: useOnPlay/useOnUpdate/useOnStop/useOnNext/useOnInvoke, find(key), riposte. ' +
    'Runs in bench/playout/on-air, NOT in the editor preview. Prefer visibility bindings for plain show/hide.',
  { set: z.string(), scene: z.string(), source: z.string().nullable().describe('JS source; null clears') },
  async ({ set, scene, source }) => {
    const { info, file, doc } = await sceneDoc(set, scene);
    if (source === null || !source.trim()) delete doc.composition.action;
    else doc.composition.action = source;
    await saveDoc(info, file, doc);
    return text({ scene, action: doc.composition.action ? `${doc.composition.action.length} chars` : null });
  },
);

server.tool(
  'set_preview_data',
  'Set or clear the scene\'s design-time sample update payload (previewData) — what bench and renders show ' +
    'by default; never shipped to air.',
  { set: z.string(), scene: z.string(), data: z.record(z.string()).nullable() },
  async ({ set, scene, data }) => {
    const { info, file, doc } = await sceneDoc(set, scene);
    if (data === null || Object.keys(data).length === 0) delete doc.previewData;
    else doc.previewData = data;
    await saveDoc(info, file, doc);
    return text({ scene, previewData: doc.previewData ?? null });
  },
);

server.tool(
  'move_to_component',
  'Move elements of a scene into an EXISTING component (appended on top of its layers, fresh ids). ' +
    'The component file is saved immediately — the "forgot an element after extracting" fix.',
  {
    set: z.string(),
    scene: z.string(),
    elements: z.array(z.string()).min(1),
    component: z.string().describe('Component name or file'),
  },
  async ({ set, scene, elements, component }) => {
    const { info, file, doc, scenes } = await sceneDoc(set, scene);
    const compFile = info.components.find((f) => f === component || shortName(f) === component);
    if (!compFile) throw new Error(`no component "${component}" — available: ${info.components.map(shortName).join(', ') || '(none)'}`);
    if (compFile === file) throw new Error('that component IS the scene being edited');
    const target = scenes[compFile];
    if (!target) throw new Error(`component file ${compFile} is unreadable`);
    const picked = elements.map((e) => findLayer(doc, e));
    const ids = new Set(picked.map((l) => l.id));
    const layers = doc.composition.layers.filter((l) => ids.has(l.id));
    const clones = JSON.parse(JSON.stringify(layers)) as Layer[];
    for (const c of clones) {
      const nid = `layer-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      c.id = nid;
      c.element.id = `${nid}-el`;
      c.masks?.forEach((m, i) => (m.id = `${nid}-mask${i}`));
    }
    const targetDoc = JSON.parse(JSON.stringify(target)) as SceneDoc;
    targetDoc.composition.layers.push(...clones);
    await saveDoc(info, compFile, targetDoc);
    doc.composition.layers = doc.composition.layers.filter((l) => !ids.has(l.id));
    await saveDoc(info, file, doc);
    const sizeNote =
      targetDoc.composition.width !== doc.composition.width || targetDoc.composition.height !== doc.composition.height
        ? ' — CANVAS SIZES DIFFER, check positions'
        : '';
    return text({ moved: layers.length, into: shortName(compFile), note: `coordinates carry over as-is${sizeNote}` });
  },
);

server.tool(
  'duplicate_layer',
  'Duplicate a layer directly above the original (fresh ids). A data-bound copy needs a new key — ' +
    'pass `newKey`, or one is derived by suffixing.',
  { set: z.string(), scene: z.string(), element: z.string(), newKey: z.string().optional() },
  async ({ set, scene, element, newKey }) => {
    const { info, file, doc } = await sceneDoc(set, scene);
    const layer = findLayer(doc, element);
    const idx = doc.composition.layers.indexOf(layer);
    const copy = JSON.parse(JSON.stringify(layer)) as Layer;
    const nid = `layer-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    copy.id = nid;
    copy.element.id = `${nid}-el`;
    copy.masks?.forEach((m, i) => (m.id = `${nid}-mask${i}`));
    if (copy.element.key) {
      let k = newKey?.trim() || '';
      if (!k) {
        let n = 2;
        while (doc.composition.layers.some((l) => l.element.key === `${copy.element.key}${n}`)) n++;
        k = `${copy.element.key}${n}`;
      } else if (doc.composition.layers.some((l) => l.element.key === k)) {
        throw new Error(`key "${k}" is already used`);
      }
      copy.element.key = k;
    }
    doc.composition.layers.splice(idx + 1, 0, copy);
    await saveDoc(info, file, doc);
    return text({ layerId: nid, key: copy.element.key ?? null });
  },
);

server.tool(
  'rename_sequence',
  'Rename a whole image sequence into assets/<newName>/ (frame numbers kept); every scene reference is rewritten.',
  {
    set: z.string(),
    sequence: z.string().describe('Pattern from list_assets, e.g. "assets/flame/frame_###.png"'),
    newName: z.string().describe('New folder name under assets/'),
  },
  async ({ set, sequence, newName }) => {
    const info = await findSet(set);
    if (!sequence.includes('###')) throw new Error('`sequence` needs a ### pattern (see list_assets)');
    const all = await api<{ file: string; size: number }[]>(
      `/api/assets?root=${encodeURIComponent(info.root)}&name=${encodeURIComponent(info.name)}`,
    );
    const [pre, suf] = sequence.split('###');
    const re = new RegExp(`^${pre!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d{2,}${suf!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const files = all.map((a) => a.file).filter((f) => re.test(f)).sort();
    if (files.length === 0) throw new Error(`no files match "${sequence}"`);
    return text(await post('/api/assets/rename-sequence', { root: info.root, name: info.name, files, newName }));
  },
);

// ---- intro/outro effect presets ---------------------------------------------

server.tool(
  'list_presets',
  'List a set\'s intro and outro effect presets (intros/*.json, outros/*.json) with durations, ' +
    'and which scenes use them.',
  { set: z.string() },
  async ({ set }) => {
    const { scenes, intros, outros } = await loadBundle(set);
    const usage = (kind: 'intro' | 'outro', name: string) =>
      Object.entries(scenes)
        .filter(([, d]) => d?.[kind] === name)
        .map(([f]) => shortName(f));
    return text({
      intros: Object.values(intros).map((p) => ({ name: p.name, duration: p.duration, usedBy: usage('intro', p.name) })),
      outros: Object.values(outros).map((p) => ({ name: p.name, duration: p.duration, usedBy: usage('outro', p.name) })),
    });
  },
);

const presetShape = z.object({
  name: z.string().regex(/^[\w-]+$/),
  duration: z.number().int().positive().describe('Frames'),
  style: z.record(z.unknown()).optional().describe('Keyframed root props: opacity, x, y, scaleX, scaleY, rotation — each { value, keyframes: [{frame, value, easing?}] }'),
  mask: z
    .object({
      inverted: z.boolean().optional().describe('Scene visible OUTSIDE the rect (growing-hole wipes)'),
      style: z.record(z.unknown()).describe('x, y (center; default comp center), width, height, rotation'),
    })
    .optional(),
});

server.tool(
  'save_preset',
  'Create or overwrite an intro/outro preset ({intros,outros}/<name>.json). Intros play FORWARD on ADD: ' +
    'frame 0 = hidden, last frame = neutral. Outros: frame 0 = neutral, last frame = gone.',
  { set: z.string(), folder: z.enum(['intros', 'outros']), preset: presetShape },
  async ({ set, folder, preset }) => {
    const info = await findSet(set);
    return text(await post('/api/preset/save', { root: info.root, name: info.name, folder, preset }));
  },
);

server.tool(
  'delete_preset',
  'Delete an intro/outro preset file. Scenes referencing it fall back to default behavior.',
  { set: z.string(), folder: z.enum(['intros', 'outros']), preset: z.string() },
  async ({ set, folder, preset }) => {
    const info = await findSet(set);
    return text(await post('/api/preset/delete', { root: info.root, name: info.name, folder, presetName: preset }));
  },
);

server.tool(
  'add_stock_presets',
  'Copy the app\'s stock intro/outro presets into a set — missing ones only, never overwrites.',
  { set: z.string() },
  async ({ set }) => {
    const info = await findSet(set);
    return text(await post('/api/preset/stock', { root: info.root, name: info.name }));
  },
);

server.tool(
  'set_scene_effects',
  'Assign a scene\'s intro and/or outro preset (from the set\'s pools — see list_presets). ' +
    'null clears a slot; an omitted field is left unchanged. The outro preset replaces the marker outro.',
  {
    set: z.string(),
    scene: z.string(),
    intro: z.string().nullable().optional(),
    outro: z.string().nullable().optional(),
  },
  async ({ set, scene, intro, outro }) => {
    const bundle = await sceneDoc(set, scene);
    const { info, file, doc } = bundle;
    if (intro !== undefined) {
      if (intro !== null && !bundle.intros[intro]) throw new Error(`no intro "${intro}" — available: ${Object.keys(bundle.intros).join(', ') || '(none)'}`);
      if (intro) doc.intro = intro;
      else delete doc.intro;
    }
    if (outro !== undefined) {
      if (outro !== null && !bundle.outros[outro]) throw new Error(`no outro "${outro}" — available: ${Object.keys(bundle.outros).join(', ') || '(none)'}`);
      if (outro) doc.outro = outro;
      else delete doc.outro;
    }
    await saveDoc(info, file, doc);
    return text({ scene, intro: doc.intro ?? null, outro: doc.outro ?? null });
  },
);

// ---- assets ------------------------------------------------------------------

server.tool(
  'list_assets',
  'List a set\'s asset pool. Numbered image sequences are collapsed into one entry with a frame count.',
  { set: z.string() },
  async ({ set }) => {
    const info = await findSet(set);
    const files = await api<{ file: string; size: number }[]>(
      `/api/assets?root=${encodeURIComponent(info.root)}&name=${encodeURIComponent(info.name)}`,
    );
    const groups = new Map<string, { frames: number; bytes: number }>();
    const singles: { file: string; kb: number }[] = [];
    for (const f of files) {
      const m = /^(.*?)(\d{2,})(\.(?:png|jpe?g|webp))$/i.exec(f.file);
      if (m) {
        const key = `${m[1]}###${m[3]}`;
        const g = groups.get(key) ?? { frames: 0, bytes: 0 };
        g.frames += 1;
        g.bytes += f.size;
        groups.set(key, g);
      } else {
        singles.push({ file: f.file, kb: Math.round(f.size / 102.4) / 10 });
      }
    }
    return text({
      totalFiles: files.length,
      sequences: [...groups.entries()].map(([file, g]) => ({ file, frames: g.frames, mb: Math.round(g.bytes / 104857.6) / 10 })),
      files: singles,
    });
  },
);

server.tool(
  'delete_assets',
  'Delete asset files from a set\'s pool. DESTRUCTIVE — scenes referencing a deleted asset show nothing there. ' +
    'Check usage first (the editor sidebar shows unused assets).',
  { set: z.string(), files: z.array(z.string()).describe('Asset paths, e.g. ["assets/old_logo.png"]') },
  async ({ set, files }) => {
    const info = await findSet(set);
    return text(await post('/api/assets/delete', { root: info.root, name: info.name, files }));
  },
);

server.tool(
  'rename_asset',
  'Rename an asset file; every scene/component reference is rewritten to match.',
  { set: z.string(), from: z.string(), to: z.string().describe('New path, must stay under assets/') },
  async ({ set, from, to }) => {
    const info = await findSet(set);
    return text(await post('/api/assets/rename', { root: info.root, name: info.name, from, to }));
  },
);

// ---- diagnostics -------------------------------------------------------------

server.tool(
  'contract_check',
  'Check the set\'s data keys against the configured ControlCenter graphics_sets mappings: template keys ' +
    'no mapping fills, and mappings pointing at removed keys. A contract break shows on air as a silently blank field.',
  { set: z.string() },
  async ({ set }) => {
    const info = await findSet(set);
    const r = await api<{ dir: string | null; reports: unknown }>(
      `/api/contract?root=${encodeURIComponent(info.root)}&name=${encodeURIComponent(info.name)}`,
    );
    if (!r.dir) return text('contract checking is not configured — set the ControlCenter graphics_sets folder in the editor (Deploy dialog) first');
    return text(r);
  },
);

server.tool(
  'playout_status',
  'State of the virtual CasparCG (AMCP listeners the playout page serves): ports, listening, connections. ' +
    'ControlCenter connects to these ports (defaults 6250 main / 6251 preview).',
  {},
  async () => text(await api('/api/amcp')),
);

await server.connect(new StdioServerTransport());
