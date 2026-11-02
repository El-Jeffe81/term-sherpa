'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const TCFrames = require('../extension/core/frames.js');

const top = (extra) => ({ frameId: 0, result: Object.assign({ ok: true, page: { url: 'https://news.example.test/story', title: 'Story' }, links: [], extracted: null, consent: { found: false, kind: null, buttons: [], links: [] }, frames: [] }, extra || {}) });
const consentFrame = (id, url, links) => ({ frameId: id, result: { ok: true, page: { url, is_frame: true }, links: links || [], extracted: null, consent: { found: true, kind: 'banner', buttons: ['Accept'], links: [{ url: 'https://cmp.example.test/privacy', text: 'Privacy policy', doc_type: 'privacy' }] } } });

test('frames: the top frame wins when it already has a consent box or terms text', () => {
  const t = top({ consent: { found: true, kind: 'dialog', buttons: ['Agree'], links: [{ url: 'https://news.example.test/terms', text: 'Terms' }] } });
  const c = TCFrames.combine([t, consentFrame(3, 'https://cmp.example.test/frame')]);
  assert.equal(c.fromFrame, null);
  assert.equal(c.res.consent.links[0].url, 'https://news.example.test/terms');
  const e = TCFrames.combine([top({ extracted: { text: 'x', url: 'https://news.example.test/story' } }), consentFrame(3, 'https://cmp.example.test/frame')]);
  assert.equal(e.fromFrame, null); assert.equal(e.res.extracted.text, 'x');
});

test('frames: a consent box inside an iframe is used when the top page has none, and says where it came from', () => {
  const c = TCFrames.combine([top(), consentFrame(5, 'https://cmp.example.test/frame')]);
  assert.deepEqual(c.fromFrame, { host: 'cmp.example.test', url: 'https://cmp.example.test/frame', what: 'consent' });
  assert.equal(c.res.consent.found, true);
  assert.equal(c.res.consent.links[0].url, 'https://cmp.example.test/privacy');
  assert.equal(c.res.page.url, 'https://news.example.test/story', 'the page itself is still the top page');
});

test('frames: terms text inside a frame is used only when nothing better exists; a consent box beats terms text', () => {
  const termsFrame = { frameId: 2, result: { ok: true, page: { url: 'https://x.example.test/t', is_frame: true, doc_type: 'tos' }, links: [], extracted: { text: 'terms', url: 'https://x.example.test/t', doc_type: 'tos' }, consent: { found: false, links: [], buttons: [] } } };
  const a = TCFrames.combine([top(), termsFrame]);
  assert.equal(a.fromFrame.what, 'terms'); assert.equal(a.res.extracted.text, 'terms'); assert.equal(a.res.page.looks_like_terms, true);
  const b = TCFrames.combine([top(), termsFrame, consentFrame(9, 'https://cmp.example.test/f')]);
  assert.equal(b.fromFrame.what, 'consent'); assert.equal(b.res.extracted, null);
});

test('frames: legal links from frames are merged without duplicates', () => {
  const l = (u) => ({ url: u, text: u });
  const c = TCFrames.combine([top({ links: [l('https://a.test/1')] }), consentFrame(1, 'https://cmp.example.test/f', [l('https://a.test/1'), l('https://a.test/2')])]);
  assert.deepEqual(c.res.links.map((x) => x.url), ['https://a.test/1', 'https://a.test/2']);
});

test('frames: iframes that look like a consent box but were not entered are reported (one per site, capped); read ones are not', () => {
  const fr = [
    { src: 'https://cmp.example.test/a', likely: true }, { src: 'https://cmp.example.test/b', likely: true }, // same site twice -> once
    { src: 'https://ads.example.test/x', likely: false },                                                    // not consent-looking -> never mentioned
    { src: 'https://read.example.test/f', likely: true },                                                    // we got into this one
    { src: 'http://plain.example.test/f', likely: true }, { src: 'https://o1.test/', likely: true }, { src: 'https://o2.test/', likely: true }, { src: 'javascript:x', likely: true }
  ];
  const c = TCFrames.combine([top({ frames: fr }), { frameId: 4, result: { ok: true, page: { url: 'https://read.example.test/f', is_frame: true }, links: [], extracted: null, consent: { found: false, links: [], buttons: [] } } }]);
  assert.deepEqual(c.unreadable.map((u) => u.host), ['cmp.example.test', 'plain.example.test', 'o1.test']);
  assert.deepEqual(TCFrames.originPatterns(c.unreadable), ['https://cmp.example.test/*', 'https://o1.test/*'], 'only https sites can be asked for');
});

test('frames: a failed top result is passed through; no results at all is handled', () => {
  const bad = { frameId: 0, result: { ok: false, error: 'boom' } };
  assert.equal(TCFrames.combine([bad]).res.error, 'boom');
  assert.equal(TCFrames.combine([]).res, null);
  assert.equal(TCFrames.combine(undefined).res, null);
});
