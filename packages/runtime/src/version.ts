/**
 * Runtime version — injected at build time from the ROOT package.json (the
 * product version, e.g. 0.4.0), so exported templates report which Riposte
 * built them. 'dev' when running unbundled (editor preview, tests).
 */

declare const __RIPOSTE_VERSION__: string | undefined;

export const RUNTIME_VERSION: string = typeof __RIPOSTE_VERSION__ === 'string' ? __RIPOSTE_VERSION__ : 'dev';
