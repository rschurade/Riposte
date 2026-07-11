<script lang="ts">
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
    built.setFrame(ed.frame);
  });

  $effect(() => {
    built?.setFrame(ed.frame);
  });

  // ---- playback (editor free-run: markers are visualized, not obeyed) ------
  $effect(() => {
    if (!ed.playing || !comp) return;
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
      if (!visibleAtFrame(layer)) continue;
      const r = layerRect(layer);
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) return layer;
    }
    return null;
  }

  const selectionRect = $derived(
    ed.selectedLayer && visibleAtFrame(ed.selectedLayer) ? layerRect(ed.selectedLayer) : ed.selectedLayer ? layerRect(ed.selectedLayer) : null,
  );

  // ---- pointer interaction ---------------------------------------------------
  let drag: { id: string; startX: number; startY: number; applied: { dx: number; dy: number } } | null = null;

  function toComp(ev: PointerEvent): { x: number; y: number } {
    const r = wrapEl.getBoundingClientRect();
    return { x: (ev.clientX - r.left - offset.x) / scale, y: (ev.clientY - r.top - offset.y) / scale };
  }

  function onPointerDown(ev: PointerEvent): void {
    if (!comp) return;
    const p = toComp(ev);
    const hit = hitTest(p.x, p.y);
    ed.selectLayer(hit?.id ?? null);
    if (hit) {
      drag = { id: hit.id, startX: p.x, startY: p.y, applied: { dx: 0, dy: 0 } };
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
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
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
>
  {#if comp}
    <div
      class="board"
      style="left:{offset.x}px;top:{offset.y}px;width:{comp.width * scale}px;height:{comp.height * scale}px"
    >
      <div class="stage" bind:this={stageEl} style="transform:scale({scale});width:{comp.width}px;height:{comp.height}px"></div>
      {#if selectionRect}
        <div
          class="selection"
          style="left:{selectionRect.x * scale}px;top:{selectionRect.y * scale}px;width:{selectionRect.w * scale}px;height:{selectionRect.h * scale}px"
        ></div>
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
  .selection {
    position: absolute;
    border: 1.5px solid #d9a441;
    outline: 1px solid rgba(0, 0, 0, 0.5);
    pointer-events: none;
  }
  .empty { color: #676c76; text-align: center; margin-top: 30vh; }
</style>
