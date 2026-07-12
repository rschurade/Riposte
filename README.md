# Riposte

A local, standalone studio for designing and exporting CasparCG HTML graphic
templates. *Riposte* — the counter-attack that follows a parry.

Riposte replaces a cloud editor whose exports bake every asset into one 8–23 MB
base64-encoded HTML file. Its core ideas:

- **The runtime is the product.** A small zero-dependency engine renders a
  `scene.json` via DOM+CSS and implements the CasparCG template contract
  (`update` / `play` / `stop` / `next` / `invoke`). The editor's preview canvas
  runs that exact engine, so editor and on-air output cannot diverge.
- **A project is a *set*, not a scene.** Many scenes share one `assets/`
  folder — swap `frame.png` once and every scene in the set is rebranded.
  Assets are plain files, content-hash deduplicated; projects are diffable JSON.
- **Exports stay small.** Template shells reference the shared assets folder
  (with an optional baked single-file fallback for compatibility).

## Repository layout

| Package | Purpose |
|---|---|
| `packages/shared` | Scene/set format types, JSON schema, validation |
| `packages/runtime` | The rendering engine — zero deps, builds to one IIFE (`riposte.js`) |
| `packages/importer` | Converts Loopic HTML exports into Riposte set projects |
| `packages/exporter` | Set project → CasparCG templates (external-assets or baked) |
| `packages/server` | Local Node server (:5720): preview bench, file/project/asset API |
| `packages/editor` | Svelte UI (:5719 dev, proxies to the server) — canvas, timeline, inspector, resources |
| `packages/mcp` | MCP server — semantic editing/render tools over the HTTP API |

## Running it (no development setup)

`npm run dist` produces `dist/riposte-<version>.zip`. Recipients need only
[Node.js LTS](https://nodejs.org): unzip, run `start.cmd` (Windows) or
`./start.sh` (Mac/Linux) — the browser opens the editor at
`http://localhost:5720`. Sets are shared by copying set folders into
`projects/`. The bench lives at `/bench`, the virtual-CasparCG playout at
`/playout.html`.

## Development

Requires Node ≥ 24 (TypeScript runs natively in `server`/`importer`).

```bash
npm install
npm run check     # typecheck all packages
npm run dev       # editor (Vite dev server)
npm run server    # local file/project server
```

See [docs/design.md](docs/design.md) for the design record and as-built status,
and [CLAUDE.md](CLAUDE.md) for operational guidance (commands, ports, format
essentials, gotchas).
