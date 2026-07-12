/**
 * The runtime facade: wires renderer + player into the CasparCG template
 * contract and exposes Loopic-compatible middleware hooks so custom code in
 * imported templates ports with minimal edits.
 */

import type { SceneDoc, VisibilityBinding } from '@riposte/shared';
import { buildScene, type BuildOptions, type BuiltScene, type BoundVisibility, type ElementHandle, type LayerHandle } from './dom.ts';
import { parseUpdateData } from './data.ts';
import { Player } from './player.ts';

/** Evaluate a visibility binding against an update() value. */
export function evaluateVisibility(binding: VisibilityBinding, value: string | undefined): boolean {
  if (value === undefined) return binding.initial !== 'hidden';
  if (binding.showWhen) return binding.showWhen.includes(value);
  return !(binding.hideWhen ?? ['0']).includes(value);
}

export interface RuntimeOptions extends BuildOptions {}

type Next = () => void;
export type PlayMiddleware = (next: Next) => void;
export type UpdateMiddleware = (key: string, value: string, next: Next) => void;
export type StopMiddleware = (next: Next) => void;

/** Loopic-like composition API — the `this` of action code. */
export interface CompositionApi {
  readonly activeFrame: number;
  readonly duration: number;
  readonly fps: number;
  readonly isPlaying: boolean;
  /** Built layers in paint order (doc + wrapper node) — for relayout scripts. */
  readonly layers: LayerHandle[];
  play(opts?: { reverse?: boolean }): void;
  pause(): void;
  goTo(frame: number): void;
  goToAndPlay(frame: number, opts?: { reverse?: boolean }): void;
  findElementByKey(key: string): ElementHandle | undefined;
}

export interface Runtime {
  /** Accepts JSON string/object or `<templateData>` XML (ControlCenter sends XML). */
  update(data: string | Record<string, unknown>): void;
  play(): void;
  /** Plays from the outro marker to the end (hides immediately when no outro). */
  stop(): void;
  /** Resumes past the current pause marker. */
  next(): void;
  invoke(name: string, ...args: unknown[]): unknown;

  useOnPlay(cb: PlayMiddleware): void;
  useOnUpdate(key: string, cb: UpdateMiddleware): void;
  useOnStop(cb: StopMiddleware): void;
  useOnNext(cb: PlayMiddleware): void;
  useOnInvoke(name: string, cb: (...args: unknown[]) => unknown): void;

  readonly composition: CompositionApi;
  readonly templateData: Record<string, string>;
  readonly flags: { play: boolean; update: boolean; stop: boolean; next: boolean };
  findElementByKey(key: string): ElementHandle | undefined;
  destroy(): void;
}

export function createRuntime(scene: SceneDoc, root: HTMLElement, opts: RuntimeOptions = {}): Runtime {
  const built: BuiltScene = buildScene(scene, root, opts);
  const comp = scene.composition;

  const playMws: PlayMiddleware[] = [];
  const stopMws: StopMiddleware[] = [];
  const nextMws: PlayMiddleware[] = [];
  const updateMws = new Map<string, UpdateMiddleware[]>(); // '*' = wildcard
  const invokables = new Map<string, (...args: unknown[]) => unknown>();
  const templateData: Record<string, string> = {};
  const flags = { play: false, update: false, stop: false, next: false };

  // Hold clock: while the playhead is parked on a pause marker, loop layers
  // keep animating — advance their shared `hold` time and re-render the
  // parked frame. Runs only for scenes that actually have loop layers.
  let holdRaf: number | null = null;
  let holdLast = 0;
  const stopHoldClock = (): void => {
    if (holdRaf !== null) {
      cancelAnimationFrame(holdRaf);
      holdRaf = null;
    }
  };
  const startHoldClock = (): void => {
    if (!built.hasLoops || built.timeState.exiting || holdRaf !== null) return;
    holdLast = 0;
    const tick = (ts: number): void => {
      holdRaf = null;
      if (player.playing || built.timeState.exiting || !built.isVisible()) return;
      if (holdLast === 0) holdLast = ts;
      const dt = Math.min((ts - holdLast) / 1000, 0.25);
      holdLast = ts;
      built.timeState.hold += dt * comp.fps;
      built.setFrame(player.activeFrame);
      holdRaf = requestAnimationFrame(tick);
    };
    holdRaf = requestAnimationFrame(tick);
  };
  // Outro begins: loop layers abandon their loop position and play their
  // exit zone in scene time, in sync with the scene outro.
  const latchExit = (frame: number): void => {
    if (!built.hasLoops || built.timeState.exiting) return;
    built.timeState.exiting = true;
    built.timeState.exitFrom = frame;
    stopHoldClock();
  };
  const lastPauseFrame = comp.markers.reduce((max, m) => (m.type === 'pause' && m.frame > max ? m.frame : max), -1);

  const player = new Player(comp, {
    onFrame: (f) => built.setFrame(f),
    onEnded: () => built.hide(),
    runAction: (source) => runAction(source),
    onPaused: () => startHoldClock(),
    onOutro: (f) => latchExit(f),
  });
  built.setFrame(0);

  // Visibility bindings: index by update key, apply initial states.
  const visByKey = new Map<string, BoundVisibility[]>();
  const applyBinding = (b: BoundVisibility, value: string | undefined): void => {
    const visible = evaluateVisibility(b.binding, value);
    b.handle.setVisible(visible);
    // design-time hidden layer: the binding lifts/re-applies the wrapper
    if (b.hiddenLayerNode) b.hiddenLayerNode.style.visibility = visible ? '' : 'hidden';
  };
  for (const b of built.boundVisibility) {
    const list = visByKey.get(b.binding.bindKey) ?? [];
    list.push(b);
    visByKey.set(b.binding.bindKey, list);
    applyBinding(b, undefined);
  }

  const compositionApi: CompositionApi = {
    get layers() {
      return built.layers;
    },
    get activeFrame() {
      return player.activeFrame;
    },
    get duration() {
      return player.duration;
    },
    get fps() {
      return player.fps;
    },
    get isPlaying() {
      return player.playing;
    },
    play: (o) => player.play({ reverse: o?.reverse }),
    pause: () => player.pause(),
    goTo: (f) => player.goTo(f),
    goToAndPlay: (f, o) => player.goToAndPlay(f, { reverse: o?.reverse }),
    findElementByKey: (key) => built.byKey.get(key),
  };

  // Scope available to action code. Canonical API: bare hooks + find() +
  // `riposte` (the runtime); `this` = composition. `loopic` and `runtime`
  // stay as deprecated aliases so unmigrated Loopic imports run as-is.
  const ACTION_PARAMS = ['riposte', 'runtime', 'loopic', 'useOnPlay', 'useOnUpdate', 'useOnStop', 'useOnNext', 'useOnInvoke', 'find'];
  const actionArgs = (): unknown[] => [
    runtime,
    runtime,
    runtime,
    runtime.useOnPlay,
    runtime.useOnUpdate,
    runtime.useOnStop,
    runtime.useOnNext,
    runtime.useOnInvoke,
    runtime.findElementByKey,
  ];

  function runAction(source: string): void {
    try {
      // `runtime` is initialized by the time any action can fire.
      // eslint-disable-next-line no-new-func
      new Function(...ACTION_PARAMS, source).call(compositionApi, ...actionArgs());
    } catch (err) {
      console.error('riposte: action failed', err);
    }
  }

  function chain<T extends (...a: never[]) => void>(mws: T[], final: () => void, invoke: (mw: T, next: Next) => void): void {
    let i = -1;
    const step = (): void => {
      i++;
      if (i < mws.length) invoke(mws[i]!, step);
      else final();
    };
    step();
  }

  function applyUpdateKey(key: string, value: string): void {
    const specific = updateMws.get(key) ?? [];
    const wildcard = updateMws.get('*') ?? [];
    const mws = [...wildcard, ...specific];
    chain(
      mws,
      () => {
        for (const b of visByKey.get(key) ?? []) applyBinding(b, value);
        const el = built.byKey.get(key);
        if (!el) return;
        if (el.type === 'text') el.setContent(value);
        else if (el.type === 'imageLoader') el.setImage(value);
      },
      (mw, next) => mw(key, value, next),
    );
  }

  const outroMarker = comp.markers.find((m) => m.type === 'outro');

  const runtime: Runtime = {
    update(data) {
      flags.update = true;
      let parsed: Record<string, string>;
      try {
        parsed = parseUpdateData(data as string | Record<string, unknown>);
      } catch (err) {
        console.error('riposte: bad update payload', err);
        return;
      }
      for (const [k, v] of Object.entries(parsed)) {
        templateData[k] = v;
        applyUpdateKey(k, v);
      }
    },
    play() {
      flags.play = true;
      chain(
        playMws,
        () => {
          // fresh cycle: loop layers restart their entrance
          stopHoldClock();
          built.timeState.hold = 0;
          built.timeState.exiting = false;
          built.show();
          player.play({ from: 0 });
        },
        (mw, next) => mw(next),
      );
    },
    stop() {
      flags.stop = true;
      chain(
        stopMws,
        () => {
          if (outroMarker) {
            latchExit(outroMarker.frame);
            player.goToAndPlay(outroMarker.frame);
          } else {
            player.pause();
            stopHoldClock();
            built.hide();
          }
        },
        (mw, next) => mw(next),
      );
    },
    next() {
      flags.next = true;
      chain(
        nextMws,
        () => {
          // resuming off the LAST pause plays the outro — exit the loops with it
          if (!player.playing && lastPauseFrame >= 0 && player.activeFrame >= lastPauseFrame) {
            latchExit(player.activeFrame);
          }
          player.resume();
        },
        (mw, next) => mw(next),
      );
    },
    invoke(name, ...args) {
      const fn = invokables.get(name);
      if (!fn) {
        console.warn(`riposte: no invokable "${name}"`);
        return undefined;
      }
      return fn(...args);
    },
    useOnPlay: (cb) => playMws.push(cb),
    useOnStop: (cb) => stopMws.push(cb),
    useOnNext: (cb) => nextMws.push(cb),
    useOnUpdate(key, cb) {
      const list = updateMws.get(key) ?? [];
      list.push(cb);
      updateMws.set(key, list);
    },
    useOnInvoke(name, cb) {
      invokables.set(name, cb);
      // CasparCG INVOKE calls a global function by name — expose it.
      const w = globalThis as Record<string, unknown>;
      if (typeof window !== 'undefined' && !(name in w)) w[name] = cb;
    },
    composition: compositionApi,
    templateData,
    flags,
    findElementByKey: (key) => built.byKey.get(key),
    destroy() {
      stopHoldClock();
      player.destroy();
      built.destroy();
    },
  };

  // Composition action runs once on load (globals, middleware registration).
  if (comp.action) {
    try {
      // eslint-disable-next-line no-new-func
      new Function(...ACTION_PARAMS, comp.action).call(compositionApi, ...actionArgs());
    } catch (err) {
      console.error('riposte: composition action failed', err);
    }
  }

  return runtime;
}
