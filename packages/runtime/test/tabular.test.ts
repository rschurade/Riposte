import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxDigits } from '../src/dom.ts';

test('wraps every digit in a fixed-width box, leaves other chars alone', () => {
  const out = boxDigits('1:23', 0.5);
  assert.equal(out.match(/<span/g)?.length, 3);
  assert.ok(out.includes('width:0.5000em'));
  assert.ok(!out.includes('>:</span>')); // colon not wrapped in a box
  assert.ok(/>1<\/span>:/.test(out)); // colon sits between boxes at natural width
});

test('digits inside HTML tags are untouched', () => {
  const out = boxDigits('<b class="x1">7</b>', 0.6);
  assert.ok(out.includes('class="x1"')); // attribute digit untouched
  assert.equal(out.match(/<span/g)?.length, 1); // only the visible 7
});

test('non-digit content passes through unchanged', () => {
  assert.equal(boxDigits('SMITH, John', 0.5), 'SMITH, John');
});
