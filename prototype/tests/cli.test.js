'use strict';
// Offline CLI tests: the real bin is run against local fixture servers (127.0.0.1). No real sites.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startSite, activeOrigins } = require('./helpers/server');

// Fixture servers live on 127.0.0.1, which the real CLI refuses (see security.test.js), so these tests use the harness entry
// that allows exactly the fixture origins. Same code path otherwise.
const BIN = path.join(__dirname, 'helpers', 'cli-test-entry.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tc-test-'));
// Async spawn: the fixture server lives in this process, so the event loop must stay free.
function run(args, { db, delay = '0', env = {}, allow = [...activeOrigins] } = {}) {
  const a = [BIN, ...args];
  if (db) a.push('--db', db);
  if (delay !== null) a.push('--delay', delay);
  return new Promise((resolve) => {
    const origins = allow;
    const c = spawn(process.execPath, a, { env: { ...process.env, TC_TEST_ALLOW_ORIGINS: origins.join(','), ...env } });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
}
const acmeRoutes = (state = {}) => ({
  '/signup': { file: 'acme/index.html' },
  '/terms': () => ({ file: state.v2 ? 'acme/terms-v2.html' : 'acme/terms.html' }),
  '/privacy': { file: 'acme/privacy.html' },
  '/eula': { file: 'acme/eula.html' },
  '/cookies': { file: 'acme/cookies.html' },
  '/news': { file: 'acme/not-terms.html' }
});

test('stores a terms page; honest UA, no cookies/auth sent; robots fetched first', async () => {
  const site = await startSite({ routes: acmeRoutes(), robots: 'User-agent: *\nAllow: /\n' });
  const db = path.join(tmp(), 'd.sqlite');
  try {
    const r = await run([site.base + '/terms'], { db });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /tos: stored \(first version\)/);
    assert.equal(site.hits[0].url, '/robots.txt', 'robots.txt checked before the page');
    for (const h of site.hits) {
      assert.match(h.headers['user-agent'], /^tc-collect\/\d/);
      assert.match(h.headers['user-agent'], /honors robots\.txt/);
      assert.equal(h.headers.cookie, undefined);
      assert.equal(h.headers.authorization, undefined);
    }
    assert.equal(site.pageHits().length, 1, 'exactly one page request; no crawling');
    const list = await run(['list'], { db, delay: null });
    assert.match(list.out, /tos\tv1\t[0-9a-f]{12}\t.*\/terms/);
  } finally { await site.close(); }
});

test('second run is unchanged (no new version); changed page makes version 2 with a diff', async () => {
  const state = {};
  const site = await startSite({ routes: acmeRoutes(state) });
  const db = path.join(tmp(), 'd.sqlite');
  try {
    assert.equal((await run([site.base + '/terms'], { db })).code, 0);
    const again = await run([site.base + '/terms'], { db });
    assert.match(again.out, /unchanged since v1/);
    assert.match((await run(['history', site.base + '/terms'], { db, delay: null })).out, /^v1\t/);
    assert.equal((await run(['history', site.base + '/terms'], { db, delay: null })).out.trim().split('\n').length, 1);

    state.v2 = true;
    const changed = await run([site.base + '/terms'], { db });
    assert.match(changed.out, /NEW version v2 \(\+\d+ \/ -\d+ lines\)/);
    const hist = (await run(['history', site.base + '/terms'], { db, delay: null })).out.trim().split('\n');
    assert.equal(hist.length, 2);
    const diff = (await run(['diff', site.base + '/terms'], { db, delay: null })).out;
    assert.match(diff, /--- v1/);
    assert.match(diff, /\+\+\+ v2/);
    assert.match(diff, /- Paid plans renew automatically each month/);
    assert.match(diff, /\+ Paid plans renew automatically every year/);
    assert.match(diff, /\u20ac5 \/ month/);
    assert.match(diff, /\u20ac6 \/ month/);
  } finally { await site.close(); }
});

test('refuses on robots.txt disallow and never requests the page', async () => {
  const site = await startSite({ routes: acmeRoutes(), robots: 'User-agent: *\nDisallow: /terms\n' });
  const db = path.join(tmp(), 'd.sqlite');
  try {
    const r = await run([site.base + '/terms'], { db });
    assert.equal(r.code, 3);
    assert.match(r.err, /REFUSED \(robots\).*disallows \/terms/);
    assert.equal(site.pageHits().length, 0);
    assert.match((await run(['list'], { db, delay: null })).out, /nothing stored/);
    // a path that is not disallowed still works on the same site
    assert.equal((await run([site.base + '/privacy'], { db })).code, 0);
  } finally { await site.close(); }
});

test('robots rule for our own token is honoured even when * allows', async () => {
  const site = await startSite({ routes: acmeRoutes(), robots: 'User-agent: *\nAllow: /\n\nUser-agent: tc-collect\nDisallow: /\n' });
  try {
    assert.equal((await run([site.base + '/terms'], { db: path.join(tmp(), 'd.sqlite') })).code, 3);
    assert.equal(site.pageHits().length, 0);
  } finally { await site.close(); }
});

test('robots.txt 5xx or 403 -> refuse (assume disallowed / blocked); 404 -> allowed', async () => {
  for (const [status, expected] of [[503, 3], [403, 3], [404, 0]]) {
    const site = await startSite({ routes: acmeRoutes(), robots: status === 404 ? null : { status, body: 'x' } });
    try {
      const r = await run([site.base + '/terms'], { db: path.join(tmp(), 'd.sqlite') });
      assert.equal(r.code, expected, `robots ${status}: ${r.err}`);
      if (expected === 3) assert.equal(site.pageHits().length, 0);
    } finally { await site.close(); }
  }
});

test('refuses 401, 403, 429 and 451 and does not retry or work around', async () => {
  for (const [status, code] of [[401, 4], [403, 4], [429, 4], [451, 4]]) {
    const site = await startSite({ routes: { '/terms': { status, body: 'nope' } } });
    try {
      const r = await run([site.base + '/terms'], { db: path.join(tmp(), 'd.sqlite') });
      assert.equal(r.code, code, `HTTP ${status}`);
      assert.match(r.err, /REFUSED \(blocked\)/);
      assert.equal(site.pageHits().length, 1, 'exactly one attempt, no retry');
    } finally { await site.close(); }
  }
});

test('refuses captcha / bot-check pages (200 and 503), but not a real terms page with an embedded recaptcha', async () => {
  const site = await startSite({ routes: {
    '/terms': { file: 'captcha/terms.html' },
    '/privacy': { status: 503, file: 'captcha/terms.html' },
    '/quiz': { file: 'captcha/quiz.html' },
    '/header': { headers: { 'cf-mitigated': 'challenge' }, body: '<html><body>' + 'text '.repeat(1000) + '</body></html>' },
    '/real': { file: 'acme/terms-with-recaptcha.html' }
  } });
  try {
    for (const p of ['/terms', '/privacy', '/quiz', '/header']) {
      const r = await run([site.base + p, '--type', 'tos'], { db: path.join(tmp(), 'd.sqlite') });
      assert.equal(r.code, 5, p + ': ' + r.err);
      assert.match(r.err, /REFUSED \(captcha\)/);
    }
    const ok = await run([site.base + '/real', '--type', 'tos'], { db: path.join(tmp(), 'd.sqlite') });
    assert.equal(ok.code, 0, ok.err);
  } finally { await site.close(); }
});

test('follows redirects (max 5), records final URL, re-checks robots for the target', async () => {
  const other = await startSite({ routes: { '/terms': { file: 'acme/terms.html' }, '/blocked': { file: 'acme/terms.html' } }, robots: 'User-agent: *\nDisallow: /blocked\n' });
  const site = await startSite({ routes: {
    '/old-terms': { status: 301, headers: { location: '/terms' } },
    '/terms': { file: 'acme/terms.html' },
    '/x-origin': { status: 302, headers: { location: other.base + '/terms' } },
    '/x-blocked': { status: 302, headers: { location: other.base + '/blocked' } },
    '/loop': { status: 302, headers: { location: '/loop' } }
  } });
  try {
    const db = path.join(tmp(), 'd.sqlite');
    const r = await run([site.base + '/old-terms'], { db });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp('url: ' + site.base.replace(/\./g, '\\.') + '/terms'));
    assert.equal((await run([site.base + '/x-origin'], { db: path.join(tmp(), 'd2.sqlite') })).code, 0);
    assert.ok(other.hits.some((h) => h.url === '/robots.txt'), 'robots of the redirect target was fetched');
    const b = await run([site.base + '/x-blocked'], { db: path.join(tmp(), 'd3.sqlite') });
    assert.equal(b.code, 3, 'redirect target disallowed by its robots.txt');
    assert.equal(other.pageHits().filter((h) => h.url === '/blocked').length, 0);
    const l = await run([site.base + '/loop'], { db: path.join(tmp(), 'd4.sqlite') });
    assert.equal(l.code, 7);
    assert.match(l.err, /Too many redirects/);
  } finally { await site.close(); await other.close(); }
});

test('a page that is not a terms page is not stored; candidate links are listed; --type overrides', async () => {
  const site = await startSite({ routes: acmeRoutes() });
  const db = path.join(tmp(), 'd.sqlite');
  try {
    const r = await run([site.base + '/signup'], { db });
    assert.equal(r.code, 6);
    assert.match(r.err, /does not look like a terms/);
    assert.match(r.err, /tos\t.*\/terms/);
    assert.match(r.err, /privacy\t.*\/privacy/);
    assert.match((await run(['list'], { db, delay: null })).out, /nothing stored/);
    assert.equal((await run([site.base + '/news', '--type', 'other'], { db })).code, 0);
    assert.match((await run(['list'], { db, delay: null })).out, /other\tv1/);
  } finally { await site.close(); }
});

test('--links lists candidates and stores nothing', async () => {
  const site = await startSite({ routes: acmeRoutes() });
  const db = path.join(tmp(), 'd.sqlite');
  try {
    const r = await run([site.base + '/signup', '--links'], { db });
    assert.equal(r.code, 0);
    assert.deepEqual(r.out.trim().split('\n').map((l) => l.split('\t')[0]), ['tos', 'privacy', 'eula', 'cookies']);
    assert.match((await run(['list'], { db, delay: null })).out, /nothing stored/);
    assert.equal(site.pageHits().length, 1, 'does not follow any of the links');
  } finally { await site.close(); }
});

test('no links on the page: tells the user to paste a URL', async () => {
  const site = await startSite({ routes: { '/': { file: 'nolinks/index.html' } } });
  try {
    const r = await run([site.base + '/', '--links'], { db: path.join(tmp(), 'd.sqlite') });
    assert.equal(r.code, 0);
    assert.match(r.out, /No terms\/privacy\/EULA\/cookie links found.*Paste the URL/);
  } finally { await site.close(); }
});

test('rate limit: two runs against one host are spaced by --delay (kept across runs in the dataset)', async () => {
  const site = await startSite({ routes: acmeRoutes() });
  const db = path.join(tmp(), 'd.sqlite');
  try {
    assert.equal((await run([site.base + '/terms'], { db, delay: '700' })).code, 0);
    const first = site.hits.map((h) => h.at);
    assert.equal((await run([site.base + '/privacy'], { db, delay: '700' })).code, 0);
    const all = site.hits.map((h) => h.at);
    // within a run: robots.txt then page are >= 700ms apart
    assert.ok(first[1] - first[0] >= 650, `gap in run: ${first[1] - first[0]}`);
    // across runs: last request of run 1 -> first request of run 2
    assert.ok(all[first.length] - first[first.length - 1] >= 650, `gap across runs: ${all[first.length] - first[first.length - 1]}`);
  } finally { await site.close(); }
});

test('honours robots Crawl-delay (capped)', async () => {
  const site = await startSite({ routes: acmeRoutes(), robots: 'User-agent: *\nCrawl-delay: 1\n' });
  try {
    const r = await run([site.base + '/terms'], { db: path.join(tmp(), 'd.sqlite') });
    assert.equal(r.code, 0, r.err);
    const [robots, page] = site.hits;
    assert.ok(page.at - robots.at >= 900, `crawl-delay gap: ${page.at - robots.at}`);
  } finally { await site.close(); }
});

test('refuses PDFs / unsupported types, missing pages, and bad input', async () => {
  const site = await startSite({ routes: { '/terms.pdf': { headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.4' }, '/logo': { headers: { 'content-type': 'image/png' }, body: 'x' } } });
  try {
    const db = path.join(tmp(), 'd.sqlite');
    const pdf = await run([site.base + '/terms.pdf'], { db });
    assert.equal(pdf.code, 9, pdf.err); assert.match(pdf.err, /pdftotext/); assert.match(pdf.err, /pending owner approval/);
    assert.match((await run(['list'], { db, delay: null })).out, /NEEDS pdftotext/, 'marked, not stored as text');
    assert.equal((await run([site.base + '/logo'], { db })).code, 7);
    assert.equal((await run([site.base + '/missing'], { db })).code, 7);
    assert.equal((await run(['not a url'], { db })).code, 2);
    assert.equal((await run(['ftp://example.test/terms'], { db })).code, 2);
    assert.equal((await run(['http://user:pw@127.0.0.1:1/terms'], { db })).code, 2, 'embedded credentials refused');
    assert.equal((await run([site.base + '/x', '--type', 'bogus'], { db })).code, 2);
  } finally { await site.close(); }
});

test('stored raw HTML is kept for audit; --no-raw drops it', async () => {
  const site = await startSite({ routes: acmeRoutes() });
  const { DatabaseSync } = require('node:sqlite');
  try {
    const d1 = path.join(tmp(), 'a.sqlite'), d2 = path.join(tmp(), 'b.sqlite');
    assert.equal((await run([site.base + '/terms'], { db: d1 })).code, 0);
    assert.equal((await run([site.base + '/terms', '--no-raw'], { db: d2 })).code, 0);
    const q = (f) => { const db = new DatabaseSync(f); const row = db.prepare('SELECT length(raw_blob) AS n, private_only, user_agent, content_hash_clean AS h, clean_text FROM version').get(); db.close(); return row; };
    assert.ok(q(d1).n > 1000); assert.equal(q(d2).n, null);
    assert.equal(q(d1).private_only, 1);
    assert.match(q(d1).user_agent, /^tc-collect/);
    assert.match(q(d1).h, /^[0-9a-f]{64}$/);
    assert.ok(!q(d1).clean_text.includes('jane.doe@example.test'), 'account info of the page chrome is not stored in clean text');
  } finally { await site.close(); }
});

test('export: JSONL metadata only by default; text only with --include-text', async () => {
  const site = await startSite({ routes: acmeRoutes() });
  const db = path.join(tmp(), 'd.sqlite');
  try {
    assert.equal((await run([site.base + '/terms'], { db })).code, 0);
    const meta = JSON.parse((await run(['export'], { db, delay: null })).out.trim());
    assert.equal(meta.private_only, true);
    assert.equal(meta.versions[0].text, undefined);
    assert.match(meta.versions[0].sha256, /^[0-9a-f]{64}$/);
    const full = await run(['export', '--include-text'], { db, delay: null });
    assert.match(JSON.parse(full.out.trim()).versions[0].text, /Paid plans renew/);
    assert.match(full.err, /private until a lawyer approves/);
  } finally { await site.close(); }
});

test('default dataset location is outside the working directory (not inside any repo)', () => {
  const { defaultDbPath } = require('../cli/src/store');
  const saved = process.env.TC_COLLECT_DB; delete process.env.TC_COLLECT_DB;
  try { assert.ok(path.isAbsolute(defaultDbPath())); assert.match(defaultDbPath(), /tc-collect[\\/]dataset\.sqlite$/); }
  finally { if (saved) process.env.TC_COLLECT_DB = saved; }
});
