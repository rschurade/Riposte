# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Riposte is a local, standalone studio for designing and exporting CasparCG HTML graphic templates. It replaces Loopic (a cloud editor whose exports bake every asset into one 8–23 MB base64 HTML file). It is used to author the fencing broadcast graphics that the sibling **TV-Grafik** repo's ControlCenter drives on air.

**Core principle: the runtime is the product; the editor is a client of it.** One zero-dependency engine (`@riposte/runtime`, built to a single `riposte.js` IIFE) renders a `scene.json` via DOM+CSS and implements the CasparCG template contract. The editor's preview canvas, the bench, and the on-air template all run that exact engine, so WYSIWYG holds by construction.

**A project is a set, not a scene:** many scenes share ONE `assets/` folder. Assets are content-hash deduplicated — identity is the content hash, the filename is only a label. Swap `frame.png` once and every scene in the set is rebranded.

## Repository Layout

TypeScript ESM monorepo (npm workspaces, Node ≥ 24 — server/importer/mcp run `.ts` natively, no build step).

| Path | Purpose |
|---|---|
| `packages/shared` | Scene/set format types (`src/scene.ts`, `src/set.ts`), `trimToContent` |
| `packages/runtime` | The rendering engine — zero deps, esbuild → `dist/riposte.js` (IIFE) |
| `packages/importer` | Loopic `.loo` (primary) + Loopic HTML-export (fallback) → set projects; script→binding migrator |
| `packages/exporter` | Set project → CasparCG templates (`external` default / `baked` fallback), `syncDir` for deploy |
| `packages/server` | Node server on **:5720** — bench at `/`, file/project/asset HTTP API, SSE (`src/index.ts`, single file) |
| `packages/editor` | Svelte 5 + Vite UI on **:5719** (proxies to :5720). State: `src/lib/state.svelte.ts`; panels: Sidebar/Stage/Timeline/Inspector |
| `packages/mcp` | MCP server (`riposte`, stdio) — semantic tools over the HTTP API |
| `tools/` | PS/Node helpers: `ab-diff.ps1`, `bench-shot.ps1`, `trim-durations.mjs`, one-off Schedule porters |
| `examples/demo` | Committed demo set (loop-region showcase) |
| `projects/` | **User data — a NESTED, SEPARATE git repo** (remote `rschurade/Riposte-Sets`), gitignored by this repo |

### The projects/ rule (important)

`projects/` is its own git repo tracking scenes + `set.json` + assets (uploaded assets have no other source). Its `export/`, `_export/`, `_ab/` are ignored. **Never track user data in this (code) repo.** Pushing Riposte-Sets after set-editing days is encouraged — it's data backup, the "don't push untested code" etiquette does not apply to it.

## Commands

```bash
npm run check     # typecheck all packages (tsc -p . each)
npm test          # node:test — runtime + importer only
npm run build     # runtime IIFE (packages/runtime/dist/riposte.js) + editor vite build
npm run server    # node --watch server on :5720
npm run dev       # vite editor on :5719
```

CLIs (package bins): `riposte-import <set-dir> <file.loo>`, `riposte-import-html <set-dir> <export.html>`, `riposte-migrate <set-dir>`, `riposte-export <set-dir> [outDir] [--baked]`, `riposte-mcp`.

### Dev server rules

- Start both servers as **background tasks via the harness** (`run_in_background`). NEVER spawn hidden processes (`Start-Process -WindowStyle Hidden node …`) — the user's antivirus kills them.
- **Check for existing listeners on 5719/5720 first** (orphan processes from previous sessions are common; the user's own vite may hold 5719). A second vite auto-increments to 5720 where it half-collides with the node server and proxy-loops itself into ENOBUFS.

## MCP Server

Registered via `.mcp.json` (here relative, in TV-Grafik absolute+gitignored). Requires the HTTP server on :5720 (`RIPOSTE_URL` overrides; `RIPOSTE_BROWSER` sets the headless browser for renders). 11 tools: `list_sets`, `list_scenes`, `get_scene`, `open_scene` (navigates the user's live editor via SSE), `set_element`, `add_layer`, `import_assets`, `render_scene`, `render_filmstrip`, `export_set`, `deploy_set`.

**When the server is up, prefer these tools** over hand-editing scene JSON or `bench-shot.ps1`: `set_element` saves + live-syncs the editor; `render_scene` returns a PNG (default frame = the hold/pause frame) — that is the visual feedback loop.

## Scene Format Essentials

Types in `packages/shared/src/scene.ts` + `set.ts`. `SceneDoc { formatVersion, name, previewData?, composition }`.

- `Composition { width, height, fps, duration, markers[], layers[], action? }`. Markers are **first-class**: `pause`, `outro` (≤1), `loop`, `action` — not code snippets.
- `Layer { id, name?, startFrame, duration, isGuide?, hidden?, loop?, masks?, element }`. Keyframes are stored in absolute scene frames (imported .loo keyframes are LAYER-LOCAL and get offset by `startFrame` at import).
- `layer.loop = { start, end, exitFade? }` (layer-local): cycles on its own clock while the scene holds at a pause, fades in place over `exitFade` (default 15) in sync with the outro. **Top-level layers only** — loops inside nested compositions don't tick.
- Elements: `text`, `image`, `imageSequence` (`frames[]`), `imageLoader` (`fit`, `placeholder` — design-time stand-in asset), `rectangle`, `ellipse`, `path`, `composition` (`compositionId` → component file; nested comps render recursively, child playhead = parent − startFrame, clamped). The type set is open.
- `ElementStyle`: **x/y are the box center** (Loopic convention). `StyleProperty { value, unit?, keyframes[] }` — when keyframes exist the static value is ignored.
- `element.visibility = { bindKey, showWhen?/hideWhen? (default hideWhen ["0"]), initial? }` — shows/hides from an `update()` value via CSS `visibility`, composing with layer span (display) and opacity fades. This replaced Loopic-era show/hide scripts (`riposte-migrate` converts them). Binding state is a pure function of the last update value.
- `previewData`: design-time sample update payload for bench/editor; never shipped.
- Hidden layer semantics (Loopic parity): hidden = CSS **visibility**, not display; a binding on a hidden layer's element toggles the wrapper, respecting span + fades. Data-shown "white light" layers rely on this.
- Actions (`composition.action`, action markers) are the escape hatch for genuinely dynamic behavior (e.g. Schedule's row relayout). Scope: `useOnPlay/useOnUpdate/useOnStop/useOnNext/useOnInvoke`, `find(key)`, `riposte`; `loopic`/`runtime` are deprecated aliases. **The editor deliberately does not execute actions or bindings — design view shows everything.**
- `set.json`: `{ formatVersion, name, scenes[], components?, fonts?, export? }` — `components` are nested-composition-only scenes, not exported as templates. Optional fields vary across real files.

## CasparCG Contract

Templates expose `update(data)`, `play()`, `stop()`, `next()`, AMCP INVOKE. `update` accepts **both** JSON and `<templateData><componentData…>` XML (ControlCenter sends XML). Play runs to the first `pause` marker; `next` resumes past it; `stop` plays from the `outro` marker to the end. Export modes: `external` (default — ~70 KB HTML shell + shared `assets/` incl. `riposte.js`; only referenced assets copied) and `baked` (single file, compat fallback). Export dir: `projects/<Set>/export`. **Deploy** (editor button / `deploy_set`) = export + additive `syncDir` into the CasparCG template dir — it never deletes foreign files.

## Design Rules (user-established — do not violate)

- **The scene IS the final design.** Bake static design into scene data; never reconstruct it via runtime scripts and call the mismatch "just scripts". The editor must show the on-air look by default. Import fidelity ≠ design fidelity.
- Data-binding keys (`_leftScore`, `_timeSwitch`, …) are a **contract with ControlCenter's mappings** — keep existing names when migrating scenes.
- Videos stay out of scenes — athlete clips are a ControlCenter/CasparCG media-layer concern.
- Asset collisions: same name + different bytes must NEVER silently overwrite (hash-suffix + report).

## Verification

- Unit tests: `npm test` (runtime interpolation/player/visibility/loop, importer convert/migrate). Player tests use a stubbed rAF clock — headless virtual time can't drive animations.
- Visual: `render_scene`/`render_filmstrip` MCP tools, or `tools/bench-shot.ps1` against the bench. Headless screenshots need `--virtual-time-budget=6000+` or you get a blank PNG; frames past the outro marker are legitimately blank — shoot at the pause frame. Nested comps render blank under headless *play* mode in both runtimes (Edge quirk) — verify those at a seeked frame or visually.
- A/B vs Loopic: `tools/ab-diff.ps1` + `projects/_ab/` harnesses; serve both pages in fixed 1920×1080 iframes (Loopic's fitToWindow otherwise rescales and ruins diffs).

## Gotchas

- Node native TS forbids constructor parameter properties — tsconfig uses `erasableSyntaxOnly`.
- The server's `PUT /api/scene` re-serializes scene JSON pretty-printed (diffs may reformat).
- Importer names scenes after the **.loo filename**, not the internal composition name (identical comp names across files would collide otherwise).
- Component files are content-deduped on import: same name + different content → `name-<hash8>.json`.
- Loopic text box model: line-height 1.2 must always be set explicitly (CSS `normal` is font-dependent and shifts vertical alignment).
- Editor stage perf: element reads of `ed.frame` must stay tracked — a `built?.setFrame(ed.frame)`-style short-circuit kills effect dependencies and freezes the preview.
- Pre-2026-07-12 commit SHAs found in old notes are stale (history was rewritten to strip user data).
