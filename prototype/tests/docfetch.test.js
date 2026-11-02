'use strict';
// The fetch module: URL guard on linked documents, limits, request shape, redirects (followed + final-address checks), 8 MB truncation,
// both access modes, untrusted text (no real network).
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
    const bytes = r.bytes || new TextEncoder().encode(r.body === undefined ? '' : r.body);
    const chunkSize = r.chunk || bytes.length || 1;
    let pos = 0;
    const state = r.state || {};
    state.cancelled = false; state.reads = 0;
    return {
      ok: (r.status || 200) >= 200 && (r.status || 200) < 300, status: r.status || 200, url: r.url || url, type: r.rtype || 'basic', redirected: !!r.redirected,
      headers: { get: (k) => ({ 'content-type': r.type === undefined ? 'text/html; charset=utf-8' : r.type, 'content-length': r.length, location: (r.headers || {}).location }[k.toLowerCase()]) },
      body: {
        cancel() { state.cancelled = true; },
        getReader() {
          return {
            read: async () => { state.reads++; if (pos >= bytes.length) return { done: true }; const v = bytes.subarray(pos, pos + chunkSize); pos += v.length; return { done: false, value: v }; },
            cancel() { state.cancelled = true; }
          };
        }
      }
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

test('fetch: size limit is 8 MB and a bigger page is NOT refused: it is read up to the cap, the stream is cancelled, and the result is marked truncated', async () => {
  assert.equal(TCDocFetch.MAX_BYTES, 8 * 1024 * 1024);
  const url = 'https://docs.example.test/big';
  const st = {};
  const big = page('Terms', '<p>' + 'You agree to the rules. '.repeat(400) + '</p>');
  const r = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: big, chunk: 700, state: st } }, [], { maxBytes: 2000 }));
  assert.equal(r.ok, true, 'a page over the cap is read, not rejected');
  assert.equal(r.truncated, true);
  assert.equal(st.cancelled, true, 'the rest of the stream was cancelled');
  assert.ok(st.reads <= 4, 'it stopped reading at the cap (' + st.reads + ' reads), not at the end of the page');
  assert.ok(r.text.length > 200 && r.text.length < 2000, 'only the part that was read is used');
  // a declared content-length above the cap no longer causes rejection
  const decl = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: page('Terms', LONG), length: String(TCDocFetch.MAX_BYTES + 1) } }, []));
  assert.equal(decl.ok, true, 'content-length above the cap is not a rejection');
  assert.equal(decl.truncated, false, 'the body itself was small, so it was read in full');
  // a page under the cap is not marked truncated; a page exactly at the cap is not truncated either
  const small = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: page('Terms', LONG) } }, []));
  assert.equal(small.truncated, false);
  const exact = new TextEncoder().encode(page('Terms', LONG));
  const ex = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { bytes: exact, chunk: 100 } }, [], { maxBytes: exact.length }));
  assert.equal(ex.ok, true); assert.equal(ex.truncated, false, 'exactly at the cap with nothing left: not truncated');
  // the cap also holds when the body has no stream reader (arrayBuffer fallback)
  const noStream = (u) => ({ ok: true, status: 200, url: u, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html' : undefined) }, arrayBuffer: async () => new TextEncoder().encode(big).buffer });
  const ns = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: noStream }, [], { maxBytes: 2000 }));
  assert.equal(ns.ok, true); assert.equal(ns.truncated, true);
});

test('fetch: a multi-megabyte page really is read only up to 8 MB (default cap)', async () => {
  const url = 'https://docs.example.test/huge';
  const head = new TextEncoder().encode('<!doctype html><html><head><title>Terms</title></head><body><main><h1>Terms</h1><p>' + 'You agree to the rules of the service. '.repeat(30) + '</p><p>');
  const filler = new Uint8Array(9 * 1024 * 1024).fill(97); // 9 MB of "a"
  const bytes = new Uint8Array(head.length + filler.length); bytes.set(head); bytes.set(filler, head.length);
  const st = {};
  const r = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { bytes, chunk: 64 * 1024, state: st } }, []));
  assert.equal(r.ok, true); assert.equal(r.truncated, true); assert.equal(st.cancelled, true);
  assert.ok(st.reads <= Math.ceil(TCDocFetch.MAX_BYTES / (64 * 1024)) + 1, 'stopped at ~8 MB: ' + st.reads + ' reads of 64 KB');
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

test('fetch: redirects are followed (redirect:follow, GET, no cookies, no referrer); the final address is recorded and "read_from" names the real host', async () => {
  const url = 'https://www.cnn.com/privacy';
  const final = 'https://www.wbdprivacy.com/policycenter/b2c/';
  const calls = [];
  const r = await TCDocFetch.fetchDoc(doc(url, 'Privacy Policy', 'privacy'), deps({ [url]: { body: page('Privacy Policy', LONG), url: final, redirected: true } }, calls));
  assert.equal(r.ok, true);
  assert.equal(r.final_url, final);
  assert.equal(r.read_from, 'www.wbdprivacy.com');
  assert.equal(r.url, url, 'the document keeps its own link');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'follow');
  assert.equal(calls[0].init.method, 'GET'); assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
  // no redirect: no read_from; same host, other path: no read_from; www -> bare domain: a different host, so shown
  const plain = await TCDocFetch.fetchDoc(doc('https://a.example.test/t'), deps({ 'https://a.example.test/t': { body: page('Terms', LONG) } }, []));
  assert.equal(plain.ok, true); assert.equal(plain.read_from, undefined); assert.equal(plain.final_url, 'https://a.example.test/t');
  const same = await TCDocFetch.fetchDoc(doc('https://a.example.test/old'), deps({ 'https://a.example.test/old': { body: page('Terms', LONG), url: 'https://a.example.test/new' } }, []));
  assert.equal(same.ok, true); assert.equal(same.read_from, undefined);
  const bare = await TCDocFetch.fetchDoc(doc('https://www.a.example.test/t'), deps({ 'https://www.a.example.test/t': { body: page('Terms', LONG), url: 'https://a.example.test/t' } }, []));
  assert.equal(bare.read_from, 'a.example.test');
});

test('fetch: the FINAL address is vetted before the body is read - private, loopback, link-local, non-https, IP literal, credentials are discarded unread', async () => {
  const url = 'https://docs.example.test/terms';
  const bads = ['https://169.254.169.254/latest/meta-data', 'https://127.0.0.1/terms', 'https://10.1.2.3/terms', 'https://[::1]/terms', 'https://203.0.113.9/terms', 'https://8.8.8.8/terms',
    'https://localhost/terms', 'https://printer.local/terms', 'http://docs.example.test/terms', 'http://other.example.test/terms', 'https://user:pw@other.example.test/terms'];
  for (const final of bads) {
    const st = {};
    const r = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: page('Terms', LONG), url: final, redirected: true, state: st } }, []));
    assert.equal(r.ok, false, final); assert.equal(r.text, undefined, final);
    assert.equal(r.redirect, true, final); assert.equal(r.unsafe, true, final);
    assert.match(r.reason, /not allowed/, final);
    assert.equal(st.cancelled, true, 'response discarded: ' + final);
    assert.equal(st.reads, 0, 'not one byte of the body was read: ' + final);
  }
});

test('fetch (Firefox): dnsCheck also runs on the FINAL host of a redirect, before the body is read; it is not run again for an unchanged host', async () => {
  const url = 'https://a.example.test/terms';
  const seen = [];
  const dnsCheck = async (h) => { seen.push(h); return h === 'evil.example.test' ? 'its name points to a private or internal address, so it was not opened' : null; };
  const st = {};
  const bad = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: page('Terms', LONG), url: 'https://evil.example.test/terms', redirected: true, state: st } }, [], { dnsCheck }));
  assert.equal(bad.ok, false); assert.equal(bad.unsafe, true); assert.match(bad.reason, /private or internal/);
  assert.deepEqual(seen, ['a.example.test', 'evil.example.test']);
  assert.equal(st.cancelled, true); assert.equal(st.reads, 0);
  seen.length = 0;
  const ok = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: page('Terms', LONG), url: 'https://good.example.test/terms', redirected: true } }, [], { dnsCheck }));
  assert.equal(ok.ok, true); assert.deepEqual(seen, ['a.example.test', 'good.example.test']);
  seen.length = 0;
  const same = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: page('Terms', LONG) } }, [], { dnsCheck }));
  assert.equal(same.ok, true); assert.deepEqual(seen, ['a.example.test']);
});

test('access mode: ALL SITES (deps.allSites) - a cross-site redirect is read; a fetch error is just "could not be reached", with no second request', async () => {
  const url = 'https://www.cnn.com/privacy';
  const calls = [];
  const ok = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: page('Privacy', LONG), url: 'https://www.wbdprivacy.com/x', redirected: true } }, calls, { allSites: true }));
  assert.equal(ok.ok, true); assert.equal(ok.read_from, 'www.wbdprivacy.com');
  const calls2 = [];
  const off = await TCDocFetch.fetchDoc(doc(url), deps({}, calls2, { allSites: true }));
  assert.equal(off.ok, false); assert.match(off.reason, /could not be reached/); assert.equal(off.needs_all_sites, undefined);
  assert.equal(calls2.length, 1, 'no probe request in all-sites mode');
});

test('access mode: ONLY THE ALLOWED SITES - a redirect that stays on allowed hosts is read; one that leaves them (fetch throws) becomes needs_all_sites, found with ONE extra manual request to the same link', async () => {
  const url = 'https://www.cnn.com/privacy';
  // same-domain redirect to a host we already have access to: the browser lets fetch through
  const calls = [];
  const same = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: { body: page('Privacy', LONG), url: 'https://edition.cnn.com/privacy', redirected: true } }, calls));
  assert.equal(same.ok, true); assert.equal(same.read_from, 'edition.cnn.com'); assert.equal(calls.length, 1);
  // cross-site redirect without access: follow throws, manual shows a redirect
  const calls2 = [];
  const routes = { [url]: (u, init) => { if (init.redirect === 'follow') throw new TypeError('Failed to fetch'); return { ok: false, status: 0, type: 'opaqueredirect', url: u, headers: { get: () => null }, body: null }; } };
  const r = await TCDocFetch.fetchDoc(doc(url, 'Privacy Policy', 'privacy'), deps(routes, calls2));
  assert.equal(r.ok, false); assert.equal(r.redirect, true); assert.equal(r.needs_all_sites, true);
  assert.equal(r.text, undefined); assert.equal(r.url, url);
  assert.match(r.reason, /another site/);
  assert.deepEqual(calls2.map((c) => [c.url, c.init.redirect]), [[url, 'follow'], [url, 'manual']], 'the probe re-asks the same link, never the redirect target');
  assert.ok(calls2.every((c) => c.init.method === 'GET' && c.init.credentials === 'omit' && c.init.referrerPolicy === 'no-referrer'));
  // a 3xx status from the probe counts too
  const r3 = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: (u, init) => { if (init.redirect === 'follow') throw new TypeError('x'); return { ok: false, status: 302, type: 'basic', url: u, headers: { get: () => null } }; } }, []));
  assert.equal(r3.needs_all_sites, true);
  // offline / blocked (the probe is not a redirect either): plain "could not be reached"
  const off = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: (u, init) => { if (init.redirect === 'follow') throw new TypeError('x'); return { ok: true, status: 200, type: 'basic', url: u, headers: { get: () => null } }; } }, []));
  assert.equal(off.ok, false); assert.equal(off.needs_all_sites, undefined); assert.match(off.reason, /could not be reached/);
  const off2 = await TCDocFetch.fetchDoc(doc(url), deps({}, []));
  assert.match(off2.reason, /could not be reached/);
  // a timeout is never probed
  const calls4 = [];
  const slow = (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }));
  const t = await TCDocFetch.fetchDoc(doc(url), deps({ [url]: slow }, calls4, { timeoutMs: 50 }));
  assert.match(t.reason, /too long/); assert.equal(calls4.length, 1);
});

test('fetchAll: an unreadable (cross-site) document does not stop the others; the redirect target is never requested by us', async () => {
  const calls = [];
  const routes = { 'https://a.example.test/old-terms': (u, init) => { if (init.redirect === 'follow') throw new TypeError('x'); return { status: 0, type: 'opaqueredirect', url: u, headers: { get: () => null } }; }, 'https://a.example.test/privacy': { body: page('Privacy Policy', LONG) } };
  const out = await TCDocFetch.fetchAll([doc('https://a.example.test/old-terms'), doc('https://a.example.test/privacy', 'Privacy', 'privacy')], deps(routes, calls));
  assert.deepEqual(out.map((r) => r.ok), [false, true]);
  assert.equal(out[0].needs_all_sites, true);
  assert.deepEqual(calls.map((c) => c.url), ['https://a.example.test/old-terms', 'https://a.example.test/old-terms', 'https://a.example.test/privacy']);
});

test('fetchAll: sequential, one request per document, failures are reported per document and never throw', async () => {
  const calls = [], order = [];
  const routes = {
    'https://a.example.test/terms': { body: page('Terms of Use', LONG) },
    'https://a.example.test/privacy': { body: page('Privacy Policy', LONG) },
    'https://a.example.test/cookies': { body: '<html><body></body></html>' }
  };
  const d = deps(routes, calls, { allSites: true }); // (without all-sites access a failed fetch is re-asked once to see whether it was a redirect)
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
  calls.forEach((c) => { assert.equal(c.init.credentials, 'omit', 'no cookies'); assert.equal(c.init.redirect, 'follow'); assert.equal(c.init.method, 'GET'); });
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
