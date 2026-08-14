/**
 * riposte.config.json — THE machine-level config file, next to the server
 * (packages/server/ in dev, the dist root when packaged). Created on first
 * boot with defaults so every knob is discoverable; hand-edit and restart,
 * or let the app write it (playout HUD port change, deploy, export).
 *
 * Precedence: env var > config file > built-in default. Env vars are one-off
 * overrides (RIPOSTE_PORT, RIPOSTE_AMCP_PORT, RIPOSTE_AMCP_PREVIEW_PORT,
 * RIPOSTE_PROJECTS_DIR, RIPOSTE_EXAMPLES_DIR) — resolution lives in index.ts,
 * this module only owns the file.
 *
 * Set-level settings (export mode, WebP, OGraf layout) do NOT belong here —
 * they travel with the set in set.json.
 *
 * Absorbs the pre-0.7.1 dotfiles `.amcp-ports.json` and `.contract-config.json`:
 * folded in and deleted on first boot.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RiposteConfig {
  /** HTTP port for editor/bench/API (env override: RIPOSTE_PORT). */
  port: number;
  /** Virtual-CasparCG AMCP listeners; 0 disables (env: RIPOSTE_AMCP_PORT / _PREVIEW_PORT). */
  amcpPort: number;
  amcpPreviewPort: number;
  /** Set roots; null = <repo|dist root>/projects and /examples (env: RIPOSTE_PROJECTS_DIR / RIPOSTE_EXAMPLES_DIR). */
  projectsDir: string | null;
  examplesDir: string | null;
  /** CasparCG template dir — the Deploy target (written on every deploy). */
  deployDir: string | null;
  /** ControlCenter graphics_sets folder for the mapping-contract check. */
  contractDir: string | null;
  /** Per-set export target overrides, keyed "<root>/<setName>"; absent = <set>/export. */
  exportDirs: Record<string, string>;
  /** Last folder a .set archive was saved to (seeds the next save prompt). */
  setFileDir: string | null;
}

const DEFAULTS: RiposteConfig = {
  port: 5720,
  amcpPort: 6250,
  amcpPreviewPort: 6251,
  projectsDir: null,
  examplesDir: null,
  deployDir: null,
  contractDir: null,
  exportDirs: {},
  setFileDir: null,
};

let configPath = '';
let config: RiposteConfig = { ...DEFAULTS };

function persist(): void {
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.warn(`cannot write ${configPath}: ${(err as Error).message}`);
  }
}

/** Load (or create) riposte.config.json. Call once at boot, before reading ports/dirs. */
export function loadConfig(serverRoot: string): RiposteConfig {
  configPath = join(serverRoot, 'riposte.config.json');
  if (existsSync(configPath)) {
    try {
      config = { ...DEFAULTS, ...(JSON.parse(readFileSync(configPath, 'utf8')) as Partial<RiposteConfig>) };
    } catch (err) {
      // a hand-edit typo must not be clobbered by defaults — run on defaults, leave the file
      console.warn(`riposte.config.json unreadable (${(err as Error).message}) — running on defaults, file left untouched`);
    }
    return config;
  }
  // first boot: fold in the legacy per-machine dotfiles, then write the file
  config = { ...DEFAULTS };
  for (const [legacy, apply] of [
    ['.amcp-ports.json', (v: Record<string, unknown>) => {
      if (typeof v['main'] === 'number') config.amcpPort = v['main'];
      if (typeof v['preview'] === 'number') config.amcpPreviewPort = v['preview'];
    }],
    ['.contract-config.json', (v: Record<string, unknown>) => {
      if (typeof v['dir'] === 'string') config.contractDir = v['dir'];
    }],
  ] as const) {
    const p = join(serverRoot, legacy);
    try {
      apply(JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>);
      unlinkSync(p);
      console.log(`migrated ${legacy} into riposte.config.json`);
    } catch {
      // absent or unreadable — nothing to migrate
    }
  }
  persist();
  console.log(`created ${configPath}`);
  return config;
}

export function getConfig(): RiposteConfig {
  return config;
}

/** Merge a partial update and write the file. */
export function saveConfig(patch: Partial<RiposteConfig>): RiposteConfig {
  Object.assign(config, patch);
  persist();
  return config;
}
