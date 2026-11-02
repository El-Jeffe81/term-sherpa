'use strict';
// Agree-dialog detection, legal-link labelling and the regional/language de-duplication (fixtures are invented).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TCConsent = require('../extension/core/consent');
const TCLinkGroup = require('../extension/core/linkgroup');
const TCDetect = require('../extension/core/detect');
const E = require('../extension/core/extract');
const { parseHtml } = require('../cli/src/htmltree');
const { read } = require('./helpers/server');

const BASE = 'https://www.newsco.test/world/story/';
const find = (file) => TCConsent.find(parseHtml(read(file)), BASE);
const tree = (html) => parseHtml('<!doctype html><html><body>' + html + '</body></html>');

test('consent: a CNN-style "Legal Terms and Privacy" Agree modal yields Terms, Privacy, Cookies and the guidelines', () => {
  const c = find('newsco/home.html');
  assert.equal(c.found, true);
  assert.equal(c.kind, 'dialog');
  assert.deepEqual(c.buttons, ['Agree']);
  assert.deepEqual(c.links.map((l) => [l.doc_type, l.text]), [
    ['tos', 'Terms of Use'], ['privacy', 'Privacy Policy'], ['cookies', 'Cookie Policy'], ['other', 'Community Guidelines']
  ]);
  assert.ok(c.links.every((l) => /^https:\/\/docs\.newsco\.test\//.test(l.url)));
  assert.ok(!c.buttons.includes('Learn more'), 'only agree-style buttons are reported');
});

test('consent: a cookie banner on an ordinary page is found, with its cookie and privacy documents', () => {
  const c = find('newsco/cookie-banner.html');
  assert.equal(c.found, true);
  assert.equal(c.kind, 'banner');
  assert.deepEqual(c.buttons, ['Accept all']);
  assert.deepEqual(c.links.map((l) => l.doc_type).sort(), ['cookies', 'privacy']);
});

test('consent: no dialog on an ordinary article, a privacy hub, or a plain terms page', () => {
  for (const f of ['newsco/article.html', 'mediaco/privacy-center.html', 'newsco/terms.html', 'newsco/privacy.html']) assert.equal(find(f).found, false, f);
});

test('consent: an "I have read and agree" checkbox and a "By signing up you agree" sentence are found as inline', () => {
  const box = find('newsco/checkbox.html');
  assert.equal(box.found, true); assert.equal(box.kind, 'inline');
  assert.deepEqual(box.links.map((l) => l.doc_type), ['tos', 'privacy']);
  const signup = TCConsent.find(parseHtml(read('acme/index.html')), 'https://acme.test/');
  assert.equal(signup.found, true); assert.equal(signup.kind, 'inline');
});

test('consent: other things being agreed to are labelled (arbitration, subscription, community rules, EULA)', () => {
  const html = '<div role="dialog" aria-modal="true"><p>By continuing you agree to our <a href="/legal/arb">Arbitration Agreement</a>, ' +
    '<a href="/legal/sub">Subscription Terms</a>, <a href="/legal/cg">Community Guidelines</a>, <a href="/eula">End User License Agreement</a> and <a href="/legal/ads">Advertising Notice</a>.</p><button>I agree</button></div>';
  const c = TCConsent.find(tree(html), BASE);
  assert.equal(c.found, true);
  const { docs } = TCLinkGroup.dedupe(c.links, { lang: 'en-US' });
  assert.deepEqual(docs.map((d) => d.label).sort(), ['Advertising', 'Arbitration', 'Community rules', 'EULA', 'Subscription terms']);
});

test('consent: a dialog with agree buttons but no legal links is not reported; a footer link list is not an agree prompt', () => {
  assert.equal(TCConsent.find(tree('<div role="dialog"><p>Welcome back!</p><button>Continue</button></div>'), BASE).found, false);
  assert.equal(TCConsent.find(tree('<footer class="legal"><a href="/terms">Terms of Use</a> <a href="/privacy">Privacy Policy</a></footer>'), BASE).found, false);
});

test('consent: Disagree / Reject / Manage are not agree buttons; hidden dialogs are ignored', () => {
  const html = '<div role="dialog"><p>By clicking Accept you agree to the <a href="/terms">Terms of Use</a>.</p><button>Disagree</button><button>Reject all</button><button>Manage preferences</button><button>Accept</button></div>';
  assert.deepEqual(TCConsent.find(tree(html), BASE).buttons, ['Accept']);
  const hid = '<div role="dialog" style="display:none"><p>By clicking Accept you agree to the <a href="/terms">Terms of Use</a>.</p><button>Accept</button></div>';
  assert.equal(TCConsent.find(tree(hid), BASE).found, false);
  const hid2 = '<div role="dialog" hidden><p>By clicking Accept you agree to the <a href="/terms">Terms of Use</a>.</p><button>Accept</button></div>';
  assert.equal(TCConsent.find(tree(hid2), BASE).found, false);
});

test('consent: javascript:, mailto: and "#" links in a dialog are never returned as documents', () => {
  const html = '<div role="dialog"><p>By clicking Agree you agree to the <a href="javascript:void(0)">Terms of Use</a>, <a href="mailto:legal@x.test">Legal</a>, <a href="#">Cookie Settings</a> and <a href="/privacy">Privacy Policy</a>.</p><button>Agree</button></div>';
  const c = TCConsent.find(tree(html), BASE);
  assert.deepEqual(c.links.map((l) => l.text), ['Privacy Policy']);
});

test('consent: the detector only reads - it never calls anything on the tree and the page text is plain strings', () => {
  const c = find('newsco/home.html');
  assert.equal(typeof c.buttons[0], 'string');
  assert.ok(Object.values(c).every((v) => typeof v !== 'function'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'core', 'consent.js'), 'utf8');
  assert.ok(!/\.click\s*\(|dispatchEvent|\.submit\s*\(|\.checked\s*=|fetch\s*\(|XMLHttpRequest|chrome\./.test(src.replace(/\/\*[^]*?\*\//g, '')), 'no interaction or network code in the detector');
});

/* ---------- regional / language de-duplication ---------- */
const mk = (u, t, ty = 'privacy', lang = 'en') => ({ url: u, text: t, doc_type: ty, language: lang, non_english: lang !== 'en', score: 3 });
const REGIONS = ['en-us', 'en-gb', 'en-ca', 'fr-fr', 'fr-ca', 'de-de', 'es-es', 'es-mx', 'it-it', 'pt-br', 'pt-pt', 'nl-nl', 'pl-pl', 'sv-se', 'da-dk', 'nb-no', 'ja-jp', 'tr-tr'];

test('dedupe: the 18-link privacy centre collapses to ONE privacy document in the user\'s region', () => {
  const c = find('mediaco/privacy-center.html');
  const links = TCDetect.findLegalLinks(E.collectLinks(parseHtml(read('mediaco/privacy-center.html'))), 'https://privacy.mediaco.test/');
  assert.ok(links.filter((l) => l.doc_type === 'privacy').length >= 18, 'the raw list is the repetitive one');
  const out = TCLinkGroup.dedupe(links, { lang: 'en-US' });
  const priv = out.docs.filter((d) => d.doc_type === 'privacy');
  assert.equal(priv.length, 2, 'main policy + workforce notice (a different document)');
  assert.ok(priv.some((d) => /\/en-us$/.test(d.url)), 'prefers en-US');
  assert.equal(priv.find((d) => /en-us/.test(d.url)).variants, 17);
  assert.equal(out.docs.length, 3);
  assert.equal(c.found, false);
});

test('dedupe: the preferred variant follows the browser language and region', () => {
  const links = REGIONS.map((r) => mk('https://privacy.mediaco.test/policycenter/b2c/' + r, 'Privacy Policy'));
  const pick = (lang) => TCLinkGroup.dedupe(links.slice().reverse(), { lang }).docs[0].url.split('/').pop();
  assert.equal(pick('en-US'), 'en-us');
  assert.equal(pick('en-GB'), 'en-gb');
  assert.equal(pick('fr-FR'), 'fr-fr');
  assert.equal(pick('de'), 'de-de');
  assert.equal(pick('ko-KR'), 'en-us', 'no Korean version: falls back to US English');
});

test('dedupe: language suffixes, host prefixes, country domains and ?lang= are variants of one document', () => {
  const sets = [
    ['https://x.test/privacy-policy-fr', 'https://x.test/privacy-policy-de', 'https://x.test/privacy-policy-en-us'],
    ['https://de.x.test/privacy', 'https://fr.x.test/privacy', 'https://x.test/privacy'],
    ['https://x.de/privacy', 'https://x.fr/privacy', 'https://x.com/privacy'],
    ['https://x.test/privacy?lang=fr', 'https://x.test/privacy?lang=de', 'https://x.test/privacy?utm_source=a'],
    ['https://x.test/privacy#top', 'https://x.test/privacy']
  ];
  for (const s of sets) assert.equal(TCLinkGroup.dedupe(s.map((u) => mk(u, 'Privacy Policy')), { lang: 'en-US' }).docs.length, 1, s.join(' '));
});

test('dedupe: different documents of the same type are NOT merged; a foreign-language duplicate of a type we have is dropped', () => {
  const terms = [mk('https://x.test/terms-of-use', 'Terms of Use', 'tos'), mk('https://x.test/terms-of-sale', 'Terms of Sale', 'tos')];
  const d = TCLinkGroup.dedupe(terms, { lang: 'en-US' });
  assert.equal(d.docs.length, 2);
  assert.deepEqual(d.docs.map((x) => x.label), ['Terms', 'Terms of sale'].map((l, i) => d.docs[i].label));
  assert.notEqual(d.docs[0].label, d.docs[1].label, 'labels in one result are unique');
  const withForeign = TCLinkGroup.dedupe([mk('https://x.test/privacy', 'Privacy Policy'), mk('https://x.test/datenschutz', 'Datenschutzrichtlinie', 'privacy', 'de')], { lang: 'en-US' });
  assert.equal(withForeign.docs.length, 1);
  assert.equal(withForeign.docs[0].url, 'https://x.test/privacy');
  const onlyForeign = TCLinkGroup.dedupe([mk('https://x.test/datenschutz', 'Datenschutzrichtlinie', 'privacy', 'de')], { lang: 'en-US' });
  assert.equal(onlyForeign.docs.length, 1, 'kept when it is all there is');
});

test('dedupe: documents come out in a fixed order (terms, privacy, EULA, cookies, other)', () => {
  const links = [mk('https://x.test/cookies', 'Cookie Policy', 'cookies'), mk('https://x.test/guidelines', 'Community Guidelines', 'other'), mk('https://x.test/privacy', 'Privacy Policy'), mk('https://x.test/terms', 'Terms of Use', 'tos'), mk('https://x.test/eula', 'EULA', 'eula')];
  assert.deepEqual(TCLinkGroup.dedupe(links, { lang: 'en-US' }).docs.map((d) => d.doc_type), ['tos', 'privacy', 'eula', 'cookies', 'other']);
});

test('document-type labels', () => {
  const L = TCLinkGroup.labelFor;
  assert.equal(L({ doc_type: 'tos', text: 'Terms of Use' }), 'Terms');
  assert.equal(L({ doc_type: 'privacy', text: 'Privacy Policy' }), 'Privacy');
  assert.equal(L({ doc_type: 'cookies', text: 'Cookie Policy' }), 'Cookies');
  assert.equal(L({ doc_type: 'eula', text: 'EULA' }), 'EULA');
  assert.equal(L({ doc_type: 'other', text: 'Arbitration Agreement' }), 'Arbitration');
  assert.equal(L({ doc_type: 'tos', text: 'Subscription Terms' }), 'Subscription terms');
  assert.equal(L({ doc_type: 'other', text: 'Community Guidelines' }), 'Community rules');
  assert.equal(L({ doc_type: 'other', text: 'Something' }), 'Other');
  assert.deepEqual(TCLinkGroup.userLocale('en-US'), { lang: 'en', region: 'us' });
  assert.deepEqual(TCLinkGroup.userLocale('fr'), { lang: 'fr', region: '' });
  assert.deepEqual(TCLinkGroup.userLocale(undefined), { lang: 'en', region: 'us' });
});

test('a plain cookie banner with no id/class hint and no fixed position (a banner that is a page of its own inside an iframe) is found', () => {
  const html = '<html><body><div><p>We use cookies to provide, improve and protect our services. Visit our <a href="https://www.newsco.test/privacy">Privacy Policy</a> and <a href="https://www.newsco.test/privacy-faq">Privacy Policy FAQs</a> to learn more.</p><button>Customize cookies</button><button>Decline</button><button>Accept All</button></div></body></html>';
  const r = TCConsent.find(parseHtml(html), 'https://www.newsco.test/ccpa_iframe');
  assert.equal(r.found, true);
  assert.equal(r.kind, 'banner');
  assert.deepEqual(r.buttons, ['Accept All']);
  assert.ok(r.links.some((l) => l.doc_type === 'privacy'));
});

test('that fallback does not turn a footer of links, or a long article that mentions cookies, into an agree dialog', () => {
  const footer = '<html><body><div><p>We use cookies. <a href="https://www.newsco.test/privacy">Privacy Policy</a> <a href="https://www.newsco.test/terms">Terms of Service</a></p></div></body></html>';
  assert.equal(TCConsent.find(parseHtml(footer), BASE).found, false, 'no agree-style button');
  const article = '<html><body><div><p>' + 'Cookies are small files. '.repeat(80) + 'We use cookies. <a href="https://www.newsco.test/privacy">Privacy Policy</a></p><button>Accept</button></div></body></html>';
  assert.equal(TCConsent.find(parseHtml(article), BASE).found, false, 'too long to be a banner');
});
