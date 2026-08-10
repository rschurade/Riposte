/**
 * End-to-end OGraf lifecycle test: loads an exported OGraf graphic in headless
 * Chromium and drives the EBU lifecycle (load → playAction → updateAction →
 * playAction(delta) → stopAction), asserting promise resolutions and step values.
 *
 * Usage: node --experimental-strip-types packages/exporter/test/ograf-lifecycle.mjs <ograf-export-dir>
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const dir = resolve(process.argv[2] ?? '');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };

const server = createServer(async (req, res) => {
  try {
    const path = join(dir, decodeURIComponent((req.url ?? '/').split('?')[0]));
    const data = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('nf');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const scene = process.argv[3] ?? 'Schedule';
// Two text data keys the target scene actually binds (defaults suit a scene
// with _name1/_name2, e.g. the demo Schedule) — override via env for other sets.
const KEY1 = process.env['RIPOSTE_TEST_KEY1'] ?? '_name1';
const KEY2 = process.env['RIPOSTE_TEST_KEY2'] ?? '_name2';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setViewportSize({ width: 1920, height: 1080 });

page.on('console', (m) => console.log('BROWSER:', m.text()));
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

await page.setContent(`<!doctype html><html><body><div id="host"></div>
<script type="module">
  const mod = await import('http://localhost:${port}/${scene}/graphic.mjs');
  customElements.define('ograf-test', mod.default);
  const el = document.createElement('ograf-test');
  document.getElementById('host').appendChild(el);
  window.__g = el;
  window.__zeroStep = ${process.argv[4] === 'zero-step' ? 'true' : 'false'};
  window.__keys = ${JSON.stringify([KEY1, KEY2])};
  window.__log = [];
</script>`);

await page.waitForFunction('window.__g !== undefined', { timeout: 15000 });

const results = await page.evaluate(async () => {
  const g = window.__g;
  const out = [];
  const t = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  const zeroStep = window.__zeroStep === true;
  const [key1, key2] = window.__keys;

  // load
  const lr = await g.load({ data: { [key1]: 'UPDATED NAME', [key2]: 'LIFECYCLE TEST' }, renderType: 'realtime' });
  t('load resolves', lr?.statusCode === 200);

  if (zeroStep) {
    // fire-and-forget: playAction plays the whole scene, resolves on end
    const t0 = performance.now();
    const p = await g.playAction({ goto: 0 });
    const ms = Math.round(performance.now() - t0);
    t('zero-step playAction resolves at end', p?.statusCode === 200 && p?.currentStep === undefined, `${ms}ms`);
    const rr = g.firstElementChild?.firstElementChild;
    t('hidden after end', !!rr && getComputedStyle(rr).visibility === 'hidden');
    const s = await g.stopAction({});
    t('stopAction after end resolves', s?.statusCode === 200);
    await g.dispose();
    t('dispose resolves', true);
    return out;
  }

  // playAction goto 0 → should park at pause (currentStep 0)
  const p0 = await g.playAction({ goto: 0 });
  t('playAction({goto:0}) parks at step 0', p0?.statusCode === 200 && p0?.currentStep === 0, JSON.stringify(p0));

  // DOM shows the graphic and the updated data
  const txt = g.textContent ?? '';
  t('updated data rendered', txt.includes('UPDATED NAME') && txt.includes('LIFECYCLE TEST'));

  // updateAction
  const ur = await g.updateAction({ data: { [key1]: 'SECOND UPDATE' } });
  t('updateAction resolves', ur?.statusCode === 200);
  t('update rendered', (g.textContent ?? '').includes('SECOND UPDATE'));

  // playAction delta 1 with only 1 pause → target >= stepCount → to end
  const p1 = await g.playAction({ delta: 1 });
  t('playAction past last step → ends (currentStep undefined)', p1?.statusCode === 200 && p1?.currentStep === undefined, JSON.stringify(p1));

  // after end, the runtime root (inside the bridge content root) should be hidden
  const runtimeRoot = g.firstElementChild?.firstElementChild;
  const hidden = runtimeRoot && getComputedStyle(runtimeRoot).visibility === 'hidden';
  t('graphic hidden after end', !!hidden);

  // replay + skipAnimation
  const p2 = await g.playAction({ goto: 0, skipAnimation: true });
  t('playAction skipAnimation parks instantly at step 0', p2?.statusCode === 200 && p2?.currentStep === 0);

  // stopAction with skipAnimation → instant hide
  const sr = await g.stopAction({ skipAnimation: true });
  t('stopAction skipAnimation resolves', sr?.statusCode === 200);

  // customAction on unknown id → 400
  const cr = await g.customAction({ id: 'doesNotExist', payload: {} });
  t('customAction resolves (200 or handled)', cr?.statusCode === 200 || cr?.statusCode === 400);

  await g.dispose();
  t('dispose resolves', true);
  return out;
});

for (const r of results) console.log(r);
await browser.close();
server.close();
const failed = results.filter((r) => r.startsWith('FAIL'));
process.exit(failed.length ? 1 : 0);
