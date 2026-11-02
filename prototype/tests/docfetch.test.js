'use strict';
// The fetch module: URL guard on linked documents, limits, request shape, redirects, untrusted text (no real network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TCDocFetch = require('../extension/core/docfetch');
const guard = require('../extension/core/netguard');
const detect = require('../extension/core/detect');
const extract = require('../extension/core/extract');
const untrusted = require('../extension/core/untrusted');
const { parseHtml } = require('../cli/src/htmltree');
const { read } = require('./helpers/server');

const LONG = '<p>' + 'You agree that we may collect and use information about you to run the service. '.repeat(8) + '</p>';
const page = (title, body) => '<!doctype html><html lang="en"><head><title>' + title + '</title></head><body><main><h1>' + title + '</h1>' + body + '</main></body></html>';

function fakeFetch(routes, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    const r = routes[url];
    if (!r) throw new TypeError('Failed to fetch');
    if (typeof r === 'function') return r(url, init);
    const body = r.body === undefined ? '' : r.body;
    const bytes = new TextEncoder().encode(body);
    return {
      ok: (r.status || 200) >= 200 && (r.status || 200) < 300, status: r.status || 200, url: r.url || url, type: r.rtype || 'basic', redirected: !!r.redirected,
      headers: { get: (k) => ({ 'content-type': r.type === undefined ? 'text/html; charset=utf-8' : r.type, 'content-length': r.length, location: (r.headers || {}).location }[k.toLowerCase()]) },
      body: { getReader() { let done = false; return { read: async () => (done ? { done: true } : ((done = true), { done: false, value: bytes })), cancel() {} }; } }
    };
  };
}
const deps = (routes, calls, extra) => Object.assign({ fetch: fakeFetch(routes, calls), parseHtml, guard, detect, extract, untrusted }, extra || {});
const doc = (url, label, doc_type) => ({ url, label: label || 'Terms', doc_type: doc_type || 'tos' });

test('prepare: https only; localhost, private, link-local, credentials and non-web schemes are refused', () => {
  const bad = ['http://docs.example.test/terms', 'https://localhost/terms', 'https://127.0.0.1/terms', 'https://10.0.0.5/terms', 'https://192.168.1.1/terms',
    'https://169.254.169.254/latest/meta-data', 'https://[::1]/terms', 'https://203.0.113.9/terms', 'https://8.8.8.8/terms', 'https://[2001:4860:4860::8888]/terms', 'https://printer.local/terms', 'https://intranet/terms', 'https://user:pw@docs.example.test/terms',
    'file:///etc/passwd', 'data:text/html,<p>x</p>', 'javascript:alert(1)', 'ftp://docs.example.test/terms', 'not a url'];
  const p = TCDocFetch.prepare(bad.map((u) => doc(u)), { guard, detect });
  assert.equal(p.accepted.length, 0);
  assert.equal(p.rejected.length, bad.length);
  assert.deepEqual(p.origins, []);
  assert.ok(p.rejected.every((r) => typeof r.reason === 'string' && r.reason.length));
});

test('prepare: account / checkout / payment-looking links are never fetched; PDFs are offered, not fetched', () => {
  const p = TCDocFetch.prepare([doc('https://docs.example.test/account/settings/terms'), doc('https://docs.example.test/checkout/privacy'), doc('https://docs.example.test/terms.pdf'),
    Object.assign(doc('https://docs.example.test/privacy-doc'), { is_pdf: true }), doc('https://docs.example.test/terms')], { guard, detect });
  assert.deepEqual(p.accepted.map((d) => d.url), ['https://docs.example.test/terms']);
  assert.equal(p.rejected.length, 4);
});

test('prepare: one request per distinct URL (fragments ignored), at most 6 documents, origins for just those sites', () => {
  const docs = [];
  for (let i = 0; i < 9; i++) docs.push(doc('https://docs' + (i % 3) + '.example.test/doc' + i, 'Doc ' + i, 'other'));
  docs.push(doc('https://docs0.example.test/doc0#section'));
  const p = TCDocFetch.prepare(docs, { guard, detect });
  assert.equal(p.accepted.length, 6);
  assert.equal(p.rejected.length, 3);
  assert.deepEqual(p.origins, ['https://docs0.example.test/*', 'https://docs1.example.test/*', 'https://docs2.example.test/*']);
  assert.equal(new Set(p.accepted.map((d) => d.url)).size, 6);
});

test('fetch: the request is a plain logged-out GET - credentials omitted, no referrer, no cache, no custom UA, no cookies', async () => {
  const calls = [];
  const url = 'https://docs.example.test/terms';
  const r = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: page('Terms of Use', LONG) } }, calls));
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  const init = calls[0].init;
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.cache, 'no-store');
  assert.deepEqual(Object.keys(init.headers), ['Accept']);
  assert.ok(!('body' in init));
  assert.ok(init.signal, 'a time limit is attached');
});

test('fetch: html is parsed with the inert parser and returns sanitized plain text', async () => {
  const url = 'https://docs.example.test/terms';
  const r = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: page('Terms of Use', LONG + '<script>window.__x=1</script><img src="/x.png" onerror="alert(1)">') } }, []));
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Terms of Use');
  assert.ok(r.text.includes('we may collect and use information'));
  assert.ok(!/__x|alert|onerror|<script/.test(r.text));
});

test('fetch: JS-only pages (almost no text) are reported as needing JavaScript, not guessed at', async () => {
  const url = 'https://docs.example.test/app';
  const r = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: '<html><body><div id="root"></div><script>render()</script></body></html>' } }, []));
  assert.equal(r.ok, false);
  assert.match(r.reason, /needs JavaScript/);
});

test('fetch: a legal hub that only lists other documents is not read or followed', async () => {
  const url = 'https://docs.example.test/legal';
  const hub = page('Legal', '<ul>' + ['terms-of-use', 'privacy-policy', 'cookie-policy', 'eula', 'community-guidelines'].map((s) => '<li><a href="/' + s + '">' + s.replace(/-/g, ' ') + '</a></li>').join('') + '</ul>' + LONG);
  const calls = [];
  const r = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: hub } }, calls));
  assert.equal(calls.length, 1, 'no link in a fetched document is ever followed');
  if (!r.ok) assert.match(r.reason, /list of links/);
});

test('fetch: only html / xhtml / plain text are read (PDF, images, JSON, no type)', async () => {
  const mk = (type) => ({ body: page('Terms', LONG), type });
  for (const [type, re] of [['application/pdf', /PDF/], ['image/png', /not a web page/], ['application/json', /not a web page/], ['', /not a web page/]]) {
    const url = 'https://docs.example.test/t';
    const r = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: mk(type) }, []));
    assert.equal(r.ok, false); assert.match(r.reason, re);
  }
  const url = 'https://docs.example.test/t.txt';
  const t = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: 'Terms\n\n' + 'You agree to arbitrate every dispute. '.repeat(10), type: 'text/plain; charset=utf-8' } }, []));
  assert.equal(t.ok, true);
});

test('fetch: size limit - a declared or streamed body over the cap is refused', async () => {
  const url = 'https://docs.example.test/big';
  const decl = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: 'x', length: String(TCDocFetch.MAX_BYTES + 1) } }, []));
  assert.equal(decl.ok, false); assert.match(decl.reason, /too large/);
  const big = page('Terms', '<p>' + 'a'.repeat(5000) + '</p>');
  const streamed = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: big } }, [], { maxBytes: 1000 }));
  assert.equal(streamed.ok, false); assert.match(streamed.reason, /too large/);
});

test('fetch: time limit - a site that never answers is given up on and the request is aborted', async () => {
  const url = 'https://docs.example.test/slow';
  let aborted = false;
  const slow = (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }));
  const t0 = Date.now();
  const r = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: slow }, [], { timeoutMs: 80 }));
  assert.equal(r.ok, false); assert.match(r.reason, /too long/);
  assert.ok(aborted);
  assert.ok(Date.now() - t0 < 2000);
});

test('fetch: a redirect to a private address, a non-https address, or an error page is not read', async () => {
  const url = 'https://docs.example.test/terms';
  for (const [final, re] of [['https://169.254.169.254/latest/meta-data', /not allowed/], ['http://docs.example.test/terms', /not allowed|not https/], ['https://localhost/terms', /not allowed/]]) {
    const r = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: page('Terms', LONG), url: final } }, []));
    assert.equal(r.ok, false, final); assert.match(r.reason, re);
  }
  const e = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: 'nope', status: 403 } }, []));
  assert.equal(e.ok, false); assert.match(e.reason, /403/);
  const off = await TCDocFetch.fetchDoc(doc(url), deps({}, []));
  assert.equal(off.ok, false); assert.match(off.reason, /could not be reached/);
});

test('fetch: redirects are never followed - the request is redirect:manual and any redirect is "not read" with a reason (the window shows the link)', async () => {
  const url = 'https://docs.example.test/terms';
  const calls = [];
  const cases = {
    opaque: { rtype: 'opaqueredirect', status: 0, body: '' },             // what Chrome returns for redirect:'manual'
    http302: { status: 302, body: '' },                                    // any 3xx, however the browser reports it
    followedAnyway: { body: page('Terms', LONG), redirected: true },      // defence in depth: a response flagged redirected is dropped
    otherUrl: { body: page('Terms', LONG), url: 'https://elsewhere.example.test/terms' }
  };
  for (const [name, route] of Object.entries(cases)) {
    const r = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: route }, calls));
    assert.equal(r.ok, false, name); assert.equal(r.text, undefined, name);
    assert.match(r.reason, /sends you to another page/, name); assert.equal(r.redirect, true, name); assert.equal(r.url, url, 'the link to show is the document\'s own link');
  }
  assert.ok(calls.every((c) => c.init.redirect === 'manual'));
  assert.equal(calls.length, 4, 'one request each, no follow-up request to any redirect target');
  const ok = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: page('Terms', LONG) } }, []));
  assert.equal(ok.ok, true, 'a normal 200 is unaffected');
});

test('fetch: a redirect target is shown only when the browser reveals it AND it passes the URL guard; it is never requested', async () => {
  const url = 'https://docs.example.test/terms';
  const calls = [];
  const r = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { status: 301, body: '', headers: { location: 'https://www.example.test/legal/terms' } } }, calls));
  assert.equal(r.ok, false); assert.equal(r.redirect, true); assert.equal(r.target, 'https://www.example.test/legal/terms');
  assert.equal(calls.length, 1, 'the target itself is not requested');
  const rel = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { status: 302, body: '', headers: { location: '/new-terms' } } }, []));
  assert.equal(rel.target, 'https://docs.example.test/new-terms', 'a relative Location resolves against the document');
  for (const bad of ['http://www.example.test/t', 'https://169.254.169.254/x', 'https://localhost/t', 'javascript:alert(1)']) {
    const x = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { status: 302, body: '', headers: { location: bad } } }, []));
    assert.equal(x.redirect, true, bad); assert.equal(x.target, undefined, 'unsafe target never offered: ' + bad);
  }
  const unknown = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { rtype: 'opaqueredirect', status: 0 } }, []));
  assert.equal(unknown.redirect, true); assert.equal(unknown.target, undefined, 'an opaque redirect has no known target');
});

test('fetchAll: a redirected document does not stop the others; the redirect target is never requested', async () => {
  const calls = [];
  const routes = { 'https://a.example.test/old-terms': { rtype: 'opaqueredirect', status: 0 }, 'https://a.example.test/privacy': { body: page('Privacy Policy', LONG) } };
  const out = await TCDocFetch.fetchAll([doc('https://a.example.test/old-terms'), doc('https://a.example.test/privacy', 'Privacy', 'privacy')], deps(routes, calls));
  assert.deepEqual(out.map((r) => r.ok), [false, true]);
  assert.deepEqual(calls.map((c) => c.url), ['https://a.example.test/old-terms', 'https://a.example.test/privacy']);
});

test('fetchAll: sequential, one request per document, failures are reported per document and never throw', async () => {
  const calls = [], order = [];
  const routes = {
    'https://a.example.test/terms': { body: page('Terms of Use', LONG) },
    'https://a.example.test/privacy': { body: page('Privacy Policy', LONG) },
    'https://a.example.test/cookies': { body: '<html><body></body></html>' }
  };
  const d = deps(routes, calls);
  const docs = [doc('https://a.example.test/terms', 'Terms'), doc('https://a.example.test/privacy', 'Privacy', 'privacy'), doc('https://a.example.test/cookies', 'Cookies', 'cookies'), doc('https://a.example.test/missing', 'Other', 'other')];
  const out = await TCDocFetch.fetchAll(docs, d, (i) => order.push(i));
  assert.deepEqual(out.map((r) => r.ok), [true, true, false, false]);
  assert.deepEqual(calls.map((c) => c.url), docs.map((x) => x.url));
  assert.deepEqual(order, [0, 1, 2, 3]);
});

test('no robots.txt check (v1.1): a robots.txt that disallows everything is never requested and never blocks a page the person asked for; the other safeguards stay', async () => {
  const calls = [];
  const routes = {
    'https://a.example.test/robots.txt': { body: 'User-agent: *\nDisallow: /\n', type: 'text/plain' },
    'https://a.example.test/terms': { body: page('Terms of Use', LONG) },
    'https://a.example.test/privacy': { body: page('Privacy Policy', LONG) }
  };
  const out = await TCDocFetch.fetchAll([doc('https://a.example.test/terms'), doc('https://a.example.test/privacy', 'Privacy', 'privacy')], deps(routes, calls));
  assert.deepEqual(out.map((r) => r.ok), [true, true], 'both read even though robots.txt says Disallow: /');
  assert.deepEqual(calls.map((c) => c.url), ['https://a.example.test/terms', 'https://a.example.test/privacy'], 'robots.txt was never requested, one request per document, in order');
  calls.forEach((c) => { assert.equal(c.init.credentials, 'omit', 'no cookies'); assert.equal(c.init.redirect, 'manual'); assert.equal(c.init.method, 'GET'); });
  assert.ok(!/robots/i.test(fs.readFileSync(path.join(__dirname, '..', 'extension', 'core', 'docfetch.js'), 'utf8').replace(/\/\*[^]*?\*\//g, '')), 'docfetch.js no longer refers to robots at all (outside comments)');
  assert.ok(!/robots/i.test(fs.readFileSync(path.join(__dirname, '..', 'extension', 'explain', 'explain.html'), 'utf8')), 'explain.html does not load robots.js');
  assert.ok(!/robots/i.test(fs.readFileSync(path.join(__dirname, '..', 'extension', 'explain', 'explain.js'), 'utf8').replace(/\/\*[^]*?\*\//g, '')));
});

test('no robots.txt check: the private-address checks still run first (the Firefox DNS check before any request; the static guard is covered by the prepare tests)', async () => {
  const calls = [];
  const out = await TCDocFetch.fetchAll([doc('https://a.example.test/terms')], deps({ 'https://a.example.test/terms': { body: page('Terms', LONG) } }, calls, { dnsCheck: async (h) => (h === 'a.example.test' ? 'its name points to a private or internal address, so it was not opened' : null) }));
  assert.equal(out[0].ok, false); assert.match(out[0].reason, /private or internal/);
  assert.deepEqual(calls, [], 'nothing was requested');
});

test('docfetch.js is the only extension script allowed to call fetch, and it holds no storage or cookie code', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'core', 'docfetch.js'), 'utf8').replace(/\/\*[^]*?\*\//g, '');
  assert.ok(!/XMLHttpRequest|WebSocket|sendBeacon|EventSource|localStorage|sessionStorage|indexedDB|document\.cookie|chrome\.|innerHTML|eval\(|new Function/.test(src));
  assert.ok(/deps\.fetch\(/.test(src) && !/[^.\w]fetch\(/.test(src), 'fetch is injected, never a global call');
  const rsrc = fs.readFileSync(path.join(__dirname, '..', 'extension', 'core', 'robots.js'), 'utf8').replace(/\/\*[^]*?\*\//g, '');
  assert.ok(/deps\.fetch\(/.test(rsrc) && !/[^.\w]fetch\(/.test(rsrc) && !/XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|indexedDB|document\.cookie|chrome\./.test(rsrc), 'robots.js: injected fetch only, no storage');
});
