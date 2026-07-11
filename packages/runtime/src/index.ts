/**
 * @riposte/runtime — the engine that renders a scene document via DOM+CSS
 * and implements the CasparCG template contract. Ships inside every exported
 * template as a single IIFE (`riposte.js`, global `riposte`).
 *
 * Zero runtime dependencies — keep it that way.
 */

export const RUNTIME_VERSION = '0.1.0';

export { createRuntime } from './runtime.ts';
export type { Runtime, RuntimeOptions, CompositionApi } from './runtime.ts';
export { boot } from './boot.ts';
export type { BootOptions } from './boot.ts';
export { buildScene } from './dom.ts';
export type { BuiltScene, ElementHandle, BuildOptions } from './dom.ts';
export { valueAtFrame, numberAtFrame } from './interpolate.ts';
export { cubicBezier } from './bezier.ts';
export { parseUpdateData } from './data.ts';
