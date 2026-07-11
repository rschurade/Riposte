<script lang="ts">
  import type { ElementStyle, Layer } from '@riposte/shared';
  import { ed } from './state.svelte.ts';

  let rowsEl: HTMLDivElement | undefined = $state();
  let trackWidth = $state(600);

  const comp = $derived(ed.scene?.composition ?? null);
  const pxPerFrame = $derived(comp ? Math.max(1.5, trackWidth / comp.duration) : 2);

  $effect(() => {
    if (!rowsEl) return;
    const ro = new ResizeObserver(() => {
      trackWidth = (rowsEl?.clientWidth ?? 620) - 180; // minus label column
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
  }

  /** Animated properties of the selected layer (element + masks) as sub-rows. */
  function propRows(layer: Layer): PropRow[] {
    const rows: PropRow[] = [];
    const collect = (style: ElementStyle, targetKey: string, prefix: string) => {
      for (const [prop, p] of Object.entries(style)) {
        if (!p?.keyframes?.length) continue;
        rows.push({
          targetKey,
          prop,
          label: prefix + prop,
          frames: p.keyframes.map((k) => k.frame),
        });
      }
    };
    collect(layer.element.style, 'el', '');
    (layer.masks ?? []).forEach((m, i) => collect(m.style, `mask${i}`, `mask${i > 0 ? i + 1 : ''}.`));
    return rows;
  }

  // ---- keyframe diamond interaction -----------------------------------------
  let dragKf: { targetKey: string; prop: string; from: number; current: number } | null = $state(null);

  function kfDown(ev: PointerEvent, row: PropRow, frame: number): void {
    ev.stopPropagation();
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
      <div class="scroll">
        {#each displayLayers as layer (layer.id)}
          <div
            class="row"
            class:selected={ed.selectedLayerId === layer.id}
            onpointerdown={() => ed.selectLayer(layer.id)}
            {@attach (node) => {
              if (ed.selectedLayerId === layer.id) node.scrollIntoView({ block: 'center' });
            }}
          >
            <div class="label" class:dim={layer.hidden || layer.isGuide}>
              {layer.isGuide ? '▦ ' : ''}{layer.hidden ? '∅ ' : ''}{layer.name}
            </div>
            <div class="track">
              <div
                class="bar"
                style="left:{layer.startFrame * pxPerFrame}px;width:{layer.duration * pxPerFrame}px"
              ></div>
              <span class="playhead faint" style="left:{ed.frame * pxPerFrame}px"></span>
            </div>
          </div>
          {#if ed.selectedLayerId === layer.id}
            {#each propRows(layer) as row (row.targetKey + row.prop)}
              <div class="row proprow">
                <div class="label prop">{row.label}</div>
                <div class="track" onpointermove={kfMove} onpointerup={kfUp}>
                  {#each row.frames as f (f)}
                    <span
                      class="kf"
                      class:selkf={isSelectedKf(row, f)}
                      style="left:{kfDisplayFrame(row, f) * pxPerFrame}px"
                      title="{row.label} @{kfDisplayFrame(row, f)}"
                      onpointerdown={(ev) => kfDown(ev, row, f)}
                    ></span>
                  {/each}
                  <span class="playhead faint" style="left:{ed.frame * pxPerFrame}px"></span>
                </div>
              </div>
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
  .dim { color: #676c76; font-size: 11px; }
  .rows { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .scroll { overflow-y: auto; flex: 1; }
  .row { display: flex; height: 22px; align-items: stretch; }
  .row.head { height: 26px; border-bottom: 1px solid #23262e; }
  .row.selected { background: #222d40; }
  .label {
    width: 180px;
    flex: none;
    font-size: 11px;
    color: #aab;
    padding: 3px 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-right: 1px solid #23262e;
  }
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
  }
  .row.proprow { height: 18px; background: #1b1e25; }
  .label.prop { padding-left: 24px; color: #8a8f98; font-size: 10px; }
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
