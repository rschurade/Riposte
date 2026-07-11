import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUpdateData, decodeEntities } from '../src/data.ts';

test('JSON string payload', () => {
  assert.deepEqual(parseUpdateData('{"_name":"SMITH, John","_score":"5"}'), {
    _name: 'SMITH, John',
    _score: '5',
  });
});

test('object payload stringifies values', () => {
  assert.deepEqual(parseUpdateData({ _a: 1, _b: null, _c: 'x' }), { _a: '1', _b: '', _c: 'x' });
});

test('templateData XML (ControlCenter format)', () => {
  const xml =
    '<templateData>' +
    '<componentData id="_leftName"><data id="text" value="SMITH, John"/></componentData>' +
    '<componentData id="_rightName"><data id="text" value="M&#220;LLER, Max"/></componentData>' +
    '</templateData>';
  assert.deepEqual(parseUpdateData(xml), {
    _leftName: 'SMITH, John',
    _rightName: 'MÜLLER, Max',
  });
});

test('XML entities and empty component data', () => {
  const xml =
    '<templateData>' +
    '<componentData id="_t"><data value="A &amp; B &lt;3&gt; &quot;q&quot;"/></componentData>' +
    '<componentData id="_empty"/>' +
    '</templateData>';
  assert.deepEqual(parseUpdateData(xml), { _t: 'A & B <3> "q"', _empty: '' });
});

test('whitespace between XML nodes tolerated', () => {
  const xml = `
    <templateData>
      <componentData id="_x">
        <data id="text" value="ok"/>
      </componentData>
    </templateData>`;
  assert.deepEqual(parseUpdateData(xml), { _x: 'ok' });
});

test('empty string yields empty object', () => {
  assert.deepEqual(parseUpdateData(''), {});
});

test('decodeEntities handles numeric forms', () => {
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
});
