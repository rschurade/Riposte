/**
 * Scene-level outro effects (OutroPreset): on stop() the scene ROOT is
 * animated with the preset's keyframed properties — every layer at once,
 * regardless of layer structure — then the scene hides. Used by the on-air
 * runtime and by the editor's CG-cycle simulation, which drive the frame
 * clock themselves and call applyOutroFrame per frame.
 */

import type { Composition, OutroPreset } from '@riposte/shared';
import { numberAtFrame } from './interpolate.ts';
import { rectMaskPath } from './dom.ts';

/** Apply the preset's state at `frame` (0 = the stop moment) to the root. */
export function applyOutroFrame(node: HTMLElement, comp: Composition, preset: OutroPreset, frame: number): void {
  const s = preset.style ?? {};
  const num = (prop: string, fallback: number): number => numberAtFrame(s[prop], frame, fallback);

  const opacity = num('opacity', 1);
  node.style.opacity = opacity >= 1 ? '' : String(Math.max(0, opacity));

  const dx = num('x', 0);
  const dy = num('y', 0);
  const sx = num('scaleX', 1);
  const sy = num('scaleY', 1);
  const rot = num('rotation', 0);
  node.style.transformOrigin = `${comp.width / 2}px ${comp.height / 2}px`;
  node.style.transform =
    (dx || dy ? `translate(${dx}px, ${dy}px)` : '') +
    (rot ? ` rotate(${rot}deg)` : '') +
    (sx !== 1 || sy !== 1 ? ` scale(${sx}, ${sy})` : '');

  if (preset.mask) {
    const ms = preset.mask.style;
    node.style.clipPath = rectMaskPath(
      numberAtFrame(ms['x'], frame, comp.width / 2),
      numberAtFrame(ms['y'], frame, comp.height / 2),
      numberAtFrame(ms['width'], frame, 0),
      numberAtFrame(ms['height'], frame, 0),
      numberAtFrame(ms['rotation'], frame, 0),
      preset.mask.inverted === true,
    );
  }
}

/** Remove every style the effect touched — before the next play() cycle. */
export function clearOutroEffect(node: HTMLElement): void {
  node.style.opacity = '';
  node.style.transform = '';
  node.style.transformOrigin = '';
  node.style.clipPath = '';
}

/**
 * Drive the effect (the on-air path). Frames render via rAF, but the clock is
 * wall time and completion is guaranteed by a timeout: rAF freezes entirely in
 * hidden/occluded windows (virtual playout behind ControlCenter), which would
 * otherwise leave the graphic on air forever. Covered window = the effect
 * still completes (worst case it snaps to its end state ~1s late).
 * Returns a cancel function; `onDone` fires once after the last frame.
 */
export function runOutroEffect(node: HTMLElement, comp: Composition, preset: OutroPreset, onDone: () => void): () => void {
  const startMs = performance.now();
  const totalMs = (preset.duration / comp.fps) * 1000;
  let raf = 0;
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    applyOutroFrame(node, comp, preset, preset.duration);
    onDone();
  };
  const tick = (): void => {
    if (done) return;
    const elapsed = ((performance.now() - startMs) / 1000) * comp.fps;
    applyOutroFrame(node, comp, preset, Math.min(preset.duration, elapsed));
    if (elapsed >= preset.duration) finish();
    else raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  const timer = setTimeout(finish, totalMs + 60);
  return () => {
    done = true;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
  };
}
