# Changelog

## 0.7.2 — 2026-08-14

### Added
- **`.set` archives** — move whole sets between machines as a single
  file. The sidebar's **open** button imports one (name collision asks:
  overwrite or import under a new name); each set's hover row gained a
  **⤓ save-as** icon that writes the archive to a folder of your choice
  (remembered for next time). The archive is a zip of the set folder —
  scenes, components, assets, fonts, presets — without the regenerable
  export/cache folders.

## 0.7.1 — 2026-08-14

### Added
- **`riposte.config.json`** — one machine-level config file next to the
  server (`packages/server/` in dev, the dist root in the packaged app),
  created on first start: HTTP port, AMCP ports, projects/examples
  folders, the CasparCG deploy directory, per-set export targets and the
  ControlCenter contract folder. Env vars (`RIPOSTE_PORT`,
  `RIPOSTE_AMCP_PORT`, …) act as one-off overrides for a single run.
  The old `.amcp-ports.json` / `.contract-config.json` dotfiles are
  migrated in and removed automatically.
- Deploy and export target directories are now remembered **server-side**
  in that config file instead of browser localStorage — they survive
  switching browsers and the dev/packaged origin split.
- **Bench button** in the editor header (next to Playout) — the preview
  bench was invisible in the packaged app unless you knew the URL.
  `/bench` now works in dev too.

## 0.7.0 — 2026-08-10

SPX and OGraf export contributed by Markus Nygård (@markusnygard).

### Added
- **SPX export mode**: external-style HTML shells with an embedded
  `SPXGCTemplateDefinition` — the SPX controller discovers a template's
  fields automatically. A per-scene **DataFields configurator** in the
  Export dialog controls field types, titles, defaults and order;
  unconfigured scenes auto-detect their keys (including nested
  components and visibility switches). Steps map to pause markers.
- **OGraf export mode** (EBU standard): one folder per scene with a
  manifest + `graphic.mjs` custom element wrapping the real Riposte
  runtime — WYSIWYG holds in OGraf hosts too. The OGraf step model maps
  to pause markers; action promises resolve when the playhead actually
  parks or the outro actually completes; `skipAnimation` is honored.
  Two **asset layouts**: `shared` (default — one deduplicated `assets/`
  folder for the whole set, WebP re-encoding applies) or `bundled`
  (spec-portable, each graphic folder self-contained).
- **Export dialog**: the Export button now opens a dialog — mode and
  target directory are **per-export overrides** that never touch the
  set's saved settings. Empty target = the classic `<set>/export`
  incremental flow; Deploy remains the route to the CasparCG template
  dir. Target dirs are remembered per set.
- Runtime contract additions: `stop({ skipAnimation })` and
  `onPaused`/`onEnded` lifecycle listeners (used by the OGraf bridge;
  fully backward compatible).
- Sidebar: **duplicate and delete sets** (projects only; duplicates
  skip regenerable export/cache folders).
- Text: **Auto size** checkbox — with textAlign anchoring the box edge
  (left/right-aligned autoSize text pins x at the aligned edge, the
  Loopic/OGraf convention); **per-corner border radius** for text and
  rectangles.
- Size binding: bind a bar to the **longest text in the scene** (`*`),
  not just a single source element.
- Loopic import: SVG elements, per-corner border radius, raw-XML
  resource content.
- Opt-in headless drivers verifying exported SPX/OGraf templates
  end-to-end in Chromium (`test:spx` / `test:ograf`).

### Fixed
- **The portable zip's server actually starts.** Every zip since 0.3.0
  shipped a `server.js` that died on launch ("Dynamic require of util is
  not supported") — the WebP encoder pulled CommonJS code into the ESM
  bundle without a `require` shim. Nobody noticed because dev machines
  run from the repo.
- Loopic import: fully transparent-yellow confusion — `rgb(255,255,0)`
  backgrounds were dropped as "transparent" on import.
- `/api/set/delete` validates the set name like every other endpoint
  (no path escapes from `projects/`).
- Naming a layer "reference" marks it as a guide layer automatically.

## 0.6.0 — 2026-07-17

### Added
- **Multi-select**: Ctrl+click adds elements to the selection; move or
  delete the whole group on stage.
- Extract a selection into a **new component or scene** (the elements are
  replaced by an instance), or move it **into an existing component** —
  the "forgot an element" workflow.
- **Scene ⇄ component conversion** buttons in the sidebar; demoting a
  component that is still embedded somewhere is refused.
- **Layer reordering** in the timeline: drag the ⋮⋮ grip, or Ctrl+arrows.
- **Marker drag** on the ruler, and a per-marker **lock** in the
  inspector so pause/outro frames can't be nudged accidentally. Locked
  markers pass clicks through — a pause stacked under a locked outro
  stays grabbable, and the playhead always wins on shared frames.
- **Keyframe copy/paste** per property row — across elements and scenes,
  at absolute frames.
- **On-stage mask handles**: move and resize a layer's mask visually
  (animated or rotated masks show as outline only).
- Grid snapping is **centered**: element anchors are centers, so the
  exact canvas center is now snappable.
- MCP server grew from 14 to **48 tools** — the full authoring surface
  (sets, scenes, layers, keyframes, masks, markers, presets, assets,
  conversions, live bench). A blank-set-to-finished-graphic build is
  possible over MCP alone.
- Inert Loopic leftovers (`this.play()` action markers) documented and
  removed from the stock sets.

### Fixed
- **Loop regions inside nested components** now cycle: a looping
  component keeps animating while its parent scene holds at a pause
  marker — the component-library pattern works.
- Timeline geometry: keyframes on indented property rows drew offset to
  the right, the frame-0 diamond was half-clipped, and the last frame
  could sit under the window edge. The track now has a left inset and
  one shared frame→pixel mapping.
- **Headless renders work again** (`render_scene`, `render_filmstrip`,
  `bench-shot.ps1`): the bench's SSE connection stalled the browser's
  virtual clock so no screenshot was ever written, and Edge's
  self-relaunch made the spawned process exit before rendering — the
  renderers now skip SSE in headless mode and wait for the file itself.

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
