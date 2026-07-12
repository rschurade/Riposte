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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  'List the scenes of a set with their data keys (the update() variables each template accepts).',
  { set: z.string().describe('Set name, e.g. "FIE_2026"') },
  async ({ set }) => {
    const { scenes } = await loadBundle(set);
    const out = Object.entries(scenes).map(([file, doc]) => ({
      scene: file.replace(/^scenes\//, '').replace(/\.json$/, ''),
      keys: doc ? [...new Set(doc.composition.layers.map((l) => l.element.key).filter(Boolean))] : [],
    }));
    return text(out);
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
    'Saves through the Riposte server; render_scene afterwards to see the result.',
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
