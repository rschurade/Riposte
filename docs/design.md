# Riposte — design document

Status: agreed 2026-07-11; as-built notes updated 2026-07-12. This document
records the decisions made when the project was planned, plus how reality
diverged. For day-to-day operational guidance (commands, ports, gotchas,
format essentials) see the repo-root `CLAUDE.md`.

## As-built status (2026-07-12)

All four phases below are DONE, in roughly the planned shape. The full
`.loo` FIE_2026 set (32 scenes) round-trips: import → edit → export →
verified on a real CasparCG server (external-asset templates load visibly
faster than Loopic's baked ones). Shipped beyond the original plan:

- **Visibility bindings** (`element.visibility`) replaced Loopic show/hide
  scripts entirely; `riposte-migrate` converts old scripts by probe-executing
  them against recording stubs. Almost all imported action code is now gone.
- **Nested compositions** render recursively (components in `set.json`,
  content-deduped files, seekable child playheads — works on seek, which
  Loopic's own runtime can't do).
- **Per-layer loop regions** (`layer.loop {start, end, exitFade}`): cycle on a
  hold clock while the scene pauses, fade in place with the outro. Top-level
  layers only so far.
- **MCP server** (`packages/mcp`, 11 tools) over the HTTP API, including
  live-editor sync via SSE (`open_scene` navigates the running editor) and
  headless renders (`render_scene` / `render_filmstrip`).
- **Deploy** flow: export + additive directory sync into the CasparCG
  template dir (never deletes foreign files).
- **HTML-export fallback importer** (`riposte-import-html`) for templates
  whose `.loo` source doesn't exist (used for the hand-converted Schedule).
- Duration trimming (`trimToContent` + `tools/trim-durations.mjs`) — FIE
  scenes cut from 250 frames to their real 42–87.

- **Distribution mode** (2026-07-12): `npm run dist` builds a portable zip —
  esbuild-bundled `server.js` (kills the Node-24 and npm-install requirements;
  any Node LTS runs it), built editor served at `/` (bench at `/bench`),
  start scripts, demo set, empty `projects/`. Packaged layout auto-detected;
  dev repo behavior unchanged. `RIPOSTE_PROJECTS_DIR` overrides the set root
  (needed later for an installer putting sets in a user-writable location).

Planned but NOT built yet: near-duplicate asset report (pixel-level);
a real Windows installer (Inno Setup wrapping the portable dist + a bundled
node.exe — build when there's an actual non-developer user); loops inside
nested compositions; on-demand sub-animation "play bindings". Still
outstanding: full on-air soak of the migrated set (Tableau, Schedule, whites,
Team-v2 plates).

## Roadmap candidates (agreed 2026-07-12)

Ideas that exist because we own both sides of the wire (Riposte makes the
templates; ControlCenter drives them), ranked:

1. **Virtual CasparCG** (SHIPPED 2026-07-12, verified live against
   ControlCenter) — the Riposte server listens on AMCP
   TCP ports (main 6250 / preview 6251, `RIPOSTE_AMCP_PORT` /
   `RIPOSTE_AMCP_PREVIEW_PORT`; NOT 5250/5251 — real Caspar instances often
   run on the same machine) and speaks just enough AMCP
   (`CG ADD/UPDATE/PLAY/NEXT/STOP/REMOVE/INVOKE`, OK/error replies) to let
   ControlCenter connect to it as if it were a real CasparCG server. Commands
   are routed via SSE to a `/playout` browser page that stacks CG layers and
   drives them with the real runtime. Rehearse the full stack — real buttons,
   real mappings, real Cyrano data — on any laptop, no broadcast rig; at the
   venue it doubles as a wire-tap for debugging what a graphic actually
   receives. Media-layer commands (PLAY/MIXER/CLEAR for portrait videos) are
   acknowledged and shown as chips, not rendered — agreed cut, don't build
   video playout unless it's asked for. Absolute flag/logo paths in update
   data are rewritten to the server's /api/mediafile endpoint.
2. **Set snapshot + visual regression** — render every scene at its hold frame
   (with `previewData`) into a stored baseline; after edits, re-render and
   pixel-diff the whole set, flagging changed scenes (catches "touched a
   shared component, silently broke three graphics"). Bonus: contact-sheet
   gallery of the set for design review.
3. **Mapping-contract audit** — cross-reference a ControlCenter
   `graphics_sets/*.json` against the set's binding keys: template keys no
   mapping fills, and mappings pointing at keys that no longer exist. The
   on-air symptom of a contract break is a silently blank field.
4. **Operator sheet** — auto-generated per-scene documentation: data keys with
   preview values, markers (what PLAY/NEXT does at each stop), loops, fonts.
   For handing a set to another operator; possibly importable by a future
   ControlCenter mapping editor.

## Roadmap additions from the DJ HTML Creator survey (2026-07-12)

Surveyed djhtmlcreator.com (another Loopic alternative; €300/y, Windows
desktop, single-file exports — their delivery model is what we left behind,
but several feature ideas fit us). Adopted, in order:

- **Small-wins batch (SHIPPED 2026-07-12, bench-verified; demo scene
  examples/demo/BoundBar):** tabular numerals toggle on
  text (fixed-advance digits — score/clock fields stop jittering on update);
  dynamic size binding (rectangle width/height follows a text layer's
  measured content + padding on every update — the "bar always fits the
  name" problem Loopic never solved); ruler guides (lockable, design-time
  only) + layer lock in the editor.
- **WebP re-encoding on export — SHIPPED 2026-07-13.** Per-set opt-in
  (`set.json` export.imageFormat, edited via the new Set Options dialog —
  sidebar set click opens it). jsquash/libwebp WASM (no native deps, packaged
  dist ships the wasm), content-hash cache per set, lossy+lossless race per
  image. Measured on FIE_2026 at q92: 213 MB PNG → 26.9 MB WebP (12.6%),
  974 images, zero warnings, exported template render-verified.
- **Alpha matte** — any layer's alpha (soft edges included) masks another
  layer; editor-visible, CSS mask-image based. Build when a design pulls
  it in.
- **Two-part text + dynamic anchoring** (pin right edge / follow another
  text's end, runtime-corrected from measured width) — the most
  sophisticated thing they have; only when a concrete graphic demands it.
- **Transition/animation presets** (generate keyframes, pure editor sugar);
  **layered PSD import** (ag-psd) — designer-workflow shortcut.

Explicitly rejected: video loaders (clips stay on the Caspar media layer —
locked decision), Lottie/OGraf/SPX/vMix export targets (CasparCG-only;
revisit OGraf only if Riposte goes public), crawl/roll ticker layers (no
fencing use case yet), 3D rotate/perspective (Caspar MIXER covers it).

## Why

Loopic (loopic.io) is a capable web-based editor for CasparCG HTML templates,
but its model has structural problems for production use:

- Every export is a single HTML file with **all assets base64-embedded**
  (8–23 MB per template). Scenes in one graphics package duplicate the same
  backgrounds and fonts in every file; rebranding means re-exporting
  everything.
- Project files are opaque single files with embedded assets — not diffable,
  not shareable, not versionable.
- Stop points and loops are code snippets (`this.pause()` in frame actions),
  not first-class timeline objects.
- Undo/redo, copy/paste, custom easing, >60 frames are paywalled; the app is
  web-only and needs internet to launch.

We know the domain well: we hand-edited Loopic exports for the FIE 2026
family and documented the full file anatomy and CasparCG contract
(see TV-Grafik repo, `docs/caspar-template-editing.md`).

## Architecture principle

**The runtime is the product; the editor is a client of it.**

One small zero-dependency engine (`@riposte/runtime`, built to a single
`riposte.js` IIFE) loads a scene document and renders it via DOM+CSS —
exactly what CasparCG's CEF renders. The editor's preview canvas runs that
same engine, so WYSIWYG holds by construction.

## Set-centric project model

A project is a **set** (a graphics package), not a single scene:

```
FIE_2026/                       ← project folder (git-friendly)
  set.json                        set metadata, scene list, export settings
  scenes/
    Schedule.json                 one scene per file — small, diffable
    MedalCounts.json
  assets/                         ← ONE shared pool for the whole set
    frame.png  bar.png  fonts/  flourishes/
```

Export mirrors the layout — HTML shells plus one shared assets folder,
relative references only, so the exported folder is location-independent
under the CasparCG template root:

```
casparcg/templates/FIE_2026/
  Schedule.html   MedalCounts.html
  assets/
```

Consequences:

- Rebranding = swapping files in one folder (`frame.png`, `bar.png` are the
  known rebranding surfaces).
- Assets are content-hash deduplicated on import and on add. **Identity is
  the content hash; the filename is only a human label.** Dedup policy:
  - same name + same bytes → stored once;
  - different name + same bytes → still deduplicated, references rewritten
    to the canonical file;
  - same name + different bytes → NEVER silently overwritten — the newcomer
    is stored under a hash-suffixed name and the collision is reported.
  - Additionally a **near-duplicate report** (pixel/perceptual comparison)
    flags byte-different but visually identical assets for manual merging;
    it never auto-merges.
- The editor's Resources panel is set-scoped with per-asset "used by" tracking.
- Optional **preload manifest**: the runtime can fetch all set assets at
  template load (before first play) to prevent asset-load flash on the first
  ADD after a server restart.

## Scene format

JSON, versioned (`formatVersion`), deliberately close to Loopic's object model
so the importer is near-mechanical:

- `Composition { width, height, fps, duration, markers[], layers[] }`
- `Layer { startFrame, duration, masks[], element }`
- Elements: text (auto-squeeze), image, image sequence, image loader
  (fit modes), rectangle, ellipse, path, nested composition. The type set is
  open — a future `video` element must not require a format-version bump.
- Style properties: `{ value, unit, keyframes[{ frame, value, easing }] }`
  with cubic-bezier easing toward the next keyframe. When keyframes exist the
  static value is ignored (Loopic semantics, kept for import fidelity).
- x/y are the element box **center** (Loopic convention, kept).
- **First-class markers**: `pause`, `outro`, `loop` are timeline objects, not
  code snippets. `next` semantics become explicit and testable.
- **Visibility bindings**: `element.visibility = { bindKey, showWhen?/hideWhen?,
  initial? }` shows/hides an element from an `update()` value (default:
  hidden when the value is `"0"` — the `_xSwitch` convention). This replaces
  the Loopic-era show/hide middleware scripts entirely; the importer's
  `migrate-scripts` pass (also available as `riposte-migrate <set-dir>`)
  converts those scripts to bindings by probe-executing them against
  recording stubs. Bindings drive CSS `visibility`, so they compose with the
  layer's timeline span (display) and keyframed opacity fades — a lamp that
  is "on" still fades in with the build-up and out with the outro.
- Actions remain as an escape hatch (composition + frame actions, code
  strings) for genuinely dynamic behavior only. Canonical scope: bare
  `useOnPlay`, `useOnUpdate(key, cb)`, `useOnStop`, `useOnNext`,
  `useOnInvoke`, `find(key)` (element handle: `setContent`, `show`/`hide`/
  `setVisible`, `node`), `riposte` (the runtime), `this` = composition.
  `loopic` and `runtime` remain as deprecated aliases so unmigrated imports
  run as-is.

## CasparCG contract

The exported template exposes `update(data)`, `play()`, `stop()`, `next()`
and supports AMCP INVOKE. Non-negotiable: `update` accepts **both** JSON and
the classic `<templateData><componentData id=…>` XML (ControlCenter sends
XML). Default behaviors: play from frame 0, pause at `pause` markers, `next`
resumes past the current pause, `stop` plays from the `outro` marker to the
end. `isVisible` is false before play and after the end.

## Decisions

| Topic | Decision |
|---|---|
| App shell | Local Node server + browser UI (no Electron) |
| Language | TypeScript everywhere |
| Editor UI | Svelte (+ Vite) |
| Runtime | Zero-dependency vanilla TS → single IIFE |
| Export targets | CasparCG only (external-assets default, baked single-file fallback); GDD/SPX/OGraf deferred |
| Importer | Early (phase 2) — stub the Composition/Layer classes, sandbox-eval the export's composition block, extract base64 assets to files |
| Verification | A/B pixel-diff: same template rendered by Loopic's own runtime vs ours at the same held frame (headless Edge rig from TV-Grafik) |
| Lottie | Skipped unless the importer proves the FIE templates actually invoke the bundled lottie-web (flourishes are PNG sequences) |
| Videos in scenes | No — clips stay a playout/media-layer concern (ControlCenter PLAY/MIXER) |
| Undo/redo, copy/paste | Designed in from day one (command pattern) |
| Audience | Internal-first, built distributable-quality |

## Phases

1. **Runtime + preview bench** (~2 d) — keyframe interpolation, bezier easing,
   masks, text auto-squeeze, image-loader fit modes, markers, middleware
   pipelines. Bench page with Play/Next/Stop/Update controls and a data form.
   *Acceptance: a hand-written Schedule scene plays intro → pause → outro and
   updates via templateData XML under the headless rig.*
2. **Loopic importer** (~2 d) — FIE Schedule + Medal Counts import into one
   set project and render pixel-close in the A/B rig. Phases 1+2 together
   are the first big milestone: a set of Loopic exports deflated into
   scene JSONs + ONE shared, content-deduplicated assets folder, and
   exported back to working CasparCG templates. Asset filenames from the
   source (if recoverable at all — Loopic embeds anonymous data-URIs) are
   labels only; the content hash decides identity.
3. **Editor MVP** (~4–5 d) — canvas (select/move/resize/snap/zoom), inspector
   with keyframe diamonds, frame timeline (layer rows, draggable keyframes,
   easing presets, markers), Text/Image/ImageLoader/Rectangle tools, project
   open/save via server, both export variants, J/K/L playback, undo/redo,
   copy/paste.
4. **Round-out** (~2–3 d) — mask editing, nested compositions, image
   sequences, ellipse/pen tools, easing curve editor, font import.

Each checkpoint is independently useful: the bench alone improves the current
hand-editing workflow; the importer makes existing templates editable before
the editor exists.
