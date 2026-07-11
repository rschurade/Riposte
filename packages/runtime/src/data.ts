/**
 * Update-payload parsing. CasparCG clients send either JSON
 * (`{"_name":"value"}`) or classic Flash-era templateData XML:
 *
 *   <templateData>
 *     <componentData id="_name"><data id="text" value="SMITH, John"/></componentData>
 *   </templateData>
 *
 * ControlCenter sends the XML form — both MUST work. Parsed with a
 * dependency-free scanner (the format is machine-generated), so this module
 * also runs under Node for tests.
 */

const COMPONENT_RE = /<componentData\b([^>]*)(?:\/>|>([\s\S]*?)<\/componentData>)/g;
const ATTR_ID_RE = /\bid\s*=\s*"([^"]*)"/;
const DATA_VALUE_RE = /<data\b[^>]*?\bvalue\s*=\s*"([^"]*)"/;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m) => {
    const known = ENTITIES[m];
    if (known) return known;
    if (m.startsWith('&#x')) return String.fromCodePoint(parseInt(m.slice(3, -1), 16));
    return String.fromCodePoint(parseInt(m.slice(2, -1), 10));
  });
}

export function parseUpdateData(raw: string | Record<string, unknown>): Record<string, string> {
  if (typeof raw !== 'string') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = v == null ? '' : String(v);
    return out;
  }

  const text = raw.trim();
  if (text.startsWith('<')) return parseTemplateDataXml(text);
  if (text === '') return {};
  return parseUpdateData(JSON.parse(text) as Record<string, unknown>);
}

function parseTemplateDataXml(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  COMPONENT_RE.lastIndex = 0;
  for (let m = COMPONENT_RE.exec(xml); m !== null; m = COMPONENT_RE.exec(xml)) {
    const idMatch = ATTR_ID_RE.exec(m[1] ?? '');
    if (!idMatch) continue;
    const key = decodeEntities(idMatch[1]!);
    const inner = m[2] ?? '';
    const valueMatch = DATA_VALUE_RE.exec(inner);
    out[key] = valueMatch ? decodeEntities(valueMatch[1]!) : '';
  }
  return out;
}
