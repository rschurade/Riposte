<script lang="ts">
  import { untrack } from 'svelte';
  import { buildScene, type BuiltScene } from '@riposte/runtime';
  import type { Layer } from '@riposte/shared';
  import { ed, propNumber, shiftProperty } from './state.svelte.ts';

  let wrapEl: HTMLDivElement;
  let stageEl: HTMLDivElement;
  let built: BuiltScene | null = null;
  let scale = $state(1);
  let wrapSize = $state({ w: 0, h: 0 });

  const comp = $derived(ed.scene?.composition ?? null);

  // ---- fonts ---------------------------------------------------------------
  const injected = new Set<string>();
  $effect(() => {
    const ref = ed.setRef;
    if (!ref) return;
    for (const f of ref.fonts ?? []) {
      if (injected.has(f.family)) continue;
      injected.add(f.family);
      const face = new FontFace(f.family, `url("${ed.assetBase}${f.file}")`);
      face.load().then((ff) => document.fonts.add(ff)).catch(() => {});
    }
  });

  // ---- build / rebuild on scene version ------------------------------------
  $effect(() => {
    void ed.version;
    const scene = ed.scene;
    built?.destroy();
    built = null;
    if (!scene || !stageEl) return;
    built = buildScene(scene, stageEl, {
      assetBase: ed.assetBase,
      showGuides: true,
      components: ed.allScenes,
    });
    built.show();
    // untracked: the playhead must NOT be a dependency — a tracked read here
    // rebuilt the whole scene on every frame change (and reset loop state).
    built.setFrame(untrack(() => ed.frame));
  });

  $effect(() => {
    // read the frame UNCONDITIONALLY: `built?.setFrame(ed.frame)` would skip
    // the read while built is null (first run) and never track the dependency
    const f = ed.frame;
    built?.setFrame(f);
  });

  // ---- playback (editor free-run: markers are visualized, not obeyed) ------
  $effect(() => {
    if (!ed.playing || !comp) return;
    ed.cgOff();
    let raf = 0;
    let last = 0;
    let pos = ed.frame;
    const tick = (ts: number) => {
      if (!ed.playing) return;
      if (last === 0) last = ts;
      pos += ((ts - last) / 1000) * comp.fps;
      last = ts;
      if (pos >= comp.duration - 1) {
        pos = comp.duration - 1;
        ed.playing = false;
      }
      ed.frame = Math.floor(pos);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  // ---- CasparCG lifecycle simulation (CG ▶ / ⏭ / ⏹ in the transport) --------
  // Mirrors the on-air runtime: PLAY parks at pause markers while loop layers
  // keep cycling (hold clock), NEXT resumes — off the last pause it latches
  // the loop exit fade — STOP jumps to the outro marker.
  let cgPos = 0;
  let cgRunning = false;
  let cgHandledReq = 0;

  $effect(() => {
    const { active, req, reqType } = ed.cg;
    if (!active || !comp || !built) return;
    const ts = built.timeState;
    const pauses = comp.markers.filter((m) => m.type === 'pause').map((m) => m.frame).sort((a, b) => a - b);
    const lastPause = pauses.length > 0 ? pauses[pauses.length - 1]! : -1;
    const outro = comp.markers.find((m) => m.type === 'outro');

    if (req !== cgHandledReq) {
      cgHandledReq = req;
      if (reqType === 'play') {
        cgPos = 0;
        ts.hold = 0;
        ts.exiting = false;
        cgRunning = true;
      } else if (reqType === 'next' && !cgRunning) {
        if (!ts.exiting && lastPause >= 0 && Math.floor(cgPos) >= lastPause) {
          ts.exiting = true;
          ts.exitFrom = Math.floor(cgPos);
        }
        cgPos = Math.floor(cgPos) + 0.001;
        cgRunning = true;
      } else if (reqType === 'stop') {
        const from = outro ? outro.frame : Math.floor(cgPos);
        if (!ts.exiting) {
          ts.exiting = true;
          ts.exitFrom = from;
        }
        cgPos = from + 0.001;
        cgRunning = true;
      }
      ed.cg.held = !cgRunning;
    }

    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      if (!ed.cg.active) return;
      if (last === 0) last = t;
      const dt = Math.min((t - last) / 1000, 0.25);
      last = t;
      if (cgRunning) {
        const prev = cgPos;
        cgPos += dt * comp.fps;
        for (let f = Math.floor(prev) + 1; f <= Math.floor(cgPos); f++) {
          if (pauses.includes(f)) {
            cgPos = f;
            cgRunning = false;
            ed.cg.held = true;
            break;
          }
        }
        if (cgPos >= comp.duration - 1) {
          cgPos = comp.duration - 1;
          cgRunning = false;
        }
        ed.frame = Math.floor(cgPos);
      } else if (ed.cg.held) {
        // parked on a pause: loop layers keep cycling. Read timeState off the
        // CURRENT build — a rebuild (undo, edit) swaps the object.
        const cur = built?.timeState;
        if (cur) {
          cur.hold += dt * comp.fps;
          built!.setFrame(Math.floor(cgPos));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  // ---- fit to view ----------------------------------------------------------
  $effect(() => {
    if (!wrapEl) return;
    const ro = new ResizeObserver(() => {
      wrapSize = { w: wrapEl.clientWidth, h: wrapEl.clientHeight };
    });
    ro.observe(wrapEl);
    return () => ro.disconnect();
  });

  $effect(() => {
    if (!comp || wrapSize.w === 0) return;
    scale = Math.min(wrapSize.w / comp.width, wrapSize.h / comp.height) * 0.96;
  });

  const offset = $derived(
    comp
      ? { x: (wrapSize.w - comp.width * scale) / 2, y: (wrapSize.h - comp.height * scale) / 2 }
      : { x: 0, y: 0 },
  );

  // ---- geometry / hit testing ----------------------------------------------
  function layerRect(layer: Layer): { x: number; y: number; w: number; h: number } {
    const s = layer.element.style;
    const f = ed.frame;
    const w = propNumber(s.width, f, 100);
    const h = propNumber(s.height, f, 40);
    return { x: propNumber(s.x, f, 0) - w / 2, y: propNumber(s.y, f, 0) - h / 2, w, h };
  }

  function visibleAtFrame(layer: Layer): boolean {
    if (layer.hidden) return false;
    return ed.frame >= layer.startFrame && ed.frame < layer.startFrame + layer.duration;
  }

  function hitTest(cx: number, cy: number): Layer | null {
    if (!comp) return null;
    for (let i = comp.layers.length - 1; i >= 0; i--) {
      const layer = comp.layers[i]!;
      if (layer.locked) continue;
      if (!visibleAtFrame(layer)) continue;
      const r = layerRect(layer);
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) return layer;
    }
    return null;
  }

  // Selection highlight: measure the ACTUAL DOM box of the built element —
  // accurate for auto-sized text, scaled/rotated elements and nested comps.
  // Falls back to style-derived geometry when the node doesn't render
  // (outside its layer span → dashed "ghost" outline).
  let selectionRect = $state<{ x: number; y: number; w: number; h: number } | null>(null);
  let selectionGhost = $state(false);

  $effect(() => {
    void ed.version;
    void ed.frame;
    void scale;
    void wrapSize;
    const layer = ed.selectedLayer;
    if (!layer || !comp) {
      selectionRect = null;
      return;
    }
    selectionGhost = !visibleAtFrame(layer);
    const handle = built?.byId.get(layer.element.id);
    const stageR = stageEl?.getBoundingClientRect();
    if (handle && stageR && scale > 0) {
      const r = handle.node.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        selectionRect = {
          x: (r.left - stageR.left) / scale,
          y: (r.top - stageR.top) / scale,
          w: r.width / scale,
          h: r.height / scale,
        };
        return;
      }
    }
    selectionRect = layerRect(layer);
  });

  // ---- grid / snap ------------------------------------------------------------
  const gridStored = JSON.parse(localStorage.getItem('riposte.grid') ?? '{}');
  let gridOn = $state(gridStored.on ?? true);
  let gridSize = $state(gridStored.size ?? 50);
  let snapOn = $state(gridStored.snap ?? true);
  $effect(() => {
    localStorage.setItem('riposte.grid', JSON.stringify({ on: gridOn, size: gridSize, snap: snapOn }));
  });
  const gridStep = $derived(Math.max(2, Number(gridSize) || 50) * scale);

  // ---- ruler guides (design-time only, stored in the scene doc) ----------------
  const guides = $derived(ed.scene?.guides ?? null);
  let guideDrag = $state<{ axis: 'v' | 'h'; index: number; pos: number } | null>(null);

  function guidePos(axis: 'v' | 'h', index: number, authored: number): number {
    return guideDrag?.axis === axis && guideDrag.index === index ? guideDrag.pos : authored;
  }

  function addGuide(axis: 'v' | 'h'): void {
    if (!comp) return;
    const pos = Math.round(axis === 'v' ? comp.width / 2 : comp.height / 2);
    ed.mutate('add guide', (scene) => {
      const g = (scene.guides ??= { v: [], h: [] });
      (axis === 'v' ? g.v : g.h).push(pos);
    });
  }

  function guidePointerDown(ev: PointerEvent, axis: 'v' | 'h', index: number): void {
    if (!guides || guides.locked) return;
    ev.stopPropagation();
    guideDrag = { axis, index, pos: (axis === 'v' ? guides.v : guides.h)[index] ?? 0 };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }

  function guidePointerMove(ev: PointerEvent): void {
    if (!guideDrag) return;
    const p = toComp(ev);
    guideDrag.pos = Math.round(guideDrag.axis === 'v' ? p.x : p.y);
  }

  function guidePointerUp(): void {
    if (!guideDrag) return;
    const { axis, index, pos } = guideDrag;
    guideDrag = null;
    ed.mutate('move guide', (scene) => {
      const arr = axis === 'v' ? scene.guides?.v : scene.guides?.h;
      if (arr && index < arr.length) arr[index] = pos;
    });
  }

  function removeGuide(axis: 'v' | 'h', index: number): void {
    ed.mutate('remove guide', (scene) => {
      const g = scene.guides;
      if (!g) return;
      (axis === 'v' ? g.v : g.h).splice(index, 1);
      if (g.v.length === 0 && g.h.length === 0) delete scene.guides;
    });
  }

  function toggleGuideLock(): void {
    ed.mutate('toggle guide lock', (scene) => {
      const g = scene.guides;
      if (g) g.locked = g.locked ? undefined : true;
    });
  }

  // ---- pointer interaction ---------------------------------------------------
  let drag: {
    id: string;
    startX: number;
    startY: number;
    startElX: number;
    startElY: number;
    // Shift axis lock, latched at the first clear movement of the drag so it
    // cannot flip when the cursor passes back near its start point.
    axis: 'x' | 'y' | null;
    applied: { dx: number; dy: number };
  } | null = null;

  function toComp(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = wrapEl.getBoundingClientRect();
    return { x: (ev.clientX - r.left - offset.x) / scale, y: (ev.clientY - r.top - offset.y) / scale };
  }

  // ---- asset drop → new layer at the drop position ---------------------------
  function onDragOver(ev: DragEvent): void {
    const types = ev.dataTransfer?.types ?? [];
    if (types.includes('text/riposte-asset') || types.includes('text/riposte-sequence')) {
      ev.preventDefault();
      ev.dataTransfer!.dropEffect = 'copy';
    }
  }

  function onDrop(ev: DragEvent): void {
    if (!comp) return;
    const p = toComp(ev);
    const at = {
      x: Math.min(Math.max(p.x, 0), comp.width),
      y: Math.min(Math.max(p.y, 0), comp.height),
    };
    if (snapOn) {
      const g = Math.max(2, Number(gridSize) || 50);
      at.x = Math.round(at.x / g) * g;
      at.y = Math.round(at.y / g) * g;
    }
    const seq = ev.dataTransfer?.getData('text/riposte-sequence');
    if (seq) {
      ev.preventDefault();
      ed.addSequenceLayer(JSON.parse(seq) as string[], at);
      return;
    }
    const file = ev.dataTransfer?.getData('text/riposte-asset');
    if (!file) return;
    ev.preventDefault();
    ed.addImageLayer(file, at);
  }

  function onPointerDown(ev: PointerEvent): void {
    if (!comp) return;
    const p = toComp(ev);
    const hit = hitTest(p.x, p.y);
    ed.selectLayer(hit?.id ?? null);
    if (hit) {
      drag = {
        id: hit.id,
        startX: p.x,
        startY: p.y,
        startElX: propNumber(hit.element.style.x, ed.frame, 0),
        startElY: propNumber(hit.element.style.y, ed.frame, 0),
        axis: null,
        applied: { dx: 0, dy: 0 },
      };
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    }
  }

  function onPointerMove(ev: PointerEvent): void {
    if (!drag || !ed.scene) return;
    const p = toComp(ev);
    const layer = ed.scene.composition.layers.find((l) => l.id === drag!.id);
    if (!layer) return;
    let dx = Math.round(p.x - drag.startX);
    let dy = Math.round(p.y - drag.startY);
    if (ev.shiftKey) {
      if (drag.axis === null && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        drag.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      }
      if (drag.axis === 'x') dy = 0;
      else if (drag.axis === 'y') dx = 0;
      else { dx = 0; dy = 0; } // not latched yet: hold still
    } else {
      drag.axis = null; // releasing Shift unlocks; pressing again re-latches
    }
    // Snap the element's anchor (x/y = box center) to the grid; Alt bypasses.
    if (snapOn && !ev.altKey) {
      const g = Math.max(2, Number(gridSize) || 50);
      if (dx !== 0) dx = Math.round((drag.startElX + dx) / g) * g - drag.startElX;
      if (dy !== 0) dy = Math.round((drag.startElY + dy) / g) * g - drag.startElY;
    }
    // Guides snap the anchor too (after grid — a guide wins nearby); Alt bypasses.
    if (!ev.altKey && guides) {
      const t = 6 / scale;
      const nx = drag.startElX + dx;
      const ny = drag.startElY + dy;
      for (const gx of guides.v) {
        if (Math.abs(nx - gx) <= t) {
          dx = gx - drag.startElX;
          break;
        }
      }
      for (const gy of guides.h) {
        if (Math.abs(ny - gy) <= t) {
          dy = gy - drag.startElY;
          break;
        }
      }
    }
    // live feedback: nudge the built DOM node directly; doc mutated on drop
    const handle = built?.byId.get(layer.element.id);
    if (handle) {
      handle.node.style.marginLeft = `${dx}px`;
      handle.node.style.marginTop = `${dy}px`;
    }
    drag.applied = { dx, dy };
  }

  function onPointerUp(): void {
    if (!drag) return;
    const { id, applied } = drag;
    drag = null;
    if (applied.dx === 0 && applied.dy === 0) return;
    ed.mutate('move element', (scene) => {
      const layer = scene.composition.layers.find((l) => l.id === id);
      if (!layer) return;
      shiftProperty(layer.element.style.x, applied.dx);
      shiftProperty(layer.element.style.y, applied.dy);
      for (const mask of layer.masks ?? []) {
        shiftProperty(mask.style.x, applied.dx);
        shiftProperty(mask.style.y, applied.dy);
      }
    });
  }
</script>

<div
  class="wrap"
  bind:this={wrapEl}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  ondragover={onDragOver}
  ondrop={onDrop}
>
  {#if comp}
    <div
      class="board"
      style="left:{offset.x}px;top:{offset.y}px;width:{comp.width * scale}px;height:{comp.height * scale}px"
    >
      <div class="stage" bind:this={stageEl} style="transform:scale({scale});width:{comp.width}px;height:{comp.height}px"></div>
      {#if gridOn && gridStep >= 4}
        <div class="grid" style="background-size:{gridStep}px {gridStep}px"></div>
      {/if}
      {#each guides?.v ?? [] as gx, i (`v${i}`)}
        <div
          class="guide v"
          class:lockedguide={guides?.locked}
          style="left:{guidePos('v', i, gx) * scale}px"
          title="guide x={guidePos('v', i, gx)}{guides?.locked ? ' (locked)' : ' — drag to move, double-click to remove'}"
          onpointerdown={(e) => guidePointerDown(e, 'v', i)}
          onpointermove={guidePointerMove}
          onpointerup={guidePointerUp}
          ondblclick={() => !guides?.locked && removeGuide('v', i)}
        ></div>
      {/each}
      {#each guides?.h ?? [] as gy, i (`h${i}`)}
        <div
          class="guide h"
          class:lockedguide={guides?.locked}
          style="top:{guidePos('h', i, gy) * scale}px"
          title="guide y={guidePos('h', i, gy)}{guides?.locked ? ' (locked)' : ' — drag to move, double-click to remove'}"
          onpointerdown={(e) => guidePointerDown(e, 'h', i)}
          onpointermove={guidePointerMove}
          onpointerup={guidePointerUp}
          ondblclick={() => !guides?.locked && removeGuide('h', i)}
        ></div>
      {/each}
      {#if selectionRect}
        <div
          class="selection"
          class:ghost={selectionGhost}
          style="left:{selectionRect.x * scale}px;top:{selectionRect.y * scale}px;width:{selectionRect.w * scale}px;height:{selectionRect.h * scale}px"
        ></div>
      {/if}
    </div>
    <div class="gridbar" onpointerdown={(e) => e.stopPropagation()}>
      <label><input type="checkbox" bind:checked={gridOn} /> grid</label>
      <input class="size" type="number" min="2" step="1" bind:value={gridSize} title="grid size (px)" />
      <label title="snap dragged elements to the grid (hold Alt to bypass)">
        <input type="checkbox" bind:checked={snapOn} /> snap
      </label>
      <button class="gbtn" title="Add a vertical guide (dragged elements snap to it)" onclick={() => addGuide('v')}>+V</button>
      <button class="gbtn" title="Add a horizontal guide" onclick={() => addGuide('h')}>+H</button>
      {#if guides}
        <label title="Locked guides can't be moved or removed">
          <input type="checkbox" checked={guides.locked ?? false} onchange={toggleGuideLock} /> 🔒
        </label>
      {/if}
    </div>
  {:else}
    <p class="empty">Select a set and a scene</p>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
    overflow: hidden;
    background:
      repeating-conic-gradient(#1c1f26 0% 25%, #202329 0% 50%) 0 0 / 22px 22px;
    min-height: 0;
    user-select: none;
  }
  .board { position: absolute; outline: 1px solid #3a3e48; }
  .stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  .grid {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image:
      linear-gradient(to right, rgba(148, 158, 170, 0.22) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(148, 158, 170, 0.22) 1px, transparent 1px);
  }
  .gridbar {
    position: absolute;
    top: 6px;
    right: 8px;
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 3px 8px;
    background: rgba(24, 26, 32, 0.85);
    border: 1px solid #3a3e48;
    border-radius: 4px;
    color: #aab;
    font-size: 11px;
  }
  .gridbar label { display: flex; gap: 4px; align-items: center; cursor: pointer; }
  .gridbar .size {
    width: 48px;
    background: #14161b;
    color: #ccd;
    border: 1px solid #3a3e48;
    border-radius: 3px;
    font-size: 11px;
    padding: 1px 4px;
  }
  .guide {
    position: absolute;
    z-index: 5;
  }
  .guide.v {
    top: 0;
    bottom: 0;
    width: 7px;
    margin-left: -3px;
    cursor: ew-resize;
    background: linear-gradient(to right, transparent 3px, rgba(53, 182, 232, 0.85) 3px, rgba(53, 182, 232, 0.85) 4px, transparent 4px);
  }
  .guide.h {
    left: 0;
    right: 0;
    height: 7px;
    margin-top: -3px;
    cursor: ns-resize;
    background: linear-gradient(to bottom, transparent 3px, rgba(53, 182, 232, 0.85) 3px, rgba(53, 182, 232, 0.85) 4px, transparent 4px);
  }
  .guide.lockedguide {
    cursor: default;
    opacity: 0.55;
  }
  .gbtn {
    background: none;
    border: 1px solid #3a3e48;
    border-radius: 3px;
    color: #aab;
    font-size: 10px;
    padding: 1px 5px;
    cursor: pointer;
  }
  .gbtn:hover { color: #e6e6e6; border-color: #d9a441; }
  .selection {
    position: absolute;
    border: 1.5px solid #d9a441;
    outline: 1px solid rgba(0, 0, 0, 0.5);
    pointer-events: none;
  }
  .selection.ghost {
    border-style: dashed;
    opacity: 0.6;
  }
  .empty { color: #676c76; text-align: center; margin-top: 30vh; }
</style>
