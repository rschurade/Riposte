/**
 * Virtual CasparCG — an AMCP TCP listener that lets ControlCenter connect to
 * Riposte as if it were a real CasparCG server. Parsed commands are pushed to
 * the /playout browser page over the existing SSE channel; the page stacks CG
 * layers and drives them with the real runtime.
 *
 * Two listeners mirror a production rig: MAIN (6250) and PREVIEW (6251),
 * overridable via RIPOSTE_AMCP_PORT / RIPOSTE_AMCP_PREVIEW_PORT (0 disables).
 * Deliberately NOT the real CasparCG ports (5250/5251) — real Caspar
 * instances commonly run on the same machine, and node's IPv6 wildcard bind
 * would silently coexist with Caspar's IPv4 one, splitting traffic by
 * address family. Point ControlCenter at 6250/6251 in its Settings tab.
 * A failed bind is a warning, not a crash.
 *
 * Understood: CG ADD/UPDATE/PLAY/STOP/NEXT/REMOVE/INVOKE/CLEAR. Everything
 * else (PLAY/MIXER/CLEAR for the portrait media layers, queries) is
 * acknowledged with 202 and surfaced to the playout console as-is.
 */
import { createServer as createTcpServer, type Socket } from 'node:net';

export interface AmcpSetInfo {
  root: string;
  name: string;
  scenes: string[];
  components: string[];
  fonts: { family: string; file: string }[];
}

export interface AmcpOptions {
  listSets: () => Promise<AmcpSetInfo[]>;
  broadcast: (event: string, payload: unknown) => void;
  log?: (msg: string) => void;
}

interface CgEvent {
  kind: 'cg';
  feed: string;
  chan: number;
  layer: number;
  cgLayer: number;
  action: string;
  template?: string;
  /** Resolved scene: where the playout page can fetch the docs. */
  ref?: { root: string; set: string; scene: string; components: string[]; fonts: { family: string; file: string }[] };
  data?: string;
  playOnLoad?: boolean;
  raw: string;
}

/** AMCP tokenizer: space-separated, double quotes group, backslash escapes inside quotes. */
export function amcpTokens(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  let sawQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuote) {
      if (c === '\\' && i + 1 < line.length) cur += line[++i]!;
      else if (c === '"') inQuote = false;
      else cur += c;
    } else if (c === '"') {
      inQuote = true;
      sawQuote = true;
    } else if (c === ' ' || c === '\t') {
      if (cur || sawQuote) out.push(cur);
      cur = '';
      sawQuote = false;
    } else cur += c;
  }
  if (cur || sawQuote) out.push(cur);
  return out;
}

/**
 * Resolve an AMCP template name to a set scene. Case-insensitive; a folder
 * prefix ("FIE_2026/FIE_2026_HD_Schedule") narrows to the matching set name,
 * a bare name searches every set. Extensions (.html) are ignored.
 */
export async function resolveTemplate(
  name: string,
  listSets: () => Promise<AmcpSetInfo[]>,
): Promise<CgEvent['ref'] | null> {
  const parts = name.replace(/\.(html?|ft|wt|ct)$/i, '').split(/[\\/]/).filter(Boolean);
  const scene = (parts.pop() ?? '').toLowerCase();
  const folder = parts.length > 0 ? parts[parts.length - 1]!.toLowerCase() : null;
  if (!scene) return null;
  const sets = await listSets();
  const candidates = folder ? sets.filter((s) => s.name.toLowerCase() === folder) : sets;
  for (const s of [...candidates, ...(folder ? sets : [])]) {
    for (const file of s.scenes) {
      const base = file.replace(/^scenes\//, '').replace(/\.json$/, '');
      if (base.toLowerCase() === scene) {
        return { root: s.root, set: s.name, scene: base, components: s.components, fonts: s.fonts };
      }
    }
  }
  return null;
}

const CG_ACTIONS = new Set(['ADD', 'UPDATE', 'PLAY', 'STOP', 'NEXT', 'REMOVE', 'INVOKE', 'CLEAR']);

async function handleLine(line: string, feed: string, opts: AmcpOptions): Promise<string> {
  const tokens = amcpTokens(line);
  const cmd = (tokens[0] ?? '').toUpperCase();
  if (!cmd) return '400 ERROR';

  if (cmd === 'CG') {
    const target = /^(\d+)-(\d+)$/.exec(tokens[1] ?? '');
    const action = (tokens[2] ?? '').toUpperCase();
    if (!target || !CG_ACTIONS.has(action)) return '400 CG ERROR';
    const ev: CgEvent = {
      kind: 'cg',
      feed,
      chan: Number(target[1]),
      layer: Number(target[2]),
      cgLayer: Number(tokens[3] ?? '1'),
      action: action.toLowerCase(),
      raw: line,
    };
    if (action === 'ADD') {
      // CG <chan>-<layer> ADD <cgLayer> "<template>" <playOnLoad> ["<data>"]
      ev.template = tokens[4] ?? '';
      ev.playOnLoad = tokens[5] === '1';
      ev.data = tokens[6];
      const ref = await resolveTemplate(ev.template, opts.listSets);
      if (!ref) {
        opts.broadcast('amcp', ev); // surface the miss in the playout console
        return `404 CG ERROR template not found "${ev.template}"`;
      }
      ev.ref = ref;
    } else if (action === 'UPDATE') {
      ev.data = tokens[4];
    } else if (action === 'INVOKE') {
      ev.data = tokens[4];
    }
    opts.broadcast('amcp', ev);
    return '202 CG OK';
  }

  // Media-layer and other commands (PLAY/MIXER/CLEAR/…): acknowledge + surface.
  const target = /^(\d+)(?:-(\d+))?$/.exec(tokens[1] ?? '');
  opts.broadcast('amcp', {
    kind: 'media',
    feed,
    cmd,
    chan: target ? Number(target[1]) : undefined,
    layer: target?.[2] !== undefined ? Number(target[2]) : undefined,
    clip: cmd === 'PLAY' ? tokens[2] : undefined,
    raw: line,
  });
  return `202 ${cmd} OK`;
}

function serveSocket(socket: Socket, feed: string, opts: AmcpOptions): void {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  opts.broadcast('amcp', { kind: 'conn', feed, state: 'connected', peer });
  opts.log?.(`amcp ${feed}: ${peer} connected`);
  socket.setNoDelay(true);
  let buf = '';
  // strictly sequential: replies AND broadcasts must keep command order
  // (an UPDATE overtaking its own ADD would be dropped by the playout page)
  let chain = Promise.resolve();
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      chain = chain.then(async () => {
        const reply = await handleLine(line, feed, opts).catch(() => '500 ERROR');
        if (!socket.destroyed) socket.write(reply + '\r\n');
      });
    }
  });
  const bye = () => {
    opts.broadcast('amcp', { kind: 'conn', feed, state: 'disconnected', peer });
    opts.log?.(`amcp ${feed}: ${peer} disconnected`);
  };
  socket.on('close', bye);
  socket.on('error', () => socket.destroy());
}

/** Start the MAIN + PREVIEW listeners. Returns the ports that actually bound. */
export function startAmcp(opts: AmcpOptions): { feed: string; port: number }[] {
  const feeds = [
    { feed: 'main', port: Number(process.env['RIPOSTE_AMCP_PORT'] ?? 6250) },
    { feed: 'preview', port: Number(process.env['RIPOSTE_AMCP_PREVIEW_PORT'] ?? 6251) },
  ];
  const bound: { feed: string; port: number }[] = [];
  for (const { feed, port } of feeds) {
    if (!port) continue;
    const server = createTcpServer((socket) => serveSocket(socket, feed, opts));
    server.on('error', (err) => {
      opts.log?.(`amcp ${feed}: cannot listen on ${port} (${(err as Error).message}) — virtual CasparCG ${feed} disabled`);
    });
    server.listen(port, () => {
      opts.log?.(`amcp ${feed}: virtual CasparCG listening on ${port}`);
    });
    bound.push({ feed, port });
  }
  return bound;
}
