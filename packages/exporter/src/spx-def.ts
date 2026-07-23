/**
 * SPX template definition generation: builds a `window.SPXGCTemplateDefinition`
 * from a Riposte scene's data-binding keys. The definition tells the SPX
 * controller what fields to show in its UI and how to play out the template.
 *
 * SPX parses templates by loading the HTML into JSDOM, executing scripts,
 * and reading `dom.window.SPXGCTemplateDefinition`. No hidden divs or
 * special bridge scripts are needed — the Riposte runtime already handles
 * `window.update()` / `window.play()` / `window.stop()` / `window.next()`
 * natively.
 */

import type { CompositionElement, SceneDoc, SceneElement, SetDoc } from '@riposte/shared';

export interface SpxDataField {
  field?: string;
  ftype: 'textfield' | 'textarea' | 'number' | 'filelist' | 'dropdown' | 'instruction' | 'hidden';
  title?: string;
  value?: string;
  assetfolder?: string;
  extension?: string;
  items?: { text: string; value: string }[];
}

export interface SpxTemplateDefinition {
  description: string;
  playserver: string;
  playchannel: string;
  playlayer: string;
  webplayout: string;
  out: string;
  uicolor: string;
  steps?: number;
  DataFields: SpxDataField[];
}

/** Derive a human-readable label from a data-binding key name. */
function humanLabel(key: string): string {
  return key
    .replace(/^_/, '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Walk a scene (recursing into nested compositions) and collect all
 * data-binding keys mapped to their element types. Returns a map of
 * key → { ftype, defaultValue }.
 */
function collectKeyTypes(
  doc: SceneDoc,
  components: Record<string, SceneDoc | null>,
  depth = 0,
): Map<string, { ftype: SpxDataField['ftype']; value: string; title: string }> {
  const keys = new Map<string, { ftype: SpxDataField['ftype']; value: string; title: string }>();

  const add = (key: string | undefined, ftype: SpxDataField['ftype'], value: string): void => {
    if (!key || keys.has(key)) return;
    keys.set(key, { ftype, value, title: humanLabel(key) });
  };

  for (const layer of doc.composition.layers) {
    const el = layer.element as SceneElement & { compositionId?: string };

    // content keys
    if (el.key && el.type !== 'composition') {
      switch (el.type) {
        case 'text':
          add(el.key, 'textfield', (doc.previewData?.[el.key] as string) ?? el.content ?? '');
          break;
        case 'imageLoader':
          add(el.key, 'filelist', (doc.previewData?.[el.key] as string) ?? '');
          break;
        default:
          add(el.key, 'textfield', (doc.previewData?.[el.key] as string) ?? '');
      }
    }

    // visibility bindKeys — add as dropdown (on/off) unless already covered
    if (el.visibility?.bindKey && !keys.has(el.visibility.bindKey)) {
      keys.set(el.visibility.bindKey, {
        ftype: 'dropdown',
        value: '', // visibility bindKeys aren't held in previewData as data values
        title: humanLabel(el.visibility.bindKey),
      });
    }

    // recurse into nested compositions
    if (el.type === 'composition' && (el as CompositionElement).compositionId && depth < 4) {
      const sub = components[(el as CompositionElement).compositionId];
      if (!sub) continue;
      const subKeys = collectKeyTypes(sub, components, depth + 1);
      for (const [k, info] of subKeys) {
        const prefixedKey = el.key ? `${el.key}.${k}` : k;
        if (!keys.has(prefixedKey)) keys.set(prefixedKey, info);
      }
    }
  }

  return keys;
}

export function generateSpxDef(
  scene: SceneDoc,
  components: Record<string, SceneDoc | null>,
  _set: SetDoc,
  configuredFields?: { field?: string; ftype: string; title?: string; value?: string }[],
): SpxTemplateDefinition {
  const markers = scene.composition.markers ?? [];
  const hasPauses = markers.some((m) => m.type === 'pause');
  const hasOutro = markers.some((m) => m.type === 'outro') || scene.outro != null;
  const pauseCount = markers.filter((m) => m.type === 'pause').length;

  // out: "manual" when operator must call stop(), else auto-duration in ms
  const out = hasPauses || hasOutro
    ? 'manual'
    : String(Math.round((scene.composition.duration / scene.composition.fps) * 1000));

  const keyTypes = configuredFields ? null : collectKeyTypes(scene, components);
  const dataFields: SpxDataField[] = [];

  if (configuredFields) {
    dataFields.push(...configuredFields.filter((f) => f.field || f.ftype === 'instruction') as SpxDataField[]);
  } else {
    for (const [key, info] of keyTypes!) {
      if (info.ftype === 'dropdown') {
      dataFields.push({
        field: key,
        ftype: 'dropdown',
        title: info.title,
        value: info.value,
        items: [
          { text: 'Off', value: '0' },
          { text: 'On', value: '1' },
        ],
      });
    } else if (info.ftype === 'filelist') {
      dataFields.push({
        field: key,
        ftype: 'filelist',
        title: info.title,
        assetfolder: './',
        extension: 'png',
        value: info.value,
      });
    } else {
      dataFields.push({
        field: key,
        ftype: info.ftype,
        title: info.title,
        value: info.value,
      });
    }
    }
  }

  // If no fields, add an instruction field so the SPX UI isn't empty
  if (dataFields.length === 0) {
    dataFields.push({
      ftype: 'instruction',
      value: 'No editable fields — this scene has no data-binding keys.',
    });
  }

  const def: SpxTemplateDefinition = {
    description: scene.name,
    playserver: 'OVERLAY',
    playchannel: '1',
    playlayer: '5',
    webplayout: '5',
    out,
    uicolor: '3',
    DataFields: dataFields,
  };

  if (pauseCount > 0) {
    def.steps = pauseCount + 1;
  }

  return def;
}

/** Serialize the definition as a script tag for injection into <head>. */
export function spxDefScript(def: SpxTemplateDefinition): string {
  return `<script>
    window.SPXGCTemplateDefinition = ${JSON.stringify(def)};
  </script>`;
}
