/**
 * Template bootstrap for exported HTML shells.
 *
 * CasparCG may call update()/play() the moment the page loads, before the
 * DOM (or the scene fetch) is ready — boot() installs the four global
 * contract functions immediately and queues calls until the runtime exists
 * (Loopic's onReady pattern).
 */

import type { SceneDoc } from '@riposte/shared';
import { createRuntime, type Runtime, type RuntimeOptions } from './runtime.ts';

export interface BootOptions extends RuntimeOptions {
  /** Preload these asset URLs before declaring ready (kills first-play flash). */
  preload?: string[];
  /** Fonts to register and await before declaring ready. */
  fonts?: { family: string; url: string }[];
}

export function boot(scene: SceneDoc, opts: BootOptions = {}): Promise<Runtime> {
  let runtime: Runtime | null = null;
  const queue: Array<(rt: Runtime) => void> = [];
  const call = (fn: (rt: Runtime) => void) => (runtime ? fn(runtime) : queue.push(fn));

  const w = window as unknown as Record<string, unknown>;
  w['update'] = (d: string) => call((rt) => rt.update(d));
  w['play'] = () => call((rt) => rt.play());
  w['stop'] = () => call((rt) => rt.stop());
  w['next'] = () => call((rt) => rt.next());
  w['invoke'] = (name: string, ...args: unknown[]) => call((rt) => rt.invoke(name, ...args));

  return new Promise((resolve) => {
    const start = async () => {
      if (opts.fonts?.length) await loadFonts(opts.fonts);
      if (opts.preload?.length) await preloadAll(opts.preload);
      runtime = createRuntime(scene, document.body, opts);
      w['__riposte'] = runtime; // debugging/verification handle
      for (const fn of queue) fn(runtime);
      queue.length = 0;
      resolve(runtime);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => void start());
    } else {
      void start();
    }
  });
}

function loadFonts(fonts: { family: string; url: string }[]): Promise<void> {
  return Promise.all(
    fonts.map((f) => {
      const face = new FontFace(f.family, `url("${f.url}")`);
      return face
        .load()
        .then((ff) => document.fonts.add(ff))
        .catch(() => {}); // missing font must not block ready
    }),
  ).then(() => {});
}

function preloadAll(urls: string[]): Promise<void> {
  return new Promise((resolve) => {
    let remaining = urls.length;
    if (remaining === 0) return resolve();
    const done = () => {
      remaining--;
      if (remaining === 0) resolve();
    };
    for (const url of urls) {
      const img = new Image();
      img.onload = done;
      img.onerror = done; // missing asset must not block ready
      img.src = url;
    }
  });
}
