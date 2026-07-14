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

async function loadBundle(setName: string): Promise<{ info: SetInfo; scenes: Record<string, SceneDoc | null> }> {
  const info = await findSet(setName);
  const bundle = await api<{ scenes: Record<string, SceneDoc | null> }>(
    `/api/set?root=${encodeURIComponent(info.root)}&name=${encodeURIComponent(info.name)}`,
  );
  return { info, scenes: bundle.scenes };
}

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

async function renderPng(url: string): Promise<Buffer> {
  const browser = findBrowser();
  const dir = await mkdtemp(join(tmpdir(), 'riposte-mcp-'));
  const out = join(dir, 'shot.png');
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(browser, [
        '--headless',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--virtual-time-budget=8000',
        `--screenshot=${out}`,
        url,
      ]);
      p.on('error', reject);
      p.on('exit', () => resolve());
    });
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
};

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

function applyProps(layer: Layer, props: Record<string, unknown>): { applied: string[]; skipped: string[] } {
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
    } else if (key === 'content' || key === 'fontFamily' || key === 'textAlign' || key === 'verticalAlign') {
      if (el.type !== 'text') {
        skipped.push(`${key} (element is ${el.type}, not text)`);
        continue;
      }
      (el as Record<string, unknown>)[key] = value;
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
    const { info, scenes } = await loadBundle(set);
    const file = sceneFileOf(info, scenes, scene);
    const doc = scenes[file];
    if (!doc) throw new Error(`scene file ${file} is unreadable`);
    const layer = findLayer(doc, element);
    const { applied, skipped } = applyProps(layer, props);
    if (applied.length === 0) return text({ applied, skipped, saved: false });
    await api('/api/scene', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: info.root, name: info.name, file, doc }),
    });
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
  'Add a new topmost layer to a scene: an image from the set\'s asset pool, or a text element. ' +
    'Position is the box CENTER (defaults to scene center); images default to their natural size. ' +
    'An open editor updates live; render_scene afterwards to verify.',
  {
    set: z.string(),
    scene: z.string(),
    type: z.enum(['image', 'text']),
    asset: z.string().optional().describe('Image only: asset path from the pool, e.g. "assets/logo.png"'),
    content: z.string().optional().describe('Text only: the text to show'),
    key: z.string().optional().describe('Data key so update() can address it, e.g. "_sponsor"'),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    fontSize: z.number().optional().describe('Text only (default 40)'),
    color: z.string().optional().describe('Text only: CSS color (default #ffffff)'),
  },
  async ({ set, scene, type, asset, content, key, x, y, width, height, fontSize, color }) => {
    const { info, scenes } = await loadBundle(set);
    const file = sceneFileOf(info, scenes, scene);
    const doc = scenes[file];
    if (!doc) throw new Error(`scene file ${file} is unreadable`);
    if (type === 'image' && !asset) throw new Error('image layers need an `asset` (see list_scenes / the assets pool)');

    let w = width ?? 300;
    let h = height ?? 100;
    if (type === 'image' && asset && (width === undefined || height === undefined)) {
      const nat = await probeAssetSize(info, asset);
      if (nat) {
        w = width ?? nat.w;
        h = height ?? nat.h;
      }
    }
    const comp = doc.composition;
    const id = `layer-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const style: Record<string, unknown> = {
      x: { value: Math.round(x ?? comp.width / 2) },
      y: { value: Math.round(y ?? comp.height / 2) },
      width: { value: Math.round(w) },
      height: { value: Math.round(h) },
    };
    const element =
      type === 'image'
        ? { id: `${id}-el`, type: 'image', asset: asset!, ...(key ? { key } : {}), style }
        : {
            id: `${id}-el`,
            type: 'text',
            ...(key ? { key } : {}),
            content: content ?? 'Text',
            textAlign: 'center',
            style: { ...style, fontSize: { value: fontSize ?? 40 }, color: { value: color ?? '#ffffff', unit: 'color' } },
          };
    doc.composition.layers.push({
      id,
      startFrame: 0,
      duration: comp.duration,
      element,
    } as unknown as Layer);
    await api('/api/scene', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: info.root, name: info.name, file, doc }),
    });
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

await server.connect(new StdioServerTransport());
