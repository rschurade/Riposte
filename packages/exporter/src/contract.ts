/**
 * Mapping-contract check: cross-references a ControlCenter graphics-set
 * config (config/graphics_sets/<name>.json) against the scenes of a Riposte
 * set. The data-binding keys are a naming contract between the two — a break
 * shows up on air as a silently blank or frozen field.
 *
 * Two directions per template:
 * - deadMappings: ControlCenter sends these variables, the template has no
 *   such key — stale/typo'd mappings (updates vanish into the void).
 * - unfilledKeys: the template exposes these keys, no mapping fills them —
 *   often fine (design defaults, keys only other graphics sets use), so
 *   informational.
 */
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SceneDoc, SceneElement, SetDoc } from '@riposte/shared';

export interface ContractSceneReport {
  /** ControlCenter scene entry (Key/Label) and its template name. */
  ccScene: string;
  templateName: string;
  sceneFile: string;
  deadMappings: string[];
  unfilledKeys: string[];
}

export interface ContractReport {
  configFile: string;
  configName: string;
  setName: string;
  /** Templates checked (matched a scene in the set). */
  scenes: ContractSceneReport[];
  /** CC templates with no scene in this set (fine if they live in another set). */
  templatesNotInSet: string[];
  /** Set scenes no CC entry references (fine: variants, WIP). */
  scenesNotReferenced: string[];
  /** Total dead mappings across all checked scenes — the headline number. */
  deadCount: number;
}

interface CcGraphicsSet {
  Name?: string;
  Scenes?: { Key?: string; Label?: string; TemplateName?: string; Mappings?: { CasparVariable?: string }[] }[];
}

/**
 * All update() keys a scene answers to: element keys and visibility bindKeys,
 * recursing into nested compositions (keyed instance → "instKey.childKey";
 * unkeyed instance → child CONTENT keys are unreachable and excluded, but
 * visibility bindKeys merge unprefixed — mirror of the runtime's rules).
 */
export function collectSceneKeys(
  doc: SceneDoc,
  components: Record<string, SceneDoc | null | undefined>,
  depth = 0,
): { content: Set<string>; visibility: Set<string> } {
  const content = new Set<string>();
  const visibility = new Set<string>();
  for (const layer of doc.composition.layers) {
    const el = layer.element as SceneElement & { compositionId?: string };
    if (el.key && el.type !== 'composition') content.add(el.key);
    if (el.visibility?.bindKey) visibility.add(el.visibility.bindKey);
    if (el.type === 'composition' && el.compositionId && depth < 4) {
      const sub = components[el.compositionId];
      if (!sub) continue;
      const subKeys = collectSceneKeys(sub, components, depth + 1);
      if (el.key) {
        for (const k of subKeys.content) content.add(`${el.key}.${k}`);
        for (const k of subKeys.visibility) visibility.add(`${el.key}.${k}`);
      } else {
        for (const k of subKeys.visibility) visibility.add(k);
      }
    }
  }
  return { content, visibility };
}

export async function checkContract(setDir: string, ccConfigFile: string): Promise<ContractReport> {
  const cc = JSON.parse(await readFile(ccConfigFile, 'utf8')) as CcGraphicsSet;
  const set = JSON.parse(await readFile(join(setDir, 'set.json'), 'utf8')) as SetDoc;

  const loadDoc = async (file: string): Promise<SceneDoc | null> => {
    try {
      return JSON.parse(await readFile(join(setDir, file), 'utf8')) as SceneDoc;
    } catch {
      return null;
    }
  };
  const components: Record<string, SceneDoc | null> = {};
  for (const f of set.components ?? []) components[f] = await loadDoc(f);

  // scene basename (lowercase) → file
  const sceneByName = new Map<string, string>();
  for (const f of set.scenes ?? []) {
    sceneByName.set(basename(f).replace(/\.json$/i, '').toLowerCase(), f);
  }

  const report: ContractReport = {
    configFile: ccConfigFile,
    configName: cc.Name ?? basename(ccConfigFile),
    setName: set.name,
    scenes: [],
    templatesNotInSet: [],
    scenesNotReferenced: [],
    deadCount: 0,
  };

  const referenced = new Set<string>();
  for (const ccScene of cc.Scenes ?? []) {
    const template = (ccScene.TemplateName ?? '').trim();
    if (!template) continue;
    const scene = template.split(/[\\/]/).pop()!.replace(/\.html?$/i, '').toLowerCase();
    const file = sceneByName.get(scene);
    if (!file) {
      report.templatesNotInSet.push(template);
      continue;
    }
    referenced.add(file);
    const doc = await loadDoc(file);
    if (!doc) continue;
    const keys = collectSceneKeys(doc, components);
    const mapped = new Set((ccScene.Mappings ?? []).map((m) => m.CasparVariable ?? '').filter(Boolean));
    const answers = (v: string) => keys.content.has(v) || keys.visibility.has(v);
    const dead = [...mapped].filter((v) => !answers(v)).sort();
    const unfilled = [...keys.content].filter((k) => !mapped.has(k)).sort();
    report.scenes.push({
      ccScene: ccScene.Label ?? ccScene.Key ?? '?',
      templateName: template,
      sceneFile: file,
      deadMappings: dead,
      unfilledKeys: unfilled,
    });
    report.deadCount += dead.length;
  }
  report.scenesNotReferenced = (set.scenes ?? []).filter((f) => !referenced.has(f));
  return report;
}
