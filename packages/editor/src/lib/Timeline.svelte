<script lang="ts">
  import type { ElementStyle, Layer } from '@riposte/shared';
  import {
    ed,
    layerLabel,
    dispPropValue,
    TRANSFORM_PROPS,
    FILTER_PROP_DEFS,
    MASK_PROP_DEFS,
    type PropDef,
  } from './state.svelte.ts';

  let rowsEl: HTMLDivElement | undefined = $state();
  let trackWidth = $state(600);

  const comp = $derived(ed.scene?.composition ?? null);
  const pxPerFrame = $derived(comp ? Math.max(1.5, trackWidth / comp.duration) : 2);

  $effect(() => {
    if (!rowsEl) return;
    const ro = new ResizeObserver(() => {
      trackWidth = (rowsEl?.clientWidth ?? 620) - 280; // minus label column
    });
    ro.observe(rowsEl);
    return () => ro.disconnect();
  });

  /** Display top-first, like a layer panel (scene array is bottom-first). */
  const displayLayers = $derived(comp ? [...comp.layers].slice().reverse() : []);


  interface PropRow {
    targetKey: string;
    label: string;
    prop: string;
    frames: number[];
    def: PropDef;
    style: ElementStyle;
  }

  interface PropGroup {
    title: string;
    key: string;
    rows: PropRow[];
  }

  // Loopic-style in-place expansion: chevron per layer, grouped property rows.
  let expandedLayers = $state<Record<string, boolean>>({});
  let groupClosed = $state<Record<string, boolean>>({});

  function layerGroups(layer: Layer): PropGroup[] {
    const mk = (style: ElementStyle, targetKey: string, defs: PropDef[]): PropRow[] =>
      defs.map((def) => ({
        targetKey,
        prop: def.prop,
        label: def.label,
        def,
        style,
        frames: style[def.prop]?.keyframes?.map((k) => k.frame) ?? [],
      }));
    const groups: PropGroup[] = [
      {
        title: 'Transform',
        key: `${layer.id}/t`,
        rows: mk(
          layer.element.style,
          'el',
          TRANSFORM_PROPS.filter((d) => d.prop !== 'fontSize' || layer.element.type === 'text'),
        ),
      },
      { title: 'Filter', key: `${layer.id}/f`, rows: mk(layer.element.style, 'el', FILTER_PROP_DEFS) },
    ];
    (layer.masks ?? []).forEach((m, i) => {
      if (m.type === 'path') return;
      groups.push({
        title: `Mask${(layer.masks?.length ?? 0) > 1 ? ` ${i + 1}` : ''}`,
        key: `${layer.id}/m${i}`,
        rows: mk(m.style, `mask${i}`, MASK_PROP_DEFS),
      });
    });
    return groups;
  }

  /** Filter starts closed unless it carries data; everything else starts open. */
  function groupOpen(g: PropGroup): boolean {
    const override = groupClosed[g.key];
    if (override !== undefined) return !override;
    return g.title !== 'Filter' || g.rows.some((r) => r.style[r.prop] !== undefined);
  }

  function setPropValue(layer: Layer, row: PropRow, raw: string): void {
    let v = Number(raw);
    if (!Number.isFinite(v)) return;
    if (row.def.pct) v /= 100;
    ed.selectLayer(layer.id);
    ed.setValueAtPlayhead(row.targetKey, row.prop, v, layer.id);
  }

  /** All keyframe frames of a layer (element + masks) — the at-a-glance marks. */
  function allKfFrames(layer: Layer): number[] {
    const frames = new Set<number>();
    const collect = (style: ElementStyle) => {
      for (const p of Object.values(style)) for (const k of p?.keyframes ?? []) frames.add(k.frame);
    };
    collect(layer.element.style);
    for (const m of layer.masks ?? []) collect(m.style);
    return [...frames];
  }

  // ---- keyframe diamond interaction -----------------------------------------
  let dragKf: { targetKey: string; prop: string; from: number; current: number } | null = $state(null);

  function kfDown(ev: PointerEvent, row: PropRow, frame: number, layerId: string): void {
    ev.stopPropagation();
    ed.selectLayer(layerId); // keyframe ops act on the selected layer
    ed.selectedKf = { targetKey: row.targetKey, prop: row.prop, frame };
    dragKf = { targetKey: row.targetKey, prop: row.prop, from: frame, current: frame };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }

  function kfMove(ev: PointerEvent): void {
    if (!dragKf || !comp) return;
    const track = (ev.currentTarget as HTMLElement).closest('.track');
    if (!track) return;
    const r = track.getBoundingClientRect();
    const f = Math.round((ev.clientX - r.left) / pxPerFrame);
    dragKf.current = Math.min(Math.max(f, 0), comp.duration - 1);
  }

  function kfUp(): void {
    if (!dragKf) return;
    const { targetKey, prop, from, current } = dragKf;
    dragKf = null;
    if (from !== current) ed.moveKeyframe(targetKey, prop, from, current);
  }

  function kfDisplayFrame(row: PropRow, frame: number): number {
    return dragKf && dragKf.targetKey === row.targetKey && dragKf.prop === row.prop && dragKf.from === frame
      ? dragKf.current
      : frame;
  }

  function isSelectedKf(row: PropRow, frame: number): boolean {
    const s = ed.selectedKf;
    return !!s && s.targetKey === row.targetKey && s.prop === row.prop && s.frame === frame;
  }

  // ---- layer bar move/trim ----------------------------------------------------
  type BarMode = 'move' | 'left' | 'right';
  let dragBar: {
    id: string;
    mode: BarMode;
    downX: number;
    orig: { start: number; dur: number };
    cur: { start: number; dur: number };
  } | null = $state(null);

  function barDown(ev: PointerEvent, layer: Layer, mode: BarMode): void {
    ev.stopPropagation();
    ed.selectLayer(layer.id);
    dragBar = {
      id: layer.id,
      mode,
      downX: ev.clientX,
      orig: { start: layer.startFrame, dur: layer.duration },
      cur: { start: layer.startFrame, dur: layer.duration },
    };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }

  function barMove(ev: PointerEvent): void {
    if (!dragBar || !comp) return;
    const df = Math.round((ev.clientX - dragBar.downX) / pxPerFrame);
    const { start, dur } = dragBar.orig;
    if (dragBar.mode === 'move') {
      const s = Math.min(Math.max(start + df, 0), comp.duration - dur);
      dragBar.cur = { start: Math.max(s, 0), dur };
    } else if (dragBar.mode === 'left') {
      const s = Math.min(Math.max(start + df, 0), start + dur - 1);
      dragBar.cur = { start: s, dur: start + dur - s };
    } else {
      const d = Math.min(Math.max(dur + df, 1), comp.duration - start);
      dragBar.cur = { start, dur: d };
    }
  }

  function barUp(): void {
    if (!dragBar) return;
    const { id, orig, cur } = dragBar;
    dragBar = null;
    if (cur.start !== orig.start || cur.dur !== orig.dur) ed.setLayerSpan(id, cur.start, cur.dur);
  }

  /** Bar geometry with live drag feedback. */
  function barSpan(layer: Layer): { start: number; dur: number } {
    return dragBar?.id === layer.id ? dragBar.cur : { start: layer.startFrame, dur: layer.duration };
  }

  // ---- layer rename -------------------------------------------------------------
  let renamingLayer = $state<{ id: string; value: string } | null>(null);

  function commitLayerRename(): void {
    if (!renamingLayer) return;
    const { id, value } = renamingLayer;
    renamingLayer = null;
    ed.renameLayer(id, value);
  }

  // ---- asset drop → new image / sequence layer -----------------------------------
  function onDragOver(ev: DragEvent): void {
    const types = ev.dataTransfer?.types ?? [];
    if (types.includes('text/riposte-asset') || types.includes('text/riposte-sequence')) {
      ev.preventDefault();
      ev.dataTransfer!.dropEffect = 'copy';
    }
  }

  function onDrop(ev: DragEvent): void {
    const seq = ev.dataTransfer?.getData('text/riposte-sequence');
    if (seq) {
      ev.preventDefault();
      ed.addSequenceLayer(JSON.parse(seq) as string[]);
      return;
    }
    const file = ev.dataTransfer?.getData('text/riposte-asset');
    if (!file) return;
    ev.preventDefault();
    ed.addImageLayer(file);
  }

  function seek(ev: PointerEvent): void {
    if (!comp) return;
    const target = ev.currentTarget as HTMLElement;
    const r = target.getBoundingClientRect();
    const f = Math.round((ev.clientX - r.left) / pxPerFrame);
    ed.frame = Math.min(Math.max(f, 0), comp.duration - 1);
    ed.playing = false;
  }

  let scrubbing = false;

  function rulerDown(ev: PointerEvent): void {
    scrubbing = true;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    seek(ev);
  }
  function rulerMove(ev: PointerEvent): void {
    if (scrubbing) seek(ev);
  }

  const ticks = $derived.by(() => {
    if (!comp) return [] as number[];
    const step = comp.duration > 400 ? 50 : 25;
    const out: number[] = [];
    for (let f = 0; f <= comp.duration; f += step) out.push(f);
    return out;
  });
</script>

<section>
  {#if comp}
    <div class="transport">
      <button onclick={() => (ed.playing = !ed.playing)}>{ed.playing ? '⏸' : '▶'}</button>
      <button onclick={() => { ed.playing = false; ed.frame = 0; }} title="to start">⏮</button>
      <button onclick={() => { ed.playing = false; ed.frame = ed.firstPauseFrame(); }} title="to pause marker">⇥ pause</button>
      <span class="frame">{ed.frame} / {comp.duration - 1}</span>
      <span class="dim">{comp.fps} fps</span>
      <span class="spacer"></span>
      <span class="dim">add:</span>
      <button title="Add text element" onclick={() => ed.addElementLayer('text')}>T text</button>
      <button title="Add rectangle" onclick={() => ed.addElementLayer('rectangle')}>▬ rect</button>
      <button title="Add ellipse" onclick={() => ed.addElementLayer('ellipse')}>● ellipse</button>
      <button title="Add image loader (dynamic image via update)" onclick={() => ed.addElementLayer('imageLoader')}>▣ loader</button>
      <span class="dim">— drag an asset here for a static image</span>
    </div>
    <div class="rows" bind:this={rowsEl}>
      <div class="row head">
        <div class="label dim">timeline</div>
        <div
          class="track ruler"
          role="slider"
          aria-label="playhead"
          aria-valuenow={ed.frame}
          tabindex="-1"
          onpointerdown={rulerDown}
          onpointermove={rulerMove}
          onpointerup={() => (scrubbing = false)}
        >
          {#each ticks as t (t)}
            <span class="tick" style="left:{t * pxPerFrame}px">{t}</span>
          {/each}
          {#each comp.markers as m, i (i)}
            <span
              class="marker {m.type}"
              style="left:{m.frame * pxPerFrame}px"
              title="{m.type}@{m.frame}"
            ></span>
          {/each}
          <span class="playhead" style="left:{ed.frame * pxPerFrame}px"></span>
        </div>
      </div>
      <div class="scroll" role="list" ondragover={onDragOver} ondrop={onDrop}>
        {#each displayLayers as layer (layer.id)}
          {@const kfFrames = allKfFrames(layer)}
          {@const span = barSpan(layer)}
          <div
            class="row"
            class:selected={ed.selectedLayerId === layer.id}
            onpointerdown={() => ed.selectLayer(layer.id)}
            {@attach (node) => {
              if (ed.selectedLayerId === layer.id) node.scrollIntoView({ block: 'center' });
            }}
          >
            <div class="label" class:dim={layer.hidden || layer.isGuide}>
              <button
                class="chev"
                title="Show properties"
                onpointerdown={(e) => e.stopPropagation()}
                onclick={() => (expandedLayers[layer.id] = !expandedLayers[layer.id])}
              >{expandedLayers[layer.id] ? '▾' : '▸'}</button>
              {#if renamingLayer?.id === layer.id}
                <input
                  class="rename"
                  type="text"
                  value={renamingLayer.value}
                  oninput={(e) => { if (renamingLayer) renamingLayer.value = (e.currentTarget as HTMLInputElement).value; }}
                  onkeydown={(e) => { if (e.key === 'Enter') commitLayerRename(); else if (e.key === 'Escape') renamingLayer = null; }}
                  onblur={commitLayerRename}
                  onpointerdown={(e) => e.stopPropagation()}
                  {@attach (node) => { (node as HTMLInputElement).focus(); (node as HTMLInputElement).select(); }}
                />
              {:else}
                <span
                  class="ltext"
                  role="button"
                  tabindex="-1"
                  title="{layerLabel(layer)} — double-click to rename{layer.element.key ? ' (edits the key)' : ''}"
                  ondblclick={() => (renamingLayer = { id: layer.id, value: layer.element.key ?? layer.name ?? '' })}
                >
                  {#if kfFrames.length > 0}<span class="animind" title="{kfFrames.length} keyframes">◆</span>{/if}
                  {layer.isGuide ? '▦ ' : ''}{layerLabel(layer)}
                </span>
                <button
                  class="rowbtn"
                  title="Duplicate layer (Ctrl+D)"
                  onpointerdown={(e) => e.stopPropagation()}
                  onclick={() => ed.duplicateLayer(layer.id)}
                >⧉</button>
                <button
                  class="rowbtn del"
                  title="Delete layer (Del)"
                  onpointerdown={(e) => e.stopPropagation()}
                  onclick={() => ed.deleteLayer(layer.id)}
                >✕</button>
                <button
                  class="eye"
                  class:off={layer.hidden}
                  title={layer.hidden ? 'Hidden — click to show' : 'Visible — click to hide'}
                  onpointerdown={(e) => e.stopPropagation()}
                  onclick={() => ed.setLayerHidden(layer.id, !layer.hidden)}
                >
                  {#if layer.hidden}
                    <svg viewBox="0 0 16 16" width="13" height="13"><path d="M2 8s2.2-3.5 6-3.5c.8 0 1.5.15 2.2.4M14 8s-2.2 3.5-6 3.5c-.8 0-1.5-.15-2.2-.4M3 13 13 3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
                  {:else}
                    <svg viewBox="0 0 16 16" width="13" height="13"><path d="M2 8s2.2-3.5 6-3.5S14 8 14 8s-2.2 3.5-6 3.5S2 8 2 8Z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.7" fill="currentColor"/></svg>
                  {/if}
                </button>
              {/if}
            </div>
            <div class="track">
              <div
                class="bar"
                class:dragging={dragBar?.id === layer.id}
                style="left:{span.start * pxPerFrame}px;width:{span.dur * pxPerFrame}px"
                title="{span.start} – {span.start + span.dur} (drag to move, edges to trim)"
                onpointerdown={(ev) => barDown(ev, layer, 'move')}
                onpointermove={barMove}
                onpointerup={barUp}
              >
                {#if layer.loop && layer.loop.end > layer.loop.start}
                  <div
                    class="loopzone"
                    style="left:{layer.loop.start * pxPerFrame}px;width:{(layer.loop.end - layer.loop.start) * pxPerFrame}px"
                    title="loop {layer.loop.start}–{layer.loop.end} (layer frames)"
                  ></div>
                {/if}
                <div class="handle l" onpointerdown={(ev) => barDown(ev, layer, 'left')} onpointermove={barMove} onpointerup={barUp}></div>
                <div class="handle r" onpointerdown={(ev) => barDown(ev, layer, 'right')} onpointermove={barMove} onpointerup={barUp}></div>
              </div>
              {#each kfFrames as f (f)}
                <span class="kfmark" style="left:{f * pxPerFrame}px"></span>
              {/each}
              <span class="playhead faint" style="left:{ed.frame * pxPerFrame}px"></span>
            </div>
          </div>
          {#if expandedLayers[layer.id]}
            {#each layerGroups(layer) as g (g.key)}
              <div class="row grouprow">
                <div class="label group">
                  <button class="chev" onclick={() => (groupClosed[g.key] = groupOpen(g))}>
                    {groupOpen(g) ? '▾' : '▸'} {g.title}
                  </button>
                </div>
                <div class="track"></div>
              </div>
              {#if groupOpen(g)}
                {#each g.rows as row (g.key + row.prop)}
                  <div class="row proprow" onpointerdown={() => ed.selectLayer(layer.id)}>
                    <div class="label prop">
                      <span class="pname">{row.label}</span>
                      <input
                        class="pval"
                        type="number"
                        step="1"
                        value={dispPropValue(row.style[row.prop], row.def, ed.frame)}
                        onchange={(e) => setPropValue(layer, row, (e.currentTarget as HTMLInputElement).value)}
                        onpointerdown={(e) => e.stopPropagation()}
                      />
                      <button
                        class="kfbtn"
                        class:on={row.frames.includes(ed.frame)}
                        class:animated={row.frames.length > 0}
                        title={row.frames.includes(ed.frame)
                          ? `Remove ${row.label} keyframe @${ed.frame}`
                          : `Add ${row.label} keyframe @${ed.frame}`}
                        onpointerdown={(e) => e.stopPropagation()}
                        onclick={() => {
                          ed.selectLayer(layer.id);
                          ed.toggleKeyframe(row.targetKey, row.prop, row.def.fallback, layer.id);
                        }}
                      >◆</button>
                    </div>
                    <div class="track" onpointermove={kfMove} onpointerup={kfUp}>
                      {#each row.frames as f (f)}
                        <span
                          class="kf"
                          class:selkf={isSelectedKf(row, f)}
                          style="left:{kfDisplayFrame(row, f) * pxPerFrame}px"
                          title="{row.label} @{kfDisplayFrame(row, f)}"
                          onpointerdown={(ev) => kfDown(ev, row, f, layer.id)}
                        ></span>
                      {/each}
                      <span class="playhead faint" style="left:{ed.frame * pxPerFrame}px"></span>
                    </div>
                  </div>
                {/each}
              {/if}
            {/each}
          {/if}
        {/each}
      </div>
    </div>
  {/if}
</section>

<style>
  section {
    border-top: 1px solid #2c2f38;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: #17191e;
  }
  .transport {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    border-bottom: 1px solid #23262e;
  }
  .transport button {
    background: #23262e;
    border: 1px solid #383c46;
    color: #e6e6e6;
    border-radius: 4px;
    padding: 2px 10px;
    cursor: pointer;
  }
  .frame { font: 12px Consolas, monospace; color: #d9a441; min-width: 80px; }
  .spacer { flex: 1; }
  .dim { color: #676c76; font-size: 11px; }
  .rows { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .scroll { overflow-y: auto; flex: 1; }
  .row { display: flex; height: 22px; align-items: stretch; }
  .row.head { height: 26px; border-bottom: 1px solid #23262e; }
  .row.selected { background: #222d40; }
  .label {
    width: 280px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: #aab;
    padding: 3px 4px 3px 8px;
    white-space: nowrap;
    overflow: hidden;
    border-right: 1px solid #23262e;
  }
  .ltext { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .eye {
    flex: none;
    background: none;
    border: none;
    padding: 0 2px;
    cursor: pointer;
    color: #4a4e58;
    line-height: 0;
  }
  .row:hover .eye, .eye.off { color: #8a8f98; }
  .eye.off { color: #e0a34e; }
  .eye:hover { color: #cfd3da; }
  .rowbtn {
    flex: none;
    display: none;
    background: none;
    border: none;
    padding: 0 2px;
    cursor: pointer;
    color: #8a8f98;
    font-size: 11px;
    line-height: 1;
  }
  .row:hover .rowbtn { display: block; }
  .rowbtn:hover { color: #cfd3da; }
  .rowbtn.del:hover { color: #e07777; }
  .track { position: relative; flex: 1; overflow: hidden; }
  .ruler { cursor: ew-resize; }
  .tick {
    position: absolute;
    top: 2px;
    font-size: 9px;
    color: #676c76;
    border-left: 1px solid #33363e;
    padding-left: 2px;
    height: 100%;
  }
  .bar {
    position: absolute;
    top: 5px;
    height: 12px;
    background: #2c4a75;
    border-radius: 3px;
    opacity: 0.85;
    cursor: grab;
  }
  .bar.dragging, .bar:hover { opacity: 1; background: #38598a; }
  .loopzone {
    position: absolute;
    top: 2px;
    bottom: 2px;
    background: repeating-linear-gradient(-45deg, rgba(120, 200, 140, 0.55) 0 4px, rgba(120, 200, 140, 0.25) 4px 8px);
    border-radius: 2px;
    pointer-events: none;
  }
  .handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 7px;
    cursor: col-resize;
  }
  .handle.l { left: -2px; border-radius: 3px 0 0 3px; }
  .handle.r { right: -2px; border-radius: 0 3px 3px 0; }
  .bar:hover .handle { background: rgba(255, 255, 255, 0.25); }
  .rename {
    background: #14161b;
    color: #fff;
    border: 1px solid #d9a441;
    border-radius: 3px;
    padding: 0 4px;
    font-size: 11px;
    width: 100%;
  }
  .animind { color: #d9a441; font-size: 8px; margin-right: 3px; vertical-align: 1px; }
  .kfmark {
    position: absolute;
    top: 9px;
    width: 4px;
    height: 4px;
    margin-left: -2px;
    background: #d9a441;
    opacity: 0.65;
    transform: rotate(45deg);
    pointer-events: none;
  }
  .row.proprow { height: 20px; background: #1b1e25; }
  .row.grouprow { height: 18px; background: #191c22; }
  .label.group { padding-left: 18px; }
  .label.group .chev { font-size: 10px; color: #7d828c; text-transform: uppercase; letter-spacing: 0.08em; width: auto; }
  .label.prop {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-left: 30px;
    color: #8a8f98;
    font-size: 10px;
  }
  .pname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pval {
    flex: none;
    width: 58px;
    background: none;
    border: none;
    border-bottom: 1px solid transparent;
    color: #cfd3da;
    font-size: 10px;
    text-align: right;
    padding: 0 2px;
  }
  .pval:hover, .pval:focus { border-bottom-color: #383c46; background: #14161b; outline: none; }
  /* hide number spinners — too big for 20px rows */
  .pval::-webkit-outer-spin-button, .pval::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .kfbtn {
    flex: none;
    background: none;
    border: none;
    color: #4a4e58;
    cursor: pointer;
    font-size: 11px;
    padding: 0 2px;
    line-height: 1;
  }
  .kfbtn.animated { color: #8a6a2a; }
  .kfbtn.on { color: #d9a441; }
  .kfbtn:hover { color: #d9a441; }
  .chev {
    flex: none;
    background: none;
    border: none;
    color: #676c76;
    cursor: pointer;
    font-size: 9px;
    padding: 0 2px;
    width: 14px;
  }
  .chev:hover { color: #cfd3da; }
  .kf {
    position: absolute;
    top: 5px;
    width: 8px;
    height: 8px;
    margin-left: -4px;
    background: #d9a441;
    transform: rotate(45deg);
    cursor: ew-resize;
  }
  .kf.selkf { background: #fff; outline: 1.5px solid #d9a441; }
  .marker { position: absolute; top: 0; bottom: 0; width: 2px; }
  .marker.pause { background: #4ea1e0; }
  .marker.outro { background: #e05555; }
  .marker.loop, .marker.action { background: #8a62d0; }
  .playhead { position: absolute; top: 0; bottom: 0; width: 1.5px; background: #d9a441; pointer-events: none; }
  .playhead.faint { opacity: 0.35; }
</style>
