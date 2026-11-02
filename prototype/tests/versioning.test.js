'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../extension/core/versioning');

test('sha256 known vectors', async () => {
  assert.equal(await V.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await V.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
test('normalizeText: CRLF, trailing spaces, blank-line runs', () => {
  assert.equal(V.normalizeText('a  \r\n\r\n\r\n\r\nb \n'), 'a\n\nb');
});
test('normalizeUrl drops the fragment only', () => {
  assert.equal(V.normalizeUrl('https://A.test/terms?x=1#sec2'), 'https://a.test/terms?x=1');
});
test('lineDiff counts and renders changes with context', () => {
  const a = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'].join('\n');
  const b = ['l1', 'l2', 'l3', 'l4', 'CHANGED', 'l6', 'l7', 'l8', 'l9', 'l10', 'NEW'].join('\n');
  const d = V.lineDiff(a, b, 1);
  assert.equal(d.added, 2); assert.equal(d.removed, 1);
  assert.match(d.text, /- l5\n\+ CHANGED/);
  assert.match(d.text, /\+ NEW/);
  assert.ok(!d.text.includes('l1\n'), 'far-away lines omitted');
});
test('decide: new / unchanged / changed', async () => {
  const h = async (t) => ({ sha256: await V.sha256Hex(t), text: t });
  const v1 = await h('one\ntwo'), v2 = await h('one\nthree');
  assert.equal(V.decide(null, v1).status, 'new');
  assert.equal(V.decide(v1, v1).status, 'unchanged');
  const c = V.decide(v1, v2);
  assert.equal(c.status, 'changed');
  assert.equal(c.added, 1); assert.equal(c.removed, 1);
  assert.match(c.diff_from_prev, /- two\n\+ three/);
});
