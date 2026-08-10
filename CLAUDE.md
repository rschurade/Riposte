# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Riposte is a local, standalone studio for designing and exporting CasparCG HTML graphic templates. It also exports to SPX (CasparCG HTML with embedded SPXGCTemplateDefinition) and OGraf (EBU standard). It replaces Loopic (a cloud editor whose exports bake every asset into one 8–23 MB base64 HTML file). It is used to author the fencing broadcast graphics that the sibling **TV-Grafik** repo's ControlCenter drives on air.

**Core principle: the runtime is the product; the editor is a client of it.** One zero-dependency engine (`@riposte/runtime`, built to a single `riposte.js` IIFE) renders a `scene.json` via DOM+CSS and implements the CasparCG template contract. The editor's preview canvas, the bench, and the on-air template all run that exact engine, so WYSIWYG holds by construction.

**A project is a set, not a scene:** many scenes share ONE `assets/` folder. Assets are content-hash deduplicated — identity is the content hash, the filename is only a label. Swap `frame.png` once and every scene in the set is rebranded.

## Repository Layout

TypeScript ESM monorepo (npm workspaces, Node ≥ 24 — server/importer/mcp run `.ts` natively, no build step).

| Path | Purpose |
|---|---|
| `packages/shared` | Scene/set format types (`src/scene.ts`, `src/set.ts`), `trimToContent` |
| `packages/runtime` | The rendering engine — zero deps, esbuild → `dist/riposte.js` (IIFE) |
| `packages/importer` | Loopic `.loo` (primary) + Loopic HTML-export (fallback) → set projects; script→binding migrator |
| `packages/exporter` | Set project → CasparCG templates (`external` default / `baked` fallback) + SPX (CasparCG HTML with embedded SPXGCTemplateDefinition) + OGraf (EBU manifest + graphic.mjs); `syncDir` for deploy |
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
npm run build     # runtime IIFE (packages/runtime/dist/riposte.js) + editor vite build + server bundle
npm run server    # node --watch server on :5720
npm run dev       # vite editor on :5719
npm run dist      # portable distribution: dist/riposte/ + dist/riposte-<version>.zip
```

### Distribution (portable zip)

**Cutting a release:** bump `version` in the root `package.json`, add the
version's section to `CHANGELOG.md` (user-facing Added/Fixed, not commit
subjects; the zip ships it), then `npm run dist`.

`npm run dist` packs a folder that runs anywhere with only a Node.js LTS install: the esbuild-bundled `server.js` (no native TS → no Node-24 requirement, no npm install), the built editor, runtime, bench/playout, the demo set, an empty `projects/`, and `start.cmd`/`start.sh` (run `node server.js --open`). **Packaged layout is auto-detected** (a `public/` dir next to `server.js`): the editor is then served at `/` and the bench moves to `/bench`; in the dev repo, `/` stays the bench (bench-shot.ps1 and A/B tooling depend on that) and the editor stays on vite. `RIPOSTE_PROJECTS_DIR` / `RIPOSTE_EXAMPLES_DIR` override the set roots in both modes. Recipients share sets by copying folders into `projects/`.

CLIs (package bins): `riposte-import <set-dir> <file.loo>`, `riposte-import-html <set-dir> <export.html>`, `riposte-migrate <set-dir>`, `riposte-export <set-dir> [outDir] [--baked]`, `riposte-mcp`.

### Dev server rules

- Start both servers as **background tasks via the harness** (`run_in_background`). NEVER spawn hidden processes (`Start-Process -WindowStyle Hidden node …`) — the user's antivirus kills them.
- **Check for existing listeners on 5719/5720 first** (orphan processes from previous sessions are common; the user's own vite may hold 5719). A second vite auto-increments to 5720 where it half-collides with the node server and proxy-loops itself into ENOBUFS.

## MCP Server

Registered via `.mcp.json` (here relative, in TV-Grafik absolute+gitignored). Requires the HTTP server on :5720 (`RIPOSTE_URL` overrides; `RIPOSTE_BROWSER` sets the headless browser for renders). 48 tools — the full authoring surface; a blank-scene-to-finished-graphic build is possible over MCP alone (proven: demo/GreenBar + RedSphere):

- **Inspect**: `list_sets`, `list_scenes` (the update() input surface: content keys + switches), `get_scene`, `list_assets` (sequences collapsed to `###` patterns), `list_presets` (with per-scene usage), `contract_check`, `playout_status` (AMCP ports/connections).
- **Sets**: `create_set` (stock presets seeded), `import_loo` (local .loo path → existing set), `set_export_settings` (mode/preload/webp).
- **Scenes/components**: `create_scene` (kind scene|component, donor canvas defaults), `duplicate_scene`, `rename_scene` (rewrites embed refs), `remove_scene` (embed-guarded; `deleteFile` opt-in), `convert_scene` (scene⇄component), `set_composition` (canvas/fps/duration — no rescaling), `set_scene_action`, `set_preview_data`, `extract_to_component` (elements → new component, replaced by an instance), `move_to_component` (→ existing component).
- **Layers/elements**: `add_layer` (image/text/rectangle/ellipse/component/imageLoader/imageSequence via `###` pattern), `delete_layer`, `duplicate_layer` (key auto-suffixed), `reorder_layer` (front/back/forward/backward or above/below), `set_layer_span`, `set_element` (geometry, text incl. weight/transform/squeeze/tabularNums/autoSize/padding, fill/borderRadius, loader fit/placeholder, image asset swap, data `key`, layer name/hidden/locked/isGuide), `set_keyframes` (absolute frames, easing presets or bezier; `mask` targets a mask), `set_mask` (add/edit/remove, inverted, radius), `set_visibility_binding`, `set_loop`, `set_markers` (full-list replace).
- **Effect presets**: `save_preset` / `delete_preset` / `add_stock_presets`, `set_scene_effects` (assign intro/outro, validated against the pools).
- **Assets**: `import_assets` (local folder scan), `delete_assets` (destructive, explicit list), `rename_asset` / `rename_sequence` (rewrite references).
- **Render/ship**: `render_scene`, `render_filmstrip`, `export_set`, `deploy_set`.
- **Live UI**: `open_scene` (navigates the user's editor), `bench_open` / `bench_update` / `bench_transport` (drive the bench tab the user is watching via POST /api/bench → SSE).

Deliberately NOT exposed: guides/eye-filter (personal workspace state), undo (session concept), AMCP port and contract-dir setting (read-only status instead).

**When the server is up, prefer these tools** over hand-editing scene JSON or `bench-shot.ps1`: `set_element` saves + live-syncs the editor; `render_scene` returns a PNG (default frame = the hold/pause frame) — that is the visual feedback loop.

## Virtual CasparCG

The server doubles as a fake CasparCG: AMCP TCP listeners on **6250 (main)** and **6251 (preview)** (`RIPOSTE_AMCP_PORT` / `RIPOSTE_AMCP_PREVIEW_PORT`, 0 disables; deliberately NOT 5250/5251 — real Caspar instances often run on the same machine, and node's IPv6 bind would silently coexist with Caspar's IPv4 one). Point ControlCenter's Main/Preview outputs at these ports and open **`/playout?feed=main`** and **`/playout?feed=preview`** (`&chan=` selects the channel, default 1) — CG ADD/UPDATE/PLAY/NEXT/STOP/REMOVE/INVOKE render as stacked layers via the real runtime; template names resolve case-insensitively across all sets (folder prefix narrows to a set). Media-layer commands (portrait PLAY/MIXER/CLEAR) show as chips, not video. Absolute disk paths inside update data (ControlCenter's flags/logos, loadable by Caspar's CEF but not by a browser) are rewritten client-side to the `/api/mediafile?p=` endpoint, which serves local image/font files by absolute path. The backtick key (or the console button) toggles a command console — the wire-tap view of exactly what a graphic receives. Command processing is strictly per-connection sequential (an UPDATE must never overtake its own ADD). Code: `packages/server/src/amcp.ts` + `public/playout.{html,js}`. **Keep the playout tab visible in its own window**: a background tab / fully covered window gets no animation frames from Chrome, so graphics freeze mid-animation ("works with the console open, not without" = the tab was in front vs. behind). Scene-outro presets complete via a wall-clock guard even hidden; the page flags it (title `⏸ HIDDEN` + a log line). Real CasparCG is immune (CEF renders offscreen).

## Scene Format Essentials

Types in `packages/shared/src/scene.ts` + `set.ts`. `SceneDoc { formatVersion, name, previewData?, composition }`.

- `Composition { width, height, fps, duration, markers[], layers[], action? }`. Markers are **first-class**: `pause`, `outro` (≤1), `loop`, `action` — not code snippets.
- `Layer { id, name?, startFrame, duration, isGuide?, hidden?, loop?, masks?, element }`. Keyframes are stored in absolute scene frames (imported .loo keyframes are LAYER-LOCAL and get offset by `startFrame` at import).
- `layer.loop = { start, end, exitFade? }` (layer-local): cycles on its own clock while the scene holds at a pause, fades in place over `exitFade` (default 15) in sync with the outro. Works at every nesting level — the parent forwards its hold clock into embedded components (`forwardClock` in dom.ts), and `hasLoops` detection is recursive.
- Elements: `text`, `image`, `imageSequence` (`frames[]`), `imageLoader` (`fit`, `placeholder` — design-time stand-in asset), `rectangle`, `ellipse`, `path`, `composition` (`compositionId` → component file; nested comps render recursively, child playhead = parent − startFrame, clamped). The type set is open.
- `ElementStyle`: **x/y are the box center** (Loopic convention). `StyleProperty { value, unit?, keyframes[] }` — when keyframes exist the static value is ignored.
- `element.visibility = { bindKey, showWhen?/hideWhen? (default hideWhen ["0"]), initial? }` — shows/hides from an `update()` value via CSS `visibility`, composing with layer span (display) and opacity fades. This replaced Loopic-era show/hide scripts (`riposte-migrate` converts them). Binding state is a pure function of the last update value.
- `previewData`: design-time sample update payload for bench/editor; never shipped.
- Text `tabularNums`: fixed-advance digits so score/clock fields don't jitter on update. Rectangle `sizeBind { sourceId, axis, padX/padY, grow }`: the bar re-measures its source text on build and every update() — the "background always fits the name" pattern (demo: `examples/demo/scenes/BoundBar.json`). `SceneDoc.guides` + `Layer.locked` are editor-only design aids (renderers/exports ignore them).
- Hidden layer semantics (Loopic parity): hidden = CSS **visibility**, not display; a binding on a hidden layer's element toggles the wrapper, respecting span + fades. Data-shown "white light" layers rely on this.
- Actions (`composition.action`, action markers) are the escape hatch for genuinely dynamic behavior (e.g. Schedule's row relayout). Scope: `useOnPlay/useOnUpdate/useOnStop/useOnNext/useOnInvoke`, `find(key)`, `riposte`; `loopic`/`runtime` are deprecated aliases. **The editor deliberately does not execute actions or bindings — design view shows everything.**
- `set.json`: `{ formatVersion, name, scenes[], components?, fonts?, export? }` — `components` are nested-composition-only scenes, not exported as templates. Optional fields vary across real files.
- `export.imageFormat: 'webp'` re-encodes PNG assets to WebP **at export time only** (FIE set: 213 MB → 27 MB; scene files keep their PNGs, exported refs are rewritten). `webpQuality` 1–100 (default 92; lossy exports also try lossless per image and ship the smaller) or `'lossless'`. Encoder = jsquash/libwebp WASM (no native deps — packaged dist ships `webp_enc_simd.wasm` next to server.js); encodes cached in `<set>/.webp-cache/` (gitignored) — first export is slow (~10 min for the FIE set), repeats are instant. Edit these in the **Set Options dialog: clicking a set in the sidebar opens it** (it no longer auto-opens the first scene).

## CasparCG Contract

Templates expose `update(data)`, `play()`, `stop()`, `next()`, AMCP INVOKE. `update` accepts **both** JSON and `<templateData><componentData…>` XML (ControlCenter sends XML). Play runs to the first `pause` marker; `next` resumes past it; `stop` plays from the `outro` marker to the end. Export modes (set per-set in **Set Options**): `external` (default — ~70 KB HTML shell + shared `assets/` incl. `riposte.js`; only referenced assets copied), `baked` (single file, compat fallback), `spx` (like external but each HTML shell carries an embedded `window.SPXGCTemplateDefinition` that maps data-binding keys to SPX controller UI fields), and `ograf` (EBU standard: per-scene folder with `*.ograf.json` manifest + `graphic.mjs` bridge custom element wrapping the Riposte runtime). Export dir is chosen per-export via a dialog (target folder text input). **Deploy** (editor button / `deploy_set`) = export + additive `syncDir` into the CasparCG template dir — it never deletes foreign files.

## SPX Export

SPX exports are CasparCG HTML templates (same as `external` mode) with an additional `<script>` block in `<head>` that sets `window.SPXGCTemplateDefinition`. SPX's controller parses this with JSDOM to discover what update-data fields a template accepts and how to present them in its UI.

- **DataField generation**: each element with a `key` becomes a field definition. Text elements → `"textfield"`, image loaders → `"filelist"`, visibility bindKeys → `"dropdown"` with on/off items. Default values come from `previewData` (falling back to element content). Recurses into nested components (keys prefixed `parentKey.`).
- **Per-scene configurator**: the Export dialog's DataFields table (persisted in localStorage per set+scene) applies **only to the scene it was configured on** (`spxScene` in the export request); every other scene auto-detects. The dialog's key list mirrors the exporter's auto-detection (nested components + visibility keys included), so configuring is always a superset-safe edit, never a silent key drop.
- **`dataformat: "json"`**: always emitted — SPX then delivers data via the global `spxData` object (not XML). A bridge script flushes `spxData` into `riposte.update()` on `play()` and `next()`; `window.update()` (CG UPDATE from CasparCG playout) passes straight through. Field names are the data keys 1:1 — no `f0/f1` translation.
- **`out` field**: scenes with pause/outro markers → `"manual"`; fire-and-forget scenes → auto-computed duration in milliseconds.
- **`steps`**: string, count of `pause` markers + 1 (SPX shows step controls for multi-step graphics).
- **No runtime changes needed**: Riposte's `boot()` already registers `window.update()`/`play()`/`stop()`/`next()` — SPX calls these directly. No hidden divs or `spx_interface.js` bridge required.
- Code: `packages/exporter/src/spx-def.ts`; injected via `spxShell()` in `packages/exporter/src/index.ts`.

## OGraf Export

OGraf (EBU standard) exports are per-scene self-contained folders containing a manifest and a bridge `graphic.mjs` ES module.

- **Output structure**: `<name>/<name>.ograf.json` + `graphic.mjs` + `riposte.js` + `scene.json` + `assets/`.
- **Manifest**: generated from scene metadata — id (slugified name), schema (JSON Schema from data-binding keys: text content/previewData as defaults, imageLoader keys get a description, `_`-prefixed keys marked `hidden`, visibility bindKeys become `enum: ["0","1"]`), customActions (scanned from `useOnInvoke('name', …)` calls in scene/component action code), stepCount (pause markers), actionDurations (frame counts → ms), renderRequirements (canvas size + fps).
- **Bridge `graphic.mjs`**: an ES module exporting a custom `HTMLElement` that wraps the Riposte runtime via `createRuntime()`. Maps the OGraf lifecycle:
  - `load({data, renderType})` → loads `riposte.js` via `<script>`, creates content root, calls `createRuntime(scene, root, opts)`, applies initial data.
  - `playAction({goto, delta, skipAnimation})` → maps OGraf step model to Riposte pause markers. Resolves when the playhead actually parks at the target pause (`runtime.onPaused`), not on a timer. `skipAnimation: true` → `play()` + instant `goTo(pauseFrame)`. Zero-step scenes (no pauses) play the full scene and resolve on end. Backward `goto` restarts from frame 0 and steps forward. Target ≥ stepCount transitions to the end.
  - `stopAction({skipAnimation})` → `runtime.stop()`; resolves when the outro actually completes (`runtime.onEnded` — covers marker outro, preset outro, and instant-hide paths). `skipAnimation: true` → instant hide. No outro marker + parked at the last pause → `next()` plays the exit keyframes out naturally.
  - `updateAction({data})` → `runtime.update(data)` (instant DOM mutation — no animation to skip).
  - `customAction({id, payload})` → `runtime.invoke(id, payload)`.
  - `dispose()` → `runtime.destroy()`, clears DOM.
- **Runtime API additions** (used by the bridge, backward compatible with the CasparCG contract): `stop({ skipAnimation })` instant-hide option, `onPaused(cb)` / `onEnded(cb)` lifecycle listeners (fired on pause-marker parking and on every hide path: play end, marker outro, preset outro, instant stop).
- Verification: `packages/exporter/test/ograf-lifecycle.mjs` drives the full EBU lifecycle in headless Chromium (`npm run test:ograf -w @riposte/exporter -- <ograf-export-dir> <SceneName> [zero-step]`); `test/spx-template.mjs` does the same for SPX (`npm run test:spx -w @riposte/exporter -- <spx-export-dir> <TemplateName>`). Both need Playwright's browser once: `npx playwright install chromium`. Opt-in — NOT part of `npm test` (they need a prior export + a browser download).
- Code: `packages/exporter/src/ograf-export.ts`.

## Export Dialog

The Export button in the header opens a dialog (instead of exporting immediately). The dialog shows:

- **Export mode** dropdown (seeded from Set Options; changing it saves back to the set).
- **Target directory** — free-form text input, persisted in localStorage as `riposte.exportDir`. Defaults to the set's own `export/` folder when empty.
- In SPX mode, a per-scene **DataFields configurator** (see SPX Export above).
- On confirm: `POST /api/export` with `outDir` parameter → server writes to the chosen directory.
- Code: `packages/editor/src/lib/ExportDialog.svelte`.

## Design Rules (user-established — do not violate)

- **The scene IS the final design.** Bake static design into scene data; never reconstruct it via runtime scripts and call the mismatch "just scripts". The editor must show the on-air look by default. Import fidelity ≠ design fidelity.
- Data-binding keys (`_leftScore`, `_timeSwitch`, …) are a **contract with ControlCenter's mappings** — keep existing names when migrating scenes.
- Videos stay out of scenes — athlete clips are a ControlCenter/CasparCG media-layer concern.
- Asset collisions: same name + different bytes must NEVER silently overwrite (hash-suffix + report).

## Verification

- Unit tests: `npm test` (runtime interpolation/player/visibility/loop, importer convert/migrate). Player tests use a stubbed rAF clock — headless virtual time can't drive animations.
- Visual: `render_scene`/`render_filmstrip` MCP tools, or `tools/bench-shot.ps1` against the bench. Headless screenshots need `--virtual-time-budget=6000+` or you get a blank PNG; frames past the outro marker are legitimately blank — shoot at the pause frame. Nested comps render blank under headless *play* mode in both runtimes (Edge quirk) — verify those at a seeked frame or visually. Two headless gotchas are already handled — don't reintroduce them: (1) the bench skips its `/api/events` EventSource in `?frame=`/`?play=` mode, because a pending SSE request stalls `--virtual-time-budget` forever (browser never screenshots, never exits); (2) Edge relaunches itself through a compat layer, so the process you spawn exits in ~50ms while the real browser renders detached — poll for the output file (renderPng / bench-shot.ps1 do), never trust process exit.
- **The bench is not the ADD→PLAY lifecycle.** The bench seeks to a visible frame before deferred callbacks (rAF/fonts.ready) run; on air, build-time code executes at frame 0 where layers with `startFrame > 0` are `display:none` and everything measures 0 wide (this silently disabled the tabularNums digit boxing once — measure on `document.body`, never inside the element). To debug the real lifecycle, use the playout page with `?debug=<key>` — it logs the element's measured geometry per update into the backtick console.
- A/B vs Loopic: `tools/ab-diff.ps1` + `projects/_ab/` harnesses; serve both pages in fixed 1920×1080 iframes (Loopic's fitToWindow otherwise rescales and ruins diffs).

## Gotchas

- Node native TS forbids constructor parameter properties — tsconfig uses `erasableSyntaxOnly`.
- The server's `PUT /api/scene` re-serializes scene JSON pretty-printed (diffs may reformat).
- Importer names scenes after the **.loo filename**, not the internal composition name (identical comp names across files would collide otherwise).
- Component files are content-deduped on import: same name + different content → `name-<hash8>.json`.
- Loopic text box model: line-height 1.2 must always be set explicitly (CSS `normal` is font-dependent and shifts vertical alignment).
- Editor stage perf: element reads of `ed.frame` must stay tracked — a `built?.setFrame(ed.frame)`-style short-circuit kills effect dependencies and freezes the preview.
- Editor mutations that CREATE a nested array and push into it in one go (`(l.masks ??= []).push(x)`) can miss Svelte 5 reactivity — the UI updates one interaction late. REASSIGN instead (`l.masks = [...(l.masks ?? []), x]`); same for deletes (filter to a new array). Bit the mask add/delete feature once.
- Pre-2026-07-12 commit SHAs found in old notes are stale (history was rewritten to strip user data).
