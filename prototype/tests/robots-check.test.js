'use strict';
// robots.txt check: parsing, matching, decisions, request shape, per-analysis cache, fail-open behaviour (no real network).
const test = require('node:test');
const assert = require('node:assert/strict');
const TCRobots = require('../extension/core/robots');
const TCDocFetch = require('../extension/core/docfetch');
const guard = require('../extension/core/netguard');
const detect = require('../extension/core/detect');
const extract = require('../extension/core/extract');
const untrusted = require('../extension/core/untrusted');
const { parseHtml } = require('../cli/src/htmltree');

const allowed = (txt, p) => TCRobots.isAllowed(TCRobots.parse(txt), p);

test('parse: only the "*" group applies; other bots\' groups are ignored; comments, BOM, CRLF and odd lines are tolerated', () => {
  const txt = '\uFEFF# hello\r\nUser-agent: googlebot\r\nDisallow: /g\r\n\r\nUser-agent: *   # everyone\r\nDisallow: /private   # secret\r\nAllow: /private/ok\r\nnonsense line\r\nSitemap: https://x.test/s.xml\r\n';
  assert.equal(allowed(txt, '/g'), true, 'googlebot-only rule does not apply to us');
  assert.equal(allowed(txt, '/private/page'), false);
  assert.equal(allowed(txt, '/private/ok'), true);
  assert.equal(allowed(txt, '/public'), true);
});

test('parse: several User-agent lines share one group; several "*" groups are merged; case of directives and agents is ignored', () => {
  const txt = 'USER-AGENT: foo\nuser-agent: *\nDISALLOW: /a\n\nuser-agent: bar\nDisallow: /b\n\nUser-Agent: *\nDisallow: /c\n';
  assert.equal(allowed(txt, '/a'), false);
  assert.equal(allowed(txt, '/b'), true);
  assert.equal(allowed(txt, '/c'), false);
});

test('isAllowed: nothing matches = allowed; empty Disallow = allowed; "Disallow: /" blocks everything', () => {
  assert.equal(allowed('', '/terms'), true);
  assert.equal(allowed('User-agent: *\nDisallow:\n', '/terms'), true);
  assert.equal(allowed('User-agent: *\nDisallow: /\n', '/terms'), false);
  assert.equal(allowed('User-agent: *\nDisallow: /\n', '/'), false);
  assert.equal(allowed('Disallow: /x\n', '/x'), true, 'a rule before any User-agent line belongs to no group');
});

test('isAllowed: longest matching rule wins; Allow wins a tie; prefix semantics', () => {
  const txt = 'User-agent: *\nDisallow: /legal\nAllow: /legal/terms\nDisallow: /legal/terms/old\nDisallow: /tie\nAllow: /tie\n';
  assert.equal(allowed(txt, '/legal/privacy'), false);
  assert.equal(allowed(txt, '/legal/terms'), true);
  assert.equal(allowed(txt, '/legal/terms/new'), true);
  assert.equal(allowed(txt, '/legal/terms/old/1'), false);
  assert.equal(allowed(txt, '/tie'), true);
  assert.equal(allowed(txt, '/legalese'), false, 'a prefix rule matches /legalese too');
  assert.equal(allowed(txt, '/Legal/privacy'), true, 'paths are case sensitive');
});

test('isAllowed: "*" wildcards and "$" end anchor; query strings are part of the path', () => {
  const txt = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /a/*/draft\nDisallow: /*?session=\nAllow: /a/x/draft$\n';
  assert.equal(allowed(txt, '/files/terms.pdf'), false);
  assert.equal(allowed(txt, '/files/terms.pdf?x=1'), true, '$ anchors the end of the whole path+query');
  assert.equal(allowed(txt, '/a/b/draft'), false);
  assert.equal(allowed(txt, '/a/b/c/draft/v2'), false);
  assert.equal(allowed(txt, '/a/x/draft'), true, 'the Allow rule is longer than the Disallow it overlaps, so it wins');
  assert.equal(allowed(txt, '/terms?session=abc'), false);
  assert.equal(allowed(txt, '/terms?other=1'), true);
});

test('isAllowed: percent-encoding is normalised on both sides; non-ASCII paths work', () => {
  assert.equal(allowed('User-agent: *\nDisallow: /a%7Eb\n', '/a~b'), false);
  assert.equal(allowed('User-agent: *\nDisallow: /a~b\n', '/a%7eb'), false);
  assert.equal(allowed('User-agent: *\nDisallow: /caf%c3%a9\n', '/caf%C3%A9/terms'), false);
  assert.equal(allowed('User-agent: *\nDisallow: /café\n', '/caf%C3%A9'), false);
  assert.equal(allowed('User-agent: *\nDisallow: /a%2Fb\n', '/a/b'), true, '%2F is not the same as /');
});

test('matches: pathological wildcard patterns finish instantly (no regex backtracking)', () => {
  const t0 = Date.now();
  const pat = '/' + 'a*'.repeat(60) + 'b$';
  assert.equal(TCRobots.matches(pat, '/' + 'a'.repeat(5000)), false);
  assert.ok(Date.now() - t0 < 1000);
});

test('parse: at most 2000 rules are kept', () => {
  const txt = 'User-agent: *\n' + Array.from({ length: 5000 }, (_, i) => 'Disallow: /p' + i).join('\n');
  assert.equal(TCRobots.parse(txt).rules.length, 2000);
});

test('robotsUrl: always the site root, https, with no path or query of the document', () => {
  assert.equal(TCRobots.robotsUrl('https://docs.example.test/legal/terms?a=1#x'), 'https://docs.example.test/robots.txt');
  assert.equal(TCRobots.robotsUrl('https://docs.example.test:8443/t'), 'https://docs.example.test:8443/robots.txt');
});

// ---- fetching and deciding -------------------------------------------------------------------------------------------------
function resp(o) {
  const bytes = new TextEncoder().encode(o.body === undefined ? '' : o.body);
  const status = o.status === undefined ? 200 : o.status;
  return { ok: status >= 200 && status < 300, status, type: o.type || 'basic', redirected: !!o.redirected, url: o.url,
    headers: { get: () => null }, body: { getReader() { let d = false; return { read: async () => (d ? { done: true } : ((d = true), { done: false, value: bytes })), cancel() {} }; } } };
}
function mkFetch(routes, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    const r = routes[url];
    if (!r) throw new TypeError('Failed to fetch');
    return typeof r === 'function' ? r(url, init) : resp(Object.assign({ url }, r));
  };
}
const TXT = 'User-agent: *\nDisallow: /private\n';
const mk = (routes, calls, extra) => TCRobots.createChecker(Object.assign({ fetch: mkFetch(routes, calls), guard }, extra || {}));

test('check: disallowed path -> not allowed with a short reason; allowed path -> allowed', async () => {
  const calls = [], check = mk({ 'https://a.example.test/robots.txt': { body: TXT } }, calls);
  const no = await check('https://a.example.test/private/terms');
  assert.equal(no.allowed, false); assert.match(no.reason, /robots\.txt/);
  const yes = await check('https://a.example.test/terms');
  assert.equal(yes.allowed, true); assert.equal(yes.robots, 'read');
});

test('check: the robots.txt request is a guarded plain GET (https, no cookies, no referrer, no cache, no redirects, abortable)', async () => {
  const calls = [];
  await mk({ 'https://a.example.test/robots.txt': { body: TXT } }, calls)('https://a.example.test/private/x?y=1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://a.example.test/robots.txt');
  const i = calls[0].init;
  assert.equal(i.method, 'GET'); assert.equal(i.credentials, 'omit'); assert.equal(i.redirect, 'manual');
  assert.equal(i.referrerPolicy, 'no-referrer'); assert.equal(i.cache, 'no-store'); assert.ok(i.signal);
  assert.equal(i.headers && i.headers.Cookie, undefined); assert.equal(i.headers && i.headers.Authorization, undefined);
});

test('check: cached per site within one analysis (one request for several documents), separate sites each get one, nothing carries over to a new checker', async () => {
  const calls = [];
  const routes = { 'https://a.example.test/robots.txt': { body: TXT }, 'https://b.example.test/robots.txt': { body: 'User-agent: *\nDisallow:\n' } };
  const check = mk(routes, calls);
  await Promise.all([check('https://a.example.test/terms'), check('https://a.example.test/privacy'), check('https://b.example.test/terms'), check('https://a.example.test/private')]);
  assert.deepEqual(calls.map((c) => c.url).sort(), ['https://a.example.test/robots.txt', 'https://b.example.test/robots.txt']);
  const calls2 = [];
  await mk(routes, calls2)('https://a.example.test/terms');
  assert.equal(calls2.length, 1, 'a new analysis fetches again - nothing was saved');
});

test('check: missing (404), forbidden, server error, redirect, network error, timeout, oversized-garbage -> allowed', async () => {
  const url = 'https://a.example.test/robots.txt', doc = 'https://a.example.test/private/terms';
  const cases = {
    '404': { status: 404, body: 'Disallow: /' }, '403': { status: 403, body: TXT }, '500': { status: 500, body: TXT }, '503': { status: 503, body: TXT },
    'opaque redirect': { type: 'opaqueredirect', status: 0 }, '301': { status: 301, body: TXT }, 'redirected flag': { body: TXT, redirected: true },
    'other final url': { body: TXT, url: 'https://elsewhere.example.test/robots.txt' }, 'network error': null,
    'html page instead of robots': { body: '<!doctype html><html><body>Not found</body></html>' }
  };
  for (const [name, route] of Object.entries(cases)) {
    const calls = [];
    const r = await mk(route === null ? {} : { [url]: route }, calls)(doc);
    assert.equal(r.allowed, true, name);
  }
  // slow: never answers; aborted after the (shortened) robots timeout, then allowed
  let aborted = false;
  const slow = (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => { aborted = true; const e = new Error('x'); e.name = 'AbortError'; rej(e); }));
  const t0 = Date.now();
  const r = await mk({ [url]: slow }, [], { robotsTimeoutMs: 60 })(doc);
  assert.equal(r.allowed, true); assert.ok(aborted); assert.ok(Date.now() - t0 < 2000);
  assert.equal(TCRobots.ROBOTS_TIMEOUT_MS, 4000, 'default timeout is short');
});

test('check: only the first 512 KiB of a huge robots.txt are read; a rule beyond the cap is ignored; the check never throws', async () => {
  const big = 'User-agent: *\n' + '# pad\n'.repeat(120000) + 'Disallow: /private\n';
  assert.ok(big.length > TCRobots.ROBOTS_MAX_BYTES);
  const r = await mk({ 'https://a.example.test/robots.txt': { body: big } }, [])('https://a.example.test/private');
  assert.equal(r.allowed, true);
  assert.equal((await mk({}, [])('not a url')).allowed, true);
});

test('check: a robots.txt URL that fails the SSRF guard is never requested (and is allowed)', async () => {
  const calls = [];
  const r = await mk({}, calls)('https://127.0.0.1/terms');
  assert.equal(r.allowed, true); assert.equal(calls.length, 0);
});

// ---- integration with the document fetch -------------------------------------------------------------------------------------
const LONG = '<p>' + 'You agree that we may collect and use information about you to run the service. '.repeat(8) + '</p>';
const page = (t) => '<!doctype html><html lang="en"><head><title>' + t + '</title></head><body><main><h1>' + t + '</h1>' + LONG + '</main></body></html>';
const htmlRoute = (t) => (url) => { const b = new TextEncoder().encode(page(t)); return { ok: true, status: 200, url, type: 'basic', headers: { get: (k) => ({ 'content-type': 'text/html' }[k.toLowerCase()]) }, body: { getReader() { let d = false; return { read: async () => (d ? { done: true } : ((d = true), { done: false, value: b })), cancel() {} }; } } }; };
const dd = (routes, calls) => ({ fetch: mkFetch(routes, calls), parseHtml, guard, detect, extract, untrusted });
const D = (url, label) => ({ url, label: label || 'Terms', doc_type: 'tos' });

test('fetchAll + robots: a disallowed document is never requested - it is reported "not read" with the reason and its own link; others are read', async () => {
  const calls = [];
  const routes = {
    'https://a.example.test/robots.txt': { body: TXT },
    'https://a.example.test/private/terms': htmlRoute('Terms'), 'https://a.example.test/privacy': htmlRoute('Privacy Policy')
  };
  const out = await TCDocFetch.fetchAll([D('https://a.example.test/private/terms'), D('https://a.example.test/privacy', 'Privacy')], dd(routes, calls));
  assert.deepEqual(out.map((r) => r.ok), [false, true]);
  assert.match(out[0].reason, /robots\.txt/); assert.equal(out[0].url, 'https://a.example.test/private/terms'); assert.equal(out[0].text, undefined);
  assert.deepEqual(calls.map((c) => c.url), ['https://a.example.test/robots.txt', 'https://a.example.test/privacy'], 'robots.txt once, the disallowed page never');
});

test('fetchAll + robots: robots.txt missing or failing does not stop the fetch', async () => {
  for (const robots of [undefined, { status: 404 }, { status: 500 }]) {
    const calls = [];
    const routes = { 'https://a.example.test/terms': htmlRoute('Terms') };
    if (robots) routes['https://a.example.test/robots.txt'] = robots;
    const out = await TCDocFetch.fetchAll([D('https://a.example.test/terms')], dd(routes, calls));
    assert.equal(out[0].ok, true);
  }
});

test('fetchAll + robots: a fresh robots.txt cache per call (nothing kept between analyses)', async () => {
  const calls = [];
  const routes = { 'https://a.example.test/robots.txt': { body: 'User-agent: *\nDisallow:\n' }, 'https://a.example.test/terms': htmlRoute('Terms') };
  const d = dd(routes, calls);
  await TCDocFetch.fetchAll([D('https://a.example.test/terms')], d);
  await TCDocFetch.fetchAll([D('https://a.example.test/terms')], d);
  assert.equal(calls.filter((c) => c.url.endsWith('/robots.txt')).length, 2, 'robots.txt is not kept between analyses');
});
