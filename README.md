# Riposte

A local, standalone studio for designing and exporting CasparCG HTML graphic
templates. *Riposte* — the counter-attack that follows a parry.

Riposte is a browser-based motion-graphics editor plus a rendering engine,
running entirely on your machine: a local Node server, an editor UI, and a
small runtime that plays the graphics on air. Scenes are plain JSON, assets
are plain files, and everything lives in a git-friendly project folder — no
cloud, no accounts. Its core ideas:

- **The runtime is the product.** A small zero-dependency engine renders a
  `scene.json` via DOM+CSS and implements the CasparCG template contract
  (`update` / `play` / `stop` / `next` / `invoke`). The editor's preview canvas
  runs that exact engine, so editor and on-air output cannot diverge.
- **A project is a *set*, not a scene.** Many scenes share one `assets/`
  folder — swap `frame.png` once and every scene in the set is rebranded.
  Assets are plain files, content-hash deduplicated; projects are diffable JSON.
- **Exports stay small.** Template shells reference the shared assets folder
  (with an optional baked single-file fallback for compatibility).

## Features

### Editor
- Stage with direct manipulation: drag, multi-select (group move/delete),
  resize handles, on-stage mask handles, snap-to-grid (center-anchored),
  ruler guides (lockable, layers snap to them), layer locking, zoom/pan.
- Timeline: per-layer spans, keyframes with bezier easing, keyframe
  copy/paste across elements and scenes, layer reordering (drag or
  Ctrl+arrows), draggable markers with per-marker locks — pause, outro
  (`stop()` plays from there), loop, and frame actions (JS).
- Inspector for every element type: text (incl. tabular numerals / digit
  boxing for jitter-free clocks), image, image sequence, image loader
  (runtime-fed image with design-time placeholder), rectangle/ellipse
  (with dynamic size binding — a bar that follows a text layer's measured
  width), nested composition.
- Components: reusable nested compositions — edit once, every scene that
  embeds one follows; drag a component from the sidebar onto the stage to
  embed it. Convert scene ⇄ component, extract a selection into a new
  component (or move it into an existing one); loop regions inside a
  nested component keep cycling while the parent scene holds.
- Scene-level **intro/outro presets**: named, reusable effects (fade,
  wipes, slides, an inverted-mask diamond…) played on ADD and STOP around
  the scene's own animation — with a visual preset editor previewing live
  on the real scene, and a stock collection seeded into new sets.
- Masks per layer, animatable x/y/w/h, rotation, inverted, per-corner
  radius.
- Data bindings: `update()` payload keys map to elements (`_name`
  convention, dot paths into nested components), visibility bindings with
  initial state, per-scene preview data for design-time.
- Asset management: drag-and-drop import, image sequences auto-grouped
  (rename, drag to stage as one), hover preview pane (images, sequences,
  live font samples), usage tracking with one-click delete-unused,
  per-scene visibility filter for the scene list.
- Undo/redo, per-file dirty tracking (unsaved scenes marked everywhere,
  auto-saved before export/deploy), deep links
  (`?set=…&scene=…&frame=…&layer=…`), resizable persisted panels.

### Export & deploy
- Incremental export: tiny per-scene HTML shells + one shared `assets/`
  folder and runtime; only changed files are written.
- Optional PNG→WebP re-encoding on export (cached, lossy/lossless race
  per image; the set on disk stays PNG) — real-world set: 213 MB → 27 MB.
- One-click deploy into a CasparCG template directory — additive and
  incremental, with an optional force-full-redeploy.
- Mapping-contract check on export/deploy: warns about template keys no
  controller mapping fills and mappings pointing at removed keys.
- Baked single-file export as a compatibility fallback (all assets inlined).

### Rehearsal without a broadcast rig
- **Virtual CasparCG**: the server speaks AMCP on its own ports, so the
  real production controller connects to Riposte as if it were a Caspar
  server; a playout page renders what would be on air (main + preview
  feeds). Doubles as a wire-tap to inspect exactly what a graphic receives.
- **Bench**: load any exported scene, inject `update()` data, step the
  lifecycle (`add/play/next/stop`), `?debug=<key>` logs element geometry
  per update.

### Automation
- **MCP server**: the full authoring surface (~50 tools) — set/scene
  CRUD and conversion, layers, keyframes, masks, markers, loops,
  bindings, effect presets, asset management, headless scene/filmstrip
  rendering, export/deploy, and live bench control. An AI assistant can
  build a graphic from a blank set to a deployed template, and verify it
  visually, end-to-end.
- Importer for Loopic `.loo` projects (scenes, assets, scripts).

### Distribution
- `npm run dist` builds a portable zip: bundled server, built editor,
  start scripts — recipients need only a Node.js LTS install.

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
`sh start.sh` (Mac/Linux — the Windows-built zip can't carry the executable
bit, so plain `./start.sh` needs a `chmod +x` first) — the browser opens the
editor at `http://localhost:5720`. Sets are shared by copying set folders into
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
