/**
 * The runtime facade: wires renderer + player into the CasparCG template
 * contract and exposes Loopic-compatible middleware hooks so custom code in
 * imported templates ports with minimal edits.
 */

import type { SceneDoc } from '@riposte/shared';
import { buildScene, type BuildOptions, type BuiltScene, type ElementHandle } from './dom.ts';
import { parseUpdateData } from './data.ts';
import { Player } from './player.ts';

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
  const updateMws = new Map<string, UpdateMiddleware[]>(); // '*' = wildcard
  const invokables = new Map<string, (...args: unknown[]) => unknown>();
  const templateData: Record<string, string> = {};
  const flags = { play: false, update: false, stop: false, next: false };

  const player = new Player(comp, {
    onFrame: (f) => built.setFrame(f),
    onEnded: () => built.hide(),
    runAction: (source) => runAction(source),
  });
  built.setFrame(0);

  const compositionApi: CompositionApi = {
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

  function runAction(source: string): void {
    try {
      // `this` = composition (Loopic frame-action semantics), `loopic` = runtime.
      // `runtime` is initialized by the time any action can fire.
      // eslint-disable-next-line no-new-func
      new Function('loopic', source).call(compositionApi, runtime);
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
          if (outroMarker) player.goToAndPlay(outroMarker.frame);
          else {
            player.pause();
            built.hide();
          }
        },
        (mw, next) => mw(next),
      );
    },
    next() {
      flags.next = true;
      player.resume();
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
      player.destroy();
      built.destroy();
    },
  };

  // Composition action runs once on load (globals, middleware registration).
  // The runtime is passed as BOTH `runtime` and `loopic`: imported Loopic
  // composition actions call loopic.useOnUpdate(...) etc. and must run as-is.
  if (comp.action) {
    try {
      // eslint-disable-next-line no-new-func
      new Function('loopic', 'runtime', comp.action).call(compositionApi, runtime, runtime);
    } catch (err) {
      console.error('riposte: composition action failed', err);
    }
  }

  return runtime;
}
