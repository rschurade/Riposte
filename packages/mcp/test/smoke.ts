/**
 * Manual smoke test — requires the Riposte server on :5720.
 * Run: node packages/mcp/test/smoke.ts
 */
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, '..', 'src', 'index.ts');

const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverEntry] }));

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

const asText = (r: unknown): string => {
  const c = (r as { content: { type: string; text?: string }[] }).content;
  return c.find((x) => x.type === 'text')?.text ?? '';
};

console.log('list_sets:', asText(await client.callTool({ name: 'list_sets', arguments: {} })));
console.log(
  'list_scenes(demo):',
  asText(await client.callTool({ name: 'list_scenes', arguments: { set: 'demo' } })),
);

// edit + verify + revert on the committed demo set
const edit = await client.callTool({
  name: 'set_element',
  arguments: { set: 'demo', scene: 'Schedule', element: '_noc1', props: { content: 'GER' } },
});
console.log('set_element:', asText(edit));

const render = await client.callTool({ name: 'render_scene', arguments: { set: 'demo', scene: 'Schedule' } });
const img = (render as { content: { type: string; data?: string }[] }).content.find((c) => c.type === 'image');
console.log('render_scene: image bytes =', img?.data ? Math.round((img.data.length * 3) / 4) : 'MISSING');

const revert = await client.callTool({
  name: 'set_element',
  arguments: { set: 'demo', scene: 'Schedule', element: '_noc1', props: { content: 'NOC' } },
});
console.log('revert:', asText(revert));

await client.close();
