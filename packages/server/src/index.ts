/**
 * @riposte/server — local Node server. Runs TypeScript natively (Node ≥ 24).
 *
 * Will host the built editor and expose the file API: open/save set projects,
 * asset upload with content-hash dedup, export. For now: a liveness stub.
 */

import { createServer } from 'node:http';

const port = Number(process.env['PORT'] ?? 5720);

createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ name: 'riposte-server', version: '0.1.0', status: 'scaffold' }));
}).listen(port, () => {
  console.log(`riposte server listening on http://localhost:${port}`);
});
