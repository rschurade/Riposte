/**
 * @riposte/runtime — the engine that renders a scene document via DOM+CSS
 * and implements the CasparCG template contract. Ships inside every exported
 * template as a single IIFE (`riposte.js`, global `riposte`).
 *
 * Zero runtime dependencies — keep it that way.
 */

import type { SceneDoc } from '@riposte/shared';

export const RUNTIME_VERSION = '0.1.0';

export interface Runtime {
  /** Accepts JSON or `<templateData>` XML (ControlCenter sends XML). */
  update(data: string | Record<string, string>): void;
  play(): void;
  /** Plays from the outro marker to the end. */
  stop(): void;
  /** Resumes past the current pause marker. */
  next(): void;
  /** AMCP INVOKE dispatch. */
  invoke(name: string, ...args: unknown[]): void;
}

/**
 * Phase 1: keyframe interpolation + bezier easing, markers, masks, text
 * auto-squeeze, image-loader fit modes, middleware pipelines
 * (useOnPlay/useOnUpdate/useOnStop/useOnInvoke — Loopic-compatible names).
 */
export function createRuntime(_scene: SceneDoc, _root: HTMLElement): Runtime {
  throw new Error('not implemented yet (phase 1)');
}
