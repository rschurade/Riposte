import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateVisibility } from '../src/runtime.ts';

test('default condition hides on "0" only', () => {
  const b = { bindKey: '_x' };
  assert.equal(evaluateVisibility(b, '0'), false);
  assert.equal(evaluateVisibility(b, '1'), true);
  assert.equal(evaluateVisibility(b, ''), true);
  assert.equal(evaluateVisibility(b, 'anything'), true);
});

test('showWhen is a whitelist', () => {
  const b = { bindKey: '_p', showWhen: ['2', '3'] };
  assert.equal(evaluateVisibility(b, '2'), true);
  assert.equal(evaluateVisibility(b, '3'), true);
  assert.equal(evaluateVisibility(b, '1'), false);
  assert.equal(evaluateVisibility(b, 'x'), false);
});

test('hideWhen is a blacklist', () => {
  const b = { bindKey: '_x', hideWhen: ['0', 'off'] };
  assert.equal(evaluateVisibility(b, 'off'), false);
  assert.equal(evaluateVisibility(b, 'on'), true);
});

test('undefined value falls back to initial', () => {
  assert.equal(evaluateVisibility({ bindKey: '_x' }, undefined), true);
  assert.equal(evaluateVisibility({ bindKey: '_x', initial: 'hidden' }, undefined), false);
  // initial wins over conditions until the key arrives
  assert.equal(evaluateVisibility({ bindKey: '_x', showWhen: ['1'], initial: 'hidden' }, undefined), false);
});
