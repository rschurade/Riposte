# Riposte commit log — OGraf/SPX import & export

Tracking every change for later git commits. Files listed with a short
description of what changed and why.

---

## 1. Shared types — extend export mode union

### packages/shared/src/set.ts
- Extended `ExportSettings.mode` from `'external' | 'baked'` to
  `'external' | 'baked' | 'ograf' | 'spx'`.
- Reason: two new export targets — OGraf (EBU standard manifest + graphic.mjs)
  and SPX (CasparCG HTML shell with embedded SPXGCTemplateDefinition).

---

## 2. SPX export — template definition generation

### packages/exporter/src/spx-def.ts (NEW)
- `generateSpxDef(scene, components, set)` — walks the scene's layers
  (including nested compositions) and builds a `window.SPXGCTemplateDefinition`
  JavaScript object from element data-binding keys and visibility bindKeys.
- Field types are inferred from element types: `text` → textfield,
  `imageLoader` → filelist, visibility bindKeys → dropdown or hidden.
- Default values come from `previewData`.
- `out` field: scenes with pause/outro markers → "manual",
  fire-and-forget scenes → auto-computed duration in ms.
- `steps` from pause marker count.

### packages/exporter/src/index.ts
- Added `spxShell()` variant of `externalShell()` that injects the
  `SPXGCTemplateDefinition` <script> block into <head>.
- `exportSet()` routes to SPX shell when `mode === 'spx'`.
- Exported `generateSpxDef` from the package.

---

## 3. Export dialog — target folder selection

### packages/editor/src/lib/ExportDialog.svelte (NEW)
- Dialog with target directory text input (persisted in localStorage as
  `riposte.exportDir`).
- Shows current export mode from set settings.
- "Export" button calls `POST /api/export` with `outDir`.

### packages/editor/src/App.svelte
- Import and render ExportDialog.
- Changed header "Export" button to open `ed.exportDialogOpen = true`
  instead of calling `ed.exportSet()` directly.

### packages/editor/src/lib/state.svelte.ts
- Added `exportDialogOpen` state.
- Changed `exportSet()` to accept optional `outDir` parameter.
- Added `openExportDialog()` method.

---

## 4. OGraf export — manifest + bridge graphic.mjs

### packages/exporter/src/ograf-export.ts (NEW)
- `exportOgraf(scene, set, setDir, outDir)` — generates:
  - `<name>.ograf.json` manifest with id, schema (from data-binding keys),
    stepCount, actionDurations, renderRequirements.
  - `graphic.mjs` — ES module exporting a custom HTMLElement that bridges
    OGraf lifecycle methods (load/playAction/stopAction/updateAction/
    customAction/dispose) to the Riposte runtime.
  - Copies `riposte.js`, scene.json, components, and referenced assets.
- Step model: Riposte pause markers → OGraf steps (playAction({goto:N}) →
  play to Nth pause, playAction({delta:1}) → next() to next pause).
- Schema generation: each element key → JSON Schema property with inferred
  type (string for text, etc.).
- Action durations: converted from frame counts based on scene fps.

### packages/exporter/src/index.ts
- `exportSet()` dispatches to `exportOgraf()` when `mode === 'ograf'`.

---

## 5. OGraf import

### packages/importer/src/import-ograf.ts (NEW)
- `importOgraf(ografDir, setDir)` — parses an OGraf graphic folder:
  1. Finds `*.ograf.json` manifest → extracts name, id, schema, customActions.
  2. Parses `graphic.mjs` with moderate analysis:
     - DOM creation (createElement, appendChild) → element types and hierarchy.
     - Inline styles → colors, dimensions, positions, fonts.
     - GSAP tweens → approximate Riposte keyframes.
     - innerText/textContent → default text values.
     - Image/asset loading → asset references.
  3. Builds SceneDoc with extracted elements as layers.
  4. Extracts lib/ assets → content-hash deduplication via AssetPool.
  5. Writes scene file and updates set.json.
- Reports unparseable elements as warnings.

### packages/importer/src/cli-ograf.ts (NEW)
- CLI: `riposte-import-ograf <set-dir> <ograf-dir>`.

### packages/importer/package.json
- Added `"riposte-import-ograf": "src/cli-ograf.ts"` to bins.

### packages/importer/src/index.ts
- Exported `importOgraf` and related types.

---

## 6. OGraf import dialog + server endpoint

### packages/editor/src/lib/OgrafImportDialog.svelte (NEW)
- Dialog with OGraf folder path text input.
- Set name input (existing set or new).
- "Import" button calls `POST /api/set/import-ograf`.

### packages/editor/src/lib/Sidebar.svelte
- Added "+ OGraf" button alongside "+ .loo" that opens OgrafImportDialog.

### packages/editor/src/lib/state.svelte.ts
- Added `ografImportDialogOpen` state and `importOgrafSet()` method.

### packages/editor/src/App.svelte
- Import and render OgrafImportDialog.

### packages/server/src/index.ts
- Added `POST /api/set/import-ograf` endpoint.
- Handler reads `{ root, name, ografDir }` body, calls `importOgraf(ografDir, setDir)`.
- Returns `{ scenes, warnings, assets }`.

---

## 7. Set options — export mode dropdown

### packages/editor/src/lib/SetOptions.svelte
- Added "SPX" and "OGraf" options to the export mode `<select>`.
- Mode type widened to include `'ograf' | 'spx'`.

### packages/server/src/index.ts (`apiSetSettings`)
- Expanded mode validation to accept `'ograf'` and `'spx'`.

### packages/server/src/index.ts (`apiExport`)
- Handler already passes `mode` through; no change needed except type widening.

---

## 8. MCP tools (optional follow-up)

### packages/mcp/
- `import_ograf` tool.
- `set_export_settings` updated to accept `'ograf'` and `'spx'` modes.
