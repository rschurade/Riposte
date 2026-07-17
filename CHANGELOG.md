# Changelog

## 0.5.0 — 2026-07-17

### Added
- Scene-level **outro presets**: named effects (`outros/*.json` per set)
  applied to the whole scene on STOP — or NEXT off the last pause, matching
  the controller lifecycle — replacing the marker outro. Rect masks can be
  rotated and **inverted** (the growing-diamond wipe).
- Scene-level **intro presets** (`intros/*.json`): played on ADD, from
  hidden (frame 0) to neutral, over the normal build-up.
- **Visual preset editor**: ✎/＋ next to the scene's Intro/Outro selects
  opens a panel with live preview on the stage — scrub or play the effect
  on the real scene while editing keyframes, easing and the mask.
- **Stock preset collection** ships with the app: new sets start with it,
  and Set Options' "+ stock presets" copies missing ones into existing
  sets (never overwrites).
- Fill color picker + corner radius for rectangles/ellipses; every color
  swatch in the inspector now opens a native picker.
- **Resize handles** on the selected element: edges snap to the grid
  (Alt bypasses), Shift on a corner keeps the aspect ratio.
- Sidebar: single click selects a set, double click opens Set Options.
- The runtime reports its real product version (was hardcoded 0.1.0).

### Fixed
- Editor could freeze in dev after many hot-reloads (a connection leak
  exhausted the browser's per-origin pool); proxied API sockets also
  close properly on upstream errors now.
- Intro/outro effects run on a wall clock with a completion guard — they
  finish even when the playout window is hidden or covered (browsers
  freeze animation frames there); the playout tab warns with "⏸ HIDDEN".
- Guide layers are excluded from scene-level effects and keep their
  paint order.

## 0.4.0 — 2026-07-16

### Added
- Components can be dragged from the sidebar onto the stage to embed them
  as nested compositions.
- Asset preview pane in the sidebar: hover an asset to see it (images,
  sequences preview their final frame, live font samples).
- Per-file dirty tracking: unsaved scenes are marked in the sidebar and
  auto-saved before export/deploy; discard prompts list every scene at risk.
- Deploy dialog with a "force full redeploy" option (copy every file,
  not just changed ones).
- Image-sequence layers are labeled with their sequence name; the
  inspector shows the frame range.
- Scene list eye filter: hide scenes from the list (view-only, per set);
  header eye toggles show all / show visible.
- Asset sort toggle: sequences by frame count, for spotting duplicates.
- MCP: live bench control (`bench_open`, `bench_update`,
  `bench_transport`); `list_scenes` reports content keys and switches.
- `dev.cmd` — one-click dev session (server + editor + browser).

### Fixed
- Scene switches could silently park unsaved edits in memory — they looked
  saved but never reached disk (and could deploy a stale template).
- SSE reconnects crashed the editor's event stream (custom event collided
  with EventSource's native `open`).
- Sequence asset rows wasted half their width; folding now also works by
  clicking the name.
- `dev.cmd` port checks false-positived on cold start and skipped both
  servers.

## 0.3.0 — 2026-07-13

### Added
- WebP export: per-set opt-in re-encoding of PNGs at export time, with an
  on-disk cache and lossy/lossless race per image (real-world set:
  213 MB → 27 MB). The set on disk stays PNG.
- Set Options dialog (clicking a set opens it — export mode, WebP, dirs).
- Image loaders accept design-time placeholders: drop an asset onto the
  loader on stage, or pick via autocomplete in the inspector.
- Masks: add (fitted to the element) and delete from the inspector;
  rounded corners, uniform or per-corner radius.
- Bench form shows only real input keys and auto-widens its label column.

### Fixed
- Text squeeze and size-bind measured 0 on `display:none` layers — probes
  now measure on `document.body`.

## 0.2.0 — 2026-07-13

### Added
- Tabular numerals for text: fixed-advance digits so clocks and scores
  stop jittering — with a digit-boxing fallback for fonts without `tnum`.
- Dynamic size binding: a rectangle's width/height follows a text layer's
  measured content plus padding, re-measured on every update.
- Ruler guides (lockable, layers snap to them) and per-layer locking.
- Playout `?debug=<key>` probe: logs element geometry on every update.
- Mapping-contract check on export/deploy: flags template keys no
  controller mapping fills, and mappings pointing at removed keys.

### Fixed
- Digit-width probe measured hidden layers as zero width.

## 0.1.0 — 2026-07-12

First portable release (`npm run dist` → zip, needs only Node.js LTS).

- Rendering runtime: zero-dependency engine driving scene JSON via
  DOM+CSS, implementing the CasparCG template contract
  (`update`/`play`/`next`/`stop`/`invoke`), fonts, image sequences,
  nested compositions, per-layer loop regions with exit fades.
- Editor: stage with drag/snap/grid, timeline with keyframes and easing,
  property rows, markers (pause/outro/loop/action), full inspector,
  visibility bindings, scene/set/asset management, resizable panels,
  CG cycle simulation.
- Import: Loopic `.loo` projects and HTML exports, with a shared
  content-deduplicated asset pool.
- Export: incremental CasparCG templates — external shared-assets mode or
  baked single-file; Deploy sync into a template directory.
- Virtual CasparCG: AMCP listeners + playout page, so a controller can
  rehearse against Riposte without a broadcast rig.
- MCP server: scene CRUD, element edits, asset import, headless renders,
  filmstrips, live editor sync.
- Duration trimming to content (editor button + batch tool).
