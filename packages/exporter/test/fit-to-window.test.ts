import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportSet } from '../src/index.ts';

test('HTML export optionally includes Loopic-style fitToWindow scaling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'riposte-fit-window-'));
  try {
    const setDir = join(root, 'set');
    const sceneDir = join(setDir, 'scenes');
    const runtimeJs = join(root, 'riposte.js');
    await mkdir(sceneDir, { recursive: true });
    await writeFile(runtimeJs, 'globalThis.riposte={boot(){}};', 'utf8');
    await writeFile(join(setDir, 'set.json'), JSON.stringify({
      formatVersion: 1,
      name: 'Wide',
      scenes: ['scenes/Wide.json'],
      components: [],
      fonts: [],
      export: { mode: 'external', preloadAssets: true, fitToWindow: true },
    }), 'utf8');
    await writeFile(join(sceneDir, 'Wide.json'), JSON.stringify({
      formatVersion: 1,
      name: 'Wide',
      composition: {
        width: 4608,
        height: 128,
        fps: 30,
        duration: 1,
        markers: [],
        layers: [],
      },
    }), 'utf8');

    const fittedDir = join(root, 'fitted');
    await exportSet(setDir, fittedDir, { runtimeJs });
    const fitted = await readFile(join(fittedDir, 'Wide.html'), 'utf8');
    assert.match(fitted, /function fitToWindow\(\)/);
    assert.match(fitted, /const width = 4608;/);
    assert.match(fitted, /const height = 128;/);
    assert.match(fitted, /Math\.min\(window\.innerWidth \/ width, window\.innerHeight \/ height\)/);
    assert.match(fitted, /window\.addEventListener\('resize', fitToWindow\)/);

    for (const mode of ['baked', 'spx'] as const) {
      const modeDir = join(root, mode);
      await exportSet(setDir, modeDir, { runtimeJs, mode });
      const html = await readFile(join(modeDir, 'Wide.html'), 'utf8');
      assert.match(html, /function fitToWindow\(\)/, `${mode} export should include viewport fitting`);
      if (mode === 'spx') assert.match(html, /SPXGCTemplateDefinition/);
    }

    const fixedDir = join(root, 'fixed');
    await exportSet(setDir, fixedDir, { runtimeJs, fitToWindow: false });
    const fixed = await readFile(join(fixedDir, 'Wide.html'), 'utf8');
    assert.doesNotMatch(fixed, /function fitToWindow\(\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
