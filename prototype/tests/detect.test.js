'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../extension/core/detect');
const E = require('../extension/core/extract');
const { parseHtml } = require('../cli/src/htmltree');
const { read } = require('./helpers/server');

const base = 'https://shop.example.test/signup';
const one = (text, href, region) => D.classifyLink({ text, href, region }, base);

test('link text classification', () => {
  assert.equal(one('Terms of Service', '/x1').doc_type, 'tos');
  assert.equal(one('Terms & Conditions', '/x2').doc_type, 'tos');
  assert.equal(one('Privacy Policy', '/x3').doc_type, 'privacy');
  assert.equal(one('Your privacy choices', '/x4').doc_type, 'privacy');
  assert.equal(one('End User License Agreement', '/x5').doc_type, 'eula');
  assert.equal(one('EULA', '/x6').doc_type, 'eula');
  assert.equal(one('Cookie settings', '/x7').doc_type, 'cookies');
  assert.equal(one('Terms & Privacy', '/x8').doc_type, 'other', 'combined link is ambiguous');
  assert.equal(one('Pricing', '/pricing'), null);
});

test('href patterns and common paths, with empty link text', () => {
  assert.equal(one('', '/legal/terms-of-service').doc_type, 'tos');
  assert.equal(one('', '/privacy-policy').doc_type, 'privacy');
  assert.equal(one('', '/policies/cookie-policy.html').doc_type, 'cookies');
  assert.equal(one('', 'https://other.example.test/eula/').doc_type, 'eula');
  assert.equal(one('', '/privacy').reasons.includes('common path'), true);
});

test('does not match look-alikes, headlines, non-http or off-topic paths', () => {
  assert.equal(one('Read more', '/news/privacy-bill-passes'), null);
  assert.equal(one('Privacy bill passes parliament after long debate and many amendments by the house', '/x9'), null, 'long headline');
  assert.equal(one('Contact', 'mailto:legal@example.test'), null);
  assert.equal(one('Terms', 'javascript:void(0)'), null);
  assert.equal(one('', '/determs/rules'), null);
  assert.equal(one('', '/privacyfoo'), null);
});

test('confidence: footer + text + path is high; href only is low', () => {
  assert.equal(one('Terms', '/terms', 'footer').confidence, 'high');
  assert.equal(one('', '/policies/tos').confidence, 'low');
});

test('findLegalLinks de-duplicates, skips the page itself and orders by type', () => {
  const links = D.findLegalLinks([
    { text: 'Privacy', href: '/privacy', region: 'body' },
    { text: 'Privacy Policy', href: '/privacy#top', region: 'footer' },
    { text: 'Terms', href: '/terms', region: 'footer' },
    { text: 'Terms', href: '/signup', region: 'footer' } // this very page
  ], base);
  assert.deepEqual(links.map((l) => [l.doc_type, l.url]), [['tos', 'https://shop.example.test/terms'], ['privacy', 'https://shop.example.test/privacy']]);
  assert.equal(links[1].text, 'Privacy Policy', 'keeps the best-scoring variant');
});

test('classifyPage: path or strict title, with enough text', () => {
  assert.deepEqual(D.classifyPage({ url: 'https://a.test/terms', title: '', h1: '', textLength: 900 }).doc_type, 'tos');
  assert.equal(D.classifyPage({ url: 'https://a.test/terms', title: '', h1: '', textLength: 100 }).isTerms, false, 'too little text');
  assert.equal(D.classifyPage({ url: 'https://a.test/page', title: 'Sign up - terms apply', h1: 'Join us', textLength: 5000 }).isTerms, false);
  assert.equal(D.classifyPage({ url: 'https://a.test/page', title: 'Privacy Policy | A', h1: '', textLength: 3000 }).doc_type, 'privacy');
  assert.equal(D.classifyPage({ url: 'https://a.test/legal', title: 'Cookie Policy', h1: 'Cookie Policy', textLength: 900 }).doc_type, 'cookies');
});

test('fixture: signup page -> candidate links (no false positive article link)', () => {
  const tree = parseHtml(read('acme/index.html'));
  const links = D.findLegalLinks(E.collectLinks(tree), 'https://acme.test/signup');
  assert.deepEqual(links.map((l) => l.doc_type), ['tos', 'privacy', 'eula', 'cookies']);
  assert.ok(!links.some((l) => /news/.test(l.url)));
  assert.ok(links.every((l) => l.url.startsWith('https://acme.test/')));
});

test('fixture: page with no legal links yields an empty list (popup then asks for a pasted URL)', () => {
  const tree = parseHtml(read('nolinks/index.html'));
  assert.deepEqual(D.findLegalLinks(E.collectLinks(tree), 'https://plain.test/'), []);
});

test('classifyPage: a page that looks like terms but has almost no text is flagged "thin" (JavaScript-built or still loading), not read as terms', () => {
  const a = D.classifyPage({ url: 'https://a.test/terms', title: 'Terms', h1: '', textLength: 80 });
  assert.equal(a.isTerms, false); assert.equal(a.thin, true);
  assert.equal(D.classifyPage({ url: 'https://a.test/privacy-policy', title: '', h1: '', textLength: 400 }).thin, true);
  assert.equal(D.classifyPage({ url: 'https://a.test/page', title: 'Privacy Policy | A', h1: '', textLength: 120 }).thin, true);
  assert.equal(D.classifyPage({ url: 'https://a.test/terms', title: '', h1: '', textLength: 900 }).thin, false, 'enough text: read as terms');
  assert.equal(D.classifyPage({ url: 'https://a.test/about', title: 'About us', h1: '', textLength: 50 }).thin, false, 'an ordinary short page is not "thin terms"');
  assert.equal(D.classifyPage({ url: 'https://a.test/account/billing', title: 'Terms', h1: '', textLength: 50 }).thin, false, 'sensitive pages are never flagged');
});
