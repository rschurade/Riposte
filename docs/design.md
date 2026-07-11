# Riposte — design document

Status: agreed 2026-07-11. This document records the decisions made when the
project was planned; update it as reality diverges.

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
- Actions remain as an escape hatch (composition + frame actions, code
  strings) with Loopic-compatible middleware names (`useOnPlay`,
  `useOnUpdate(key, cb)`, `useOnStop`, `useOnInvoke`) so custom code in
  imported templates ports with minimal edits.

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
