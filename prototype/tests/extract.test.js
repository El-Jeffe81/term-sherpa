'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../extension/core/extract');
const D = require('../extension/core/detect');
const { parseHtml, decodeEntities } = require('../cli/src/htmltree');
const { read } = require('./helpers/server');

const extract = (f) => E.extractMainText(parseHtml(read(f)));

test('extracts the document and drops chrome, banners, scripts and account info', () => {
  const r = extract('acme/terms.html');
  assert.equal(r.h1, 'Terms of Service');
  assert.match(r.text, /^# Terms of Service/);
  assert.match(r.text, /Paid plans renew automatically each month/);
  assert.match(r.text, /terms & all applicable laws/, 'entities decoded');
  for (const bad of ['jane.doe@example.test', 'Accept all', 'should never be extracted', "track('page')", 'My account', 'Pricing', 'Blog']) {
    assert.ok(!r.text.includes(bad), 'must not contain: ' + bad);
  }
  assert.ok(!r.text.includes('Cookie Policy |'), 'footer links dropped');
});

test('renders lists and tables readably', () => {
  const r = extract('acme/terms.html');
  assert.match(r.text, /- Be kind\n- Obey the law/);
  assert.match(r.text, /Plan \| Price\nBasic \| Free\nPlus \| \u20ac5 \/ month/);
});

test('works without <main>/<article> (div soup) and drops the topbar', () => {
  const r = extract('divsoup/privacy.html');
  assert.match(r.text, /^# Privacy Notice/);
  assert.match(r.text, /We do not sell personal data/);
  assert.ok(!r.text.includes('Shop'));
});

test('lenient fallback when a cookie-ish wrapper would swallow the whole document', () => {
  const r = extract('cookiewrap/cookies.html');
  assert.equal(r.strict, false);
  assert.match(r.text, /Essential cookies/);
});

test('hidden elements are skipped; inline display:none too', () => {
  const html = '<html><body><main><h1>Terms</h1><p>Visible clause.</p><p hidden>Hidden A</p><p style="display: none">Hidden B</p><p aria-hidden="true">Hidden C</p></main></body></html>';
  const r = E.extractMainText(parseHtml(html));
  assert.match(r.text, /Visible clause/);
  assert.ok(!/Hidden/.test(r.text));
});

test('deterministic: same input gives identical output', () => {
  assert.equal(extract('acme/privacy.html').text, extract('acme/privacy.html').text);
});

test('entity decoding and tolerant parsing', () => {
  assert.equal(decodeEntities('a &amp; b &#169; &#x2014; &bogus;'), 'a & b \u00a9 \u2014 &bogus;');
  const t = parseHtml('<p>one<p>two<ul><li>a<li>b</ul><!-- c --><br/>');
  const r = E.extractMainText(t);
  assert.equal(r.text, 'one\n\ntwo\n\n- a\n- b');
});

test('page classification of fixtures', () => {
  for (const [f, url, type] of [['acme/terms.html', 'https://a.test/terms', 'tos'], ['acme/privacy.html', 'https://a.test/privacy', 'privacy'],
    ['acme/eula.html', 'https://a.test/eula', 'eula'], ['acme/cookies.html', 'https://a.test/cookies', 'cookies']]) {
    const r = extract(f);
    const c = D.classifyPage({ url, title: r.title, h1: r.h1, textLength: r.text.length });
    assert.equal(c.isTerms, true, f);
    assert.equal(c.doc_type, type, f);
  }
  const n = extract('acme/not-terms.html');
  assert.equal(D.classifyPage({ url: 'https://a.test/news', title: n.title, h1: n.h1, textLength: n.text.length }).isTerms, false);
});
