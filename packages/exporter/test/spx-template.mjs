/**
 * SPX template functional test: loads an exported SPX template in headless
 * Chromium, simulates the SPX renderer (sets window.spxData, calls play()),
 * and asserts the data reaches the Riposte graphic.
 *
 * Usage: node --experimental-strip-types packages/exporter/test/spx-template.mjs <spx-export-dir> <TemplateName>
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const dir = resolve(process.argv[2] ?? '');
const name = process.argv[3] ?? '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };

const server = createServer(async (req, res) => {
  try {
    const path = join(dir, decodeURIComponent((req.url ?? '/').split('?')[0]));
    const data = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('nf');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setViewportSize({ width: 1920, height: 1080 });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

const results = [];
const t = (name2, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name2}${extra ? ' — ' + extra : ''}`);

// A text data key the target scene actually binds (default suits the demo
// Schedule) — override via RIPOSTE_TEST_KEY1 for other sets.
const KEY1 = process.env['RIPOSTE_TEST_KEY1'] ?? '_name1';

// SPX renderer behavior: spxData set BEFORE the template loads (JSON dataformat)
await page.addInitScript((key) => {
  window.spxData = { [key]: 'SPX INJECTED TITLE' };
}, KEY1);

await page.goto(`http://localhost:${port}/${name}.html`, { waitUntil: 'load', timeout: 20000 });

// 1. Template definition present and readable (what SPX's JSDOM parser reads)
const def = await page.evaluate(() => window.SPXGCTemplateDefinition);
t('SPXGCTemplateDefinition present', !!def);
t('dataformat is json', def?.dataformat === 'json');
t('has DataFields', Array.isArray(def?.DataFields) && def.DataFields.length > 0);

// 2. Contract functions registered by riposte.boot()
const fns = await page.evaluate(() => ['update', 'play', 'stop', 'next'].map((f) => typeof window[f]));
t('update/play/stop/next registered', fns.every((f) => f === 'function'), fns.join(','));

// 3. play() → bridge flushes spxData into the graphic
await page.evaluate(() => window.play());
await page.waitForTimeout(600); // let the in-animation reach the pause
const afterPlay = await page.evaluate(() => document.body.textContent ?? '');
t('spxData flushed on play', afterPlay.includes('SPX INJECTED TITLE'));

// 4. CG UPDATE path (CasparCG playout) — window.update with JSON
await page.evaluate((key) => window.update(JSON.stringify({ [key]: 'CG UPDATE VALUE' })), KEY1);
await page.waitForTimeout(150);
const afterUpdate = await page.evaluate(() => document.body.textContent ?? '');
t('window.update passes through', afterUpdate.includes('CG UPDATE VALUE'));

// 5. stop() hides the graphic
await page.evaluate(() => window.stop());
await page.waitForTimeout(1200);
const hidden = await page.evaluate(() => {
  // riposte.boot appends its root div to body — script tags are siblings
  const root = document.querySelector('body > div');
  return root && getComputedStyle(root).visibility === 'hidden';
});
t('stop() hides the graphic', !!hidden);

for (const r of results) console.log(r);
await browser.close();
server.close();
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
