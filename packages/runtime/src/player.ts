/**
 * Frame clock. Advances a float playhead at composition fps via
 * requestAnimationFrame and processes markers on every integer frame
 * crossed. Rendered frames are integers (frame-based system, like the
 * editor's timeline).
 *
 * Marker semantics:
 * - pause  → playhead parks exactly on the marker frame; next() resumes.
 * - loop   → playhead jumps to loopToFrame and keeps playing.
 * - action → JS source runs with `this` = the composition API.
 * - outro  → passive; stop() plays from here to the end.
 */

import type { Composition, Marker } from '@riposte/shared';

export interface PlayerHooks {
  onFrame(frame: number): void;
  onEnded(): void;
  runAction(source: string): void;
  /** Playhead parked on a pause marker. */
  onPaused?(frame: number): void;
  /** Playhead crossed an outro marker while playing forward. */
  onOutro?(frame: number): void;
}

export class Player {
  private pos = 0; // float playhead
  private rendered = -1;
  private rafId: number | null = null;
  private lastTs = 0;
  private direction: 1 | -1 = 1;
  private markersByFrame = new Map<number, Marker[]>();

  playing = false;

  private comp: Composition;
  private hooks: PlayerHooks;

  constructor(comp: Composition, hooks: PlayerHooks) {
    this.comp = comp;
    this.hooks = hooks;
    for (const m of comp.markers) {
      const list = this.markersByFrame.get(m.frame) ?? [];
      list.push(m);
      this.markersByFrame.set(m.frame, list);
    }
  }

  get activeFrame(): number {
    return Math.floor(this.pos);
  }

  get duration(): number {
    return this.comp.duration;
  }

  get fps(): number {
    return this.comp.fps;
  }

  goTo(frame: number): void {
    this.stopClock();
    this.pos = clamp(frame, 0, this.comp.duration - 1);
    this.render();
  }

  play(opts: { from?: number; reverse?: boolean } = {}): void {
    this.direction = opts.reverse ? -1 : 1;
    if (opts.from !== undefined) this.pos = clamp(opts.from, 0, this.comp.duration - 1);
    // Process markers on the starting frame itself (except when resuming off
    // a pause — resume() advances past it first).
    this.playing = true;
    this.render();
    this.startClock();
  }

  goToAndPlay(frame: number, opts: { reverse?: boolean } = {}): void {
    this.play({ from: frame, reverse: opts.reverse });
  }

  pause(): void {
    this.playing = false;
    this.stopClock();
  }

  /** Resume past a pause marker; returns false when not paused. */
  resume(): boolean {
    if (this.playing) return false;
    // step off the pause frame so its marker doesn't immediately re-trigger
    this.pos = Math.floor(this.pos) + (this.direction === 1 ? 1 : -1) * 0.001;
    this.playing = true;
    this.startClock();
    return true;
  }

  destroy(): void {
    this.stopClock();
  }

  private startClock(): void {
    if (this.rafId !== null) return;
    this.lastTs = 0;
    const tick = (ts: number) => {
      this.rafId = null;
      if (!this.playing) return;
      if (this.lastTs === 0) this.lastTs = ts;
      const dt = Math.min((ts - this.lastTs) / 1000, 0.25); // clamp tab-stall jumps
      this.lastTs = ts;
      this.advance(dt * this.comp.fps * this.direction);
      if (this.playing) this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopClock(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private advance(delta: number): void {
    const prev = this.pos;
    let next = this.pos + delta;

    if (this.direction === 1) {
      // process every integer frame crossed, in order
      for (let f = Math.floor(prev) + 1; f <= Math.floor(next); f++) {
        const jump = this.processMarkers(f);
        if (jump !== null) {
          next = jump;
          break;
        }
        if (!this.playing) {
          next = f;
          break;
        }
        if (f >= this.comp.duration - 1) {
          this.pos = this.comp.duration - 1;
          this.playing = false;
          this.stopClock();
          this.render();
          this.hooks.onEnded();
          return;
        }
      }
    } else if (next <= 0) {
      this.pos = 0;
      this.playing = false;
      this.stopClock();
      this.render();
      this.hooks.onEnded();
      return;
    }

    this.pos = clamp(next, 0, this.comp.duration - 1);
    this.render();
    if (!this.playing) this.stopClock();
  }

  /** Returns a new float position on loop jump, else null. */
  private processMarkers(frame: number): number | null {
    const markers = this.markersByFrame.get(frame);
    if (!markers) return null;
    for (const m of markers) {
      switch (m.type) {
        case 'action':
          this.hooks.runAction(m.source);
          break;
        case 'pause':
          this.playing = false;
          this.hooks.onPaused?.(frame);
          break;
        case 'loop':
          if (this.direction === 1) return m.loopToFrame;
          break;
        case 'outro':
          if (this.direction === 1) this.hooks.onOutro?.(frame);
          break;
      }
    }
    return null;
  }

  private render(): void {
    const f = this.activeFrame;
    if (f !== this.rendered) {
      this.rendered = f;
      this.hooks.onFrame(f);
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
