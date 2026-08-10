<script lang="ts">
  import Sidebar from './lib/Sidebar.svelte';
  import Stage from './lib/Stage.svelte';
  import Timeline from './lib/Timeline.svelte';
  import Inspector from './lib/Inspector.svelte';
  import SetOptions from './lib/SetOptions.svelte';
  import DeployDialog from './lib/DeployDialog.svelte';
  import ExportDialog from './lib/ExportDialog.svelte';
  import PresetFx from './lib/PresetFx.svelte';
  import { ed } from './lib/state.svelte.ts';

  $effect(() => {
    ed.connectEvents();
    void (async () => {
      await ed.loadSets();
      // deep link: /?set=FIE_2026&scene=FIE_2026_HD_MedalCounts[&frame=50]
      const params = new URLSearchParams(location.search);
      const setName = params.get('set');
      if (!setName) return;
      const ref = ed.sets.find((s) => s.name === setName);
      if (!ref) return;
      await ed.openSet(ref);
      const sceneName = params.get('scene');
      if (sceneName) {
        const file = ref.scenes.find((f) => f.includes(sceneName));
        if (file) ed.openScene(file);
      }
      const frame = params.get('frame');
      if (frame) ed.frame = Number(frame);
      const layerName = params.get('layer');
      if (layerName && ed.scene) {
        const l = ed.scene.composition.layers.find((x) => x.name?.includes(layerName) || x.element.key === layerName);
        if (l) ed.selectLayer(l.id);
      }
    })();
  });

  // ---- resizable panels (persisted) ---------------------------------------
  const savedLayout = JSON.parse(localStorage.getItem('riposte.layout') ?? '{}') as Record<string, number>;
  let leftW = $state(savedLayout['leftW'] ?? 250);
  let rightW = $state(savedLayout['rightW'] ?? 270);
  let timelineH = $state(savedLayout['timelineH'] ?? 240);

  let splitDrag: { which: 'left' | 'right' | 'timeline'; start: number; orig: number } | null = null;

  function splitDown(ev: PointerEvent, which: 'left' | 'right' | 'timeline'): void {
    splitDrag = {
      which,
      start: which === 'timeline' ? ev.clientY : ev.clientX,
      orig: which === 'left' ? leftW : which === 'right' ? rightW : timelineH,
    };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }

  function splitMove(ev: PointerEvent): void {
    if (!splitDrag) return;
    const { which, start, orig } = splitDrag;
    if (which === 'left') leftW = Math.min(Math.max(orig + (ev.clientX - start), 160), 520);
    else if (which === 'right') rightW = Math.min(Math.max(orig - (ev.clientX - start), 200), 560);
    else timelineH = Math.min(Math.max(orig - (ev.clientY - start), 110), Math.round(window.innerHeight * 0.6));
  }

  function splitUp(): void {
    if (!splitDrag) return;
    splitDrag = null;
    localStorage.setItem('riposte.layout', JSON.stringify({ leftW, rightW, timelineH }));
  }

  function isTyping(): boolean {
    const t = document.activeElement?.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.ctrlKey && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      void ed.save();
      return;
    }
    if (ev.ctrlKey && ev.key.toLowerCase() === 'z') {
      if (isTyping()) return;
      ev.preventDefault();
      if (ev.shiftKey) ed.redo();
      else ed.undo();
      return;
    }
    if (ev.ctrlKey && ev.key.toLowerCase() === 'y') {
      if (isTyping()) return;
      ev.preventDefault();
      ed.redo();
      return;
    }
    if (ev.ctrlKey && ev.key.toLowerCase() === 'd') {
      if (isTyping() || !ed.selectedLayerId) return;
      ev.preventDefault();
      ed.duplicateLayer(ed.selectedLayerId);
      return;
    }
    if (ev.ctrlKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      if (isTyping() || ed.selectionIds.length === 0) return;
      ev.preventDefault();
      ed.nudgeSelection(ev.key === 'ArrowUp' ? 'up' : 'down');
      return;
    }
    if (isTyping() || !ed.scene) return;
    const dur = ed.scene.composition.duration;
    switch (ev.key) {
      case 'Delete':
      case 'Backspace':
        if (ed.selectedKf) {
          ev.preventDefault();
          ed.deleteSelectedKeyframe();
        } else if (ed.selectedLayerId) {
          ev.preventDefault();
          ed.deleteSelectedLayers();
        }
        break;
      case ' ':
        ev.preventDefault();
        ed.playing = !ed.playing;
        break;
      case 'ArrowLeft':
        ed.playing = false;
        ed.frame = Math.max(0, ed.frame - (ev.shiftKey ? 10 : 1));
        break;
      case 'ArrowRight':
        ed.playing = false;
        ed.frame = Math.min(dur - 1, ed.frame + (ev.shiftKey ? 10 : 1));
        break;
      case 'Home':
        ed.frame = 0;
        break;
      case 'End':
        ed.frame = dur - 1;
        break;
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="app" style="--tl-h:{timelineH}px">
  <header>
    <h1>Riposte</h1>
    <span class="scene-name">
      {ed.setRef?.name ?? ''}{ed.sceneFile ? ` / ${ed.sceneFile.replace(/^scenes\//, '').replace(/\.json$/, '')}` : ''}
      {#if ed.dirty}<span class="dirty">●</span>{/if}
    </span>
    <span class="spacer"></span>
    <span class="status" class:err={ed.statusErr}>{ed.status}</span>
    <button class="log" class:attn={!ed.statusLogOpen && ed.statusLog.some((e) => e.err)}
      onclick={() => (ed.statusLogOpen = !ed.statusLogOpen)} title="Message log">≣</button>
    <button onclick={() => ed.undo()} title="Ctrl+Z">↶</button>
    <button onclick={() => ed.redo()} title="Ctrl+Y">↷</button>
    <button class="primary" onclick={() => ed.save()} disabled={!ed.dirty} title="Ctrl+S">Save</button>
    <button onclick={() => { ed.exportDialogOpen = true; }} disabled={!ed.setRef} title="Build templates into a chosen directory (incremental)">Export</button>
    <button onclick={() => ed.deploySet()} disabled={!ed.setRef} title="Export + copy changed files into the CasparCG template directory">Deploy</button>
    <button onclick={() => window.open('/playout.html', 'riposte-playout')} title="Open the virtual CasparCG output (ControlCenter connects to ports 6250/6251)">Playout</button>
  </header>
  <div class="main" style="grid-template-columns:{leftW}px 5px 1fr 5px {rightW}px">
    <Sidebar />
    <div class="split v" role="separator" aria-orientation="vertical"
      onpointerdown={(e) => splitDown(e, 'left')} onpointermove={splitMove} onpointerup={splitUp}></div>
    <Stage />
    <div class="split v" role="separator" aria-orientation="vertical"
      onpointerdown={(e) => splitDown(e, 'right')} onpointermove={splitMove} onpointerup={splitUp}></div>
    <Inspector />
  </div>
  <div class="split h" role="separator" aria-orientation="horizontal"
    onpointerdown={(e) => splitDown(e, 'timeline')} onpointermove={splitMove} onpointerup={splitUp}></div>
  <Timeline />
</div>
{#if ed.statusLogOpen}
  <div class="msglog">
    <div class="msglog-head">
      <span>Messages</span>
      <button onclick={() => (ed.statusLog = [])} title="Clear the log">clear</button>
      <button onclick={() => (ed.statusLogOpen = false)}>✕</button>
    </div>
    {#if ed.statusLog.length === 0}
      <div class="msglog-row muted">no messages yet</div>
    {/if}
    {#each ed.statusLog as e (e)}
      <div class="msglog-row" class:err={e.err}><span class="t">{e.t}</span>{e.msg}</div>
    {/each}
  </div>
{/if}

<SetOptions />
<DeployDialog />
<ExportDialog />
<PresetFx />

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, sans-serif;
    background: #16181d;
    color: #e6e6e6;
    overflow: hidden;
  }
  .app {
    display: grid;
    grid-template-rows: auto 1fr 5px var(--tl-h, 240px);
    height: 100vh;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    border-bottom: 1px solid #2c2f38;
  }
  h1 {
    font-size: 14px;
    letter-spacing: 0.3em;
    font-weight: 400;
    text-transform: uppercase;
    color: #d9a441;
    margin: 0;
  }
  .scene-name { font-size: 13px; color: #aab; }
  .dirty { color: #d9a441; }
  .spacer { flex: 1; }
  .status { color: #7fb069; font-size: 12px; }
  .status.err { color: #e07070; }
  header button.log { padding: 3px 8px; }
  header button.log.attn { border-color: #e07070; color: #e07070; }
  .msglog {
    position: fixed;
    top: 38px;
    right: 8px;
    z-index: 90;
    width: 520px;
    max-height: 55vh;
    overflow-y: auto;
    background: #1c1f26;
    border: 1px solid #383c46;
    border-radius: 6px;
    box-shadow: 0 6px 24px #000a;
    font-size: 12px;
  }
  .msglog-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid #2c2f38;
    color: #aab;
    position: sticky;
    top: 0;
    background: #1c1f26;
  }
  .msglog-head span { flex: 1; text-transform: uppercase; letter-spacing: 0.1em; font-size: 11px; }
  .msglog-head button {
    background: none;
    border: none;
    color: #aab;
    cursor: pointer;
    padding: 2px 6px;
  }
  .msglog-head button:hover { color: #e6e6e6; }
  .msglog-row {
    padding: 4px 10px;
    border-bottom: 1px solid #22252c;
    color: #cbd0da;
    word-break: break-word;
  }
  .msglog-row.err { color: #e07070; }
  .msglog-row.muted { color: #667; }
  .msglog-row .t {
    color: #667;
    margin-right: 8px;
    font-variant-numeric: tabular-nums;
  }
  header button {
    background: #23262e;
    border: 1px solid #383c46;
    color: #e6e6e6;
    border-radius: 4px;
    padding: 3px 12px;
    cursor: pointer;
  }
  header button.primary { background: #2c4a75; }
  header button:disabled { opacity: 0.4; cursor: default; }
  .main {
    display: grid;
    min-height: 0;
  }
  .split {
    background: transparent;
    transition: background 0.15s;
    touch-action: none;
  }
  .split:hover, .split:active { background: #d9a44166; }
  .split.v { cursor: col-resize; }
  .split.h { cursor: row-resize; }
</style>
