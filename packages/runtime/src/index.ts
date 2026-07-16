/**
 * @riposte/runtime — the engine that renders a scene document via DOM+CSS
 * and implements the CasparCG template contract. Ships inside every exported
 * template as a single IIFE (`riposte.js`, global `riposte`).
 *
 * Zero runtime dependencies — keep it that way.
 */

export { RUNTIME_VERSION } from './version.ts';

export { createRuntime } from './runtime.ts';
export type { Runtime, RuntimeOptions, CompositionApi } from './runtime.ts';
export { boot } from './boot.ts';
export type { BootOptions } from './boot.ts';
export { buildScene, rectMaskPath } from './dom.ts';
export type { BuiltScene, ElementHandle, BuildOptions } from './dom.ts';
export { applyOutroFrame, clearOutroEffect, runOutroEffect } from './outro.ts';
export { valueAtFrame, numberAtFrame } from './interpolate.ts';
export { cubicBezier } from './bezier.ts';
export { parseUpdateData } from './data.ts';
