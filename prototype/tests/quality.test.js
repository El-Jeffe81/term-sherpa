'use strict';
// Quality tests: page-chrome stripping, sections, collapsed text, language lists, i18n links, legal hubs, PDFs,
// the quality report and old-dataset migration. Offline: local fixture servers only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startSite, read } = require('./helpers/server');
const { parseHtml } = require('../cli/src/htmltree');
const Extract = require('../extension/core/extract');
const Detect = require('../extension/core/detect');
const Qual = require('../extension/core/quality');

const HARNESS = path.join(__dirname, 'helpers', 'cli-test-entry.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tc-q-'));
function cli(args, { allow, db } = {}) {
  return new Promise((resolve) => {
    const a = [HARNESS, ...args]; if (db) a.push('--db', db); a.push('--delay', '0');
    const c = spawn(process.execPath, a, { env: { ...process.env, TC_TEST_ALLOW_ORIGINS: allow.join(',') } });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
}
const SITE_ROUTES = {
  '/langlist/terms': { file: 'langlist/terms.html' }, '/accordion/terms': { file: 'accordion/terms.html' }, '/legal': { file: 'hub/legal.html' },
  '/i18n': { file: 'i18n/index.html' }, '/es/terminos': { file: 'i18n/terminos.html' }, '/terms': { file: 'acme/terms.html' },
  '/files/terms-2026.pdf': { headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.4 fake' }, '/privacy': { file: 'acme/privacy.html' }
};
async function withSite(fn) {
  const site = await startSite({ routes: SITE_ROUTES });
  const db = path.join(tmp(), 'd.sqlite');
  const c = (args) => cli(args, { allow: [site.origin], db });
  try { await fn({ site, db, c }); } finally { await site.close(); }
}

// ---- language lists / page chrome ---------------------------------------------------------------------------------------
test('a language list inside <main> is dropped, and so are nav, footer and the cookie banner', async () => {
  await withSite(async ({ site, c }) => {
    assert.equal((await c([site.base + '/langlist/terms'])).code, 0);
    const out = await c(['sections', site.base + '/langlist/terms']);
    assert.ok(!/Espa|Deutsch|Fran|Portugu|Italiano/.test(out.out), 'language names are not sections');
    const t = (await c(['export', '--include-text'])).out;
    assert.ok(!/Español|Français|Deutsch|Português|Italiano|Home|Pricing|2026 Acme Example/.test(t), 'no language names or chrome in the text');
    assert.match(t, /Paid plans renew automatically/);
  });
});

test('isLanguageList: detects a switcher, but not a real list of terms bullets', () => {
  const sw = parseHtml('<ul><li><a hreflang="en" href="/t">English</a></li><li><a hreflang="es" href="/es/t">Español</a></li><li><a hreflang="fr" href="/fr/t">Français</a></li><li><a hreflang="de" href="/de/t">Deutsch</a></li></ul>');
  const ul = (function f(n) { if (n.t === 'el' && n.tag === 'ul') return n; for (const k of n.kids || []) { const r = k.t === 'el' && f(k); if (r) return r; } return null; })(sw);
  assert.equal(Extract.isLanguageList(ul), true);
  const bullets = parseHtml('<ul><li>Be kind</li><li>Obey the law</li><li><a href="/rules">Read the rules</a></li></ul>');
  const ul2 = (function f(n) { if (n.t === 'el' && n.tag === 'ul') return n; for (const k of n.kids || []) { const r = k.t === 'el' && f(k); if (r) return r; } return null; })(bullets);
  assert.equal(Extract.isLanguageList(ul2), false);
});

test('main/article is preferred; page chrome and account strips are excluded (acme fixture)', () => {
  const ex = Extract.extractMainText(parseHtml(read('acme/terms.html')));
  assert.ok(!/jane\.doe|Accept all|Cookie settings|My account|track\(/.test(ex.text));
  assert.match(ex.text, /Paid plans renew/);
});

// ---- sections ---------------------------------------------------------------------------------------------------------
test('documents are split into sections (heading, anchor, text) and stored; `sections` lists them', async () => {
  await withSite(async ({ site, db, c }) => {
    assert.equal((await c([site.base + '/terms'])).code, 0);
    const out = (await c(['sections', site.base + '/terms'])).out.trim().split('\n');
    assert.ok(out.length >= 8, out.join('\n'));
    assert.ok(out.some((l) => /1\. Using the service\t#1-using-the-service\t\d+ chars/.test(l)));
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(db);
    const rows = d.prepare('SELECT heading, anchor, level, text FROM section ORDER BY idx').all();
    const full = d.prepare('SELECT clean_text FROM version').get().clean_text;
    d.close();
    assert.ok(rows.length >= 8 && rows.every((r) => r.anchor && typeof r.text === 'string'));
    for (const r of rows) if (r.text) assert.ok(full.replace(/\s+/g, ' ').includes(r.text.replace(/\s+/g, ' ')), 'section text is a verbatim part of the document: ' + r.heading);
    // a changed document replaces nothing silently: versions keep their own sections
    assert.equal((await c(['sections', site.base + '/terms', '--version', '1'])).code, 0);
    assert.equal((await c(['sections', site.base + '/terms', '--version', '9'])).code === 0, false);
  });
});

test('collapsed content (details/summary and aria-expanded accordions) is read from the DOM, without clicking', async () => {
  await withSite(async ({ site, c }) => {
    assert.equal((await c([site.base + '/accordion/terms'])).code, 0);
    const t = (await c(['export', '--include-text'])).out;
    assert.match(t, /starts collapsed inside a details element/);
    assert.match(t, /hidden accordion panel/);
    assert.match(t, /individual arbitration/);
    assert.match(t, /We may suspend or close accounts/);
    const s = (await c(['sections', site.base + '/accordion/terms'])).out;
    for (const h of ['1. Using the service', '3. Paid plans', '4. Disputes', '5. Ending your account']) assert.ok(s.includes(h), h);
  });
});

test('accordion panels inside page chrome (nav/footer menus) are still not collected', () => {
  const html = '<html><body><nav><button aria-expanded="false" aria-controls="m">Menu</button><div id="m" hidden><a href="/x">Secret nav item</a> Some menu text</div></nav><main><h1>Terms of Service</h1><p>' + 'Real terms text. '.repeat(30) + '</p></main></body></html>';
  const ex = Extract.extractMainText(parseHtml(html));
  assert.ok(!/Secret nav item|menu text/.test(ex.text));
  assert.match(ex.text, /Real terms text/);
});

// ---- non-English links ------------------------------------------------------------------------------------------------
test('non-English legal links are detected with their language (es, fr, de, pt, it)', async () => {
  await withSite(async ({ site, c }) => {
    const r = await c([site.base + '/i18n', '--links']);
    assert.equal(r.code, 0, r.err);
    const rows = r.out.trim().split('\n').map((l) => l.split('\t'));
    const find = (lang, type) => rows.find((x) => x[0] === type && x[2] === lang);
    for (const [lang, type] of [['es', 'tos'], ['es', 'privacy'], ['fr', 'tos'], ['fr', 'privacy'], ['de', 'tos'], ['de', 'privacy'], ['pt', 'tos'], ['pt', 'privacy'], ['it', 'tos'], ['it', 'privacy']]) {
      assert.ok(find(lang, type), `${lang} ${type} link missing:\n${r.out}`);
    }
    // English links still sort before translated ones of the same type
    assert.equal(rows.find((x) => x[0] === 'tos').slice(2, 3)[0], 'en');
  });
});

test('detect: language text/href patterns, hreflang and /xx/ prefixes', () => {
  const L = (text, href, extra = {}) => Detect.classifyLink(Object.assign({ text, href }, extra), 'https://x.example/');
  assert.deepEqual([L('Términos y condiciones', '/a').language, L('Términos y condiciones', '/a').doc_type], ['es', 'tos']);
  assert.deepEqual([L('Politique de confidentialité', '/b').language, L('Politique de confidentialité', '/b').doc_type], ['fr', 'privacy']);
  assert.equal(L('Datenschutzerklärung', '/c').language, 'de');
  assert.equal(L('Política de Privacidade', '/d').language, 'pt', 'privacidade is Portuguese, not Spanish');
  assert.equal(L('Informativa sulla privacy', '/e').language, 'it');
  assert.equal(L('Privacy Policy', '/privacy').language, 'en');
  assert.equal(L('Legal', '/x', { hreflang: 'pt-BR' }).doc_type, 'other', 'a bare "Legal" link is never a terms/privacy document');
  assert.equal(L('Nutzungsbedingungen', '/de/foo').non_english, true);
});

test('classifyPage: a non-English terms page is recognised from its heading', async () => {
  await withSite(async ({ site, c }) => {
    const r = await c([site.base + '/es/terminos']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /language: es/);
  });
});

// ---- legal hubs --------------------------------------------------------------------------------------------------------
test('a legal hub page is not stored as a document; its links are listed (CLI)', async () => {
  await withSite(async ({ site, c }) => {
    const r = await c([site.base + '/legal']);
    assert.equal(r.code, 6, r.err);
    assert.match(r.err, /legal-hub/);
    for (const k of ['/terms', '/privacy', '/eula', '/cookies']) assert.ok(r.err.includes(k), k);
    assert.match((await c(['list'])).out, /nothing stored/);
    const l = await c([site.base + '/legal', '--links']);
    assert.match(l.out, /legal hub/i);
  });
});

test('classifyPage: hub vs document, and sensitive paths are never documents', () => {
  const links = ['tos', 'privacy', 'eula'].map((t, i) => ({ url: 'https://x.example/' + t, text: t, doc_type: t, region: 'body' }));
  assert.equal(Detect.classifyPage({ url: 'https://x.example/legal', title: 'Legal', h1: 'Legal', textLength: 400, links }).isHub, true);
  assert.equal(Detect.classifyPage({ url: 'https://x.example/terms', title: 'Terms of Service', h1: 'Terms of Service', textLength: 20000, links: [] }).isTerms, true);
  for (const p of ['/checkout/terms', '/account/terms-of-service', '/account/settings', '/checkout', '/cart', '/billing/payment', '/login', '/orders/123']) {
    const c = Detect.classifyPage({ url: 'https://x.example' + p, title: 'Terms of Service', h1: 'Terms of Service', textLength: 20000, links: [] });
    assert.equal(c.isTerms, false, p); assert.equal(c.sensitive, true, p);
  }
});

// ---- PDFs --------------------------------------------------------------------------------------------------------------
test('a PDF is detected, marked "needs pdftotext", and not stored as text', async () => {
  await withSite(async ({ site, db, c }) => {
    const r = await c([site.base + '/files/terms-2026.pdf']);
    assert.equal(r.code, 9, r.err);
    assert.match(r.err, /pdftotext/);
    assert.match((await c(['list'])).out, /NEEDS pdftotext/);
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(db);
    assert.equal(d.prepare('SELECT count(*) AS n FROM version').get().n, 0, 'no text version stored');
    assert.equal(d.prepare('SELECT needs_partner FROM document').get().needs_partner, 'pdftotext');
    d.close();
    const q = await c(['quality', '--json']);
    const rep = JSON.parse(q.out);
    assert.equal(rep.by_grade.pending, 1); assert.equal(rep.by_issue['needs-pdftotext'], 1);
    // a PDF link on a page is flagged too
    assert.match((await c([site.base + '/i18n', '--links'])).out, /PDF \(needs pdftotext\)/);
  });
});

// ---- quality report ----------------------------------------------------------------------------------------------------
test('quality report: grades, issue counts and languages across a small dataset; --json is valid', async () => {
  await withSite(async ({ site, c }) => {
    for (const p of ['/terms', '/privacy', '/es/terminos', '/accordion/terms']) assert.equal((await c([site.base + p])).code, 0, p);
    assert.equal((await c([site.base + '/files/terms-2026.pdf'])).code, 9);
    const rep = JSON.parse((await c(['quality', '--json'])).out);
    assert.equal(rep.total, 5);
    assert.equal(rep.by_grade.pending, 1);
    assert.equal(rep.by_language.es, 1);
    assert.ok(rep.by_issue['non-english'] >= 1);
    assert.ok(rep.documents.every((d) => ['ok', 'review', 'poor', 'pending'].includes(d.grade)));
    const text = (await c(['quality'])).out;
    assert.match(text, /Dataset quality report/); assert.match(text, /needs-pdftotext/);
  });
});

test('assessDocument: flags short text, chrome leftovers, repeated text, lost structure, sanitized chars and injection hints', () => {
  const base = { url: 'u', doc_type: 'tos', needs_partner: null, last_checked_at: new Date().toISOString(), lang: 'en', sections: [], rawBytes: 0 };
  const codes = (d) => Qual.assessDocument(d).issues.map((i) => i.code);
  assert.ok(codes({ ...base, text: 'Short text.' }).includes('too-short'));
  assert.ok(codes({ ...base, text: '' }).includes('no-text'));
  assert.ok(codes({ ...base, text: 'Accept all cookies\n' + 'Real sentence about the service and your rights. '.repeat(40) }).includes('chrome-leftover'));
  const rep = 'This clause is repeated word for word in the document, again and again.';
  assert.ok(codes({ ...base, text: Array(8).fill(rep).join('\n\n') }).includes('repeated-text'));
  assert.ok(codes({ ...base, text: 'x '.repeat(2500) , sections: [{ heading: 'A', text: 'x' }] }).includes('few-headings'));
  assert.ok(codes({ ...base, text: 'word '.repeat(300), removedChars: 5, injectionHints: 2 }).includes('sanitized-chars'));
  assert.ok(codes({ ...base, text: 'word '.repeat(300), injectionHints: 2 }).includes('injection-hint'));
  assert.equal(Qual.assessDocument({ ...base, text: null, needs_partner: 'pdftotext' }).grade, 'pending');
  assert.ok(codes({ ...base, text: 'word '.repeat(300), last_checked_at: '2020-01-01T00:00:00Z' }).includes('stale'));
});

test('guessLanguage: en, es, fr, de, pt, it from stop words', () => {
  const s = {
    en: 'You may use the service if you follow these terms and all of the laws that apply to you and your account.',
    es: 'Puedes usar el servicio si cumples con estos términos y todas las leyes que se aplican a tu cuenta y a los datos.',
    fr: 'Vous pouvez utiliser le service si vous respectez ces conditions et toutes les lois qui sont applicables à votre compte.',
    de: 'Sie dürfen den Dienst nutzen, wenn Sie diese Bedingungen und alle Gesetze, die für Ihr Konto gelten, einhalten und die Daten.',
    pt: 'Você pode usar o serviço se cumprir estes termos e todas as leis que se aplicam à sua conta e aos seus dados.',
    it: 'Puoi usare il servizio se rispetti questi termini e tutte le leggi che si applicano al tuo account e ai tuoi dati.'
  };
  for (const [l, t] of Object.entries(s)) assert.equal(Qual.guessLanguage(t + ' ' + t + ' ' + t).lang, l, l);
  assert.equal(Qual.guessLanguage('12345 !!!').lang, 'unknown');
});

// ---- migration & dependency rules ---------------------------------------------------------------------------------------
test('an older dataset file (before sections/needs_partner/lang) is migrated in place and keeps its data', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(tmp(), 'old.sqlite');
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE source (source_id INTEGER PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'web', app_or_site_id TEXT NOT NULL UNIQUE, name TEXT, locale TEXT);
    CREATE TABLE document (doc_id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, doc_type TEXT NOT NULL, url TEXT NOT NULL UNIQUE, final_url TEXT, discovered_via TEXT, robots_checked_at TEXT, robots_allowed INTEGER, license_note TEXT, first_seen_at TEXT, last_checked_at TEXT);
    CREATE TABLE version (version_id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL, seq INTEGER NOT NULL, fetched_at TEXT NOT NULL, http_status INTEGER, mime_type TEXT, user_agent TEXT, content_hash_raw TEXT, content_hash_clean TEXT NOT NULL, raw_blob BLOB, clean_text TEXT NOT NULL, prev_version_id INTEGER, diff_from_prev TEXT, extractor TEXT, title TEXT, copyright_note TEXT, private_only INTEGER NOT NULL DEFAULT 1, UNIQUE (doc_id, seq));
    CREATE TABLE host_throttle (host TEXT PRIMARY KEY, last_request_ms INTEGER NOT NULL);
    INSERT INTO source (source_id, app_or_site_id, name) VALUES (1, 'old.example', 'old.example');
    INSERT INTO document (doc_id, source_id, doc_type, url, first_seen_at, last_checked_at) VALUES (1, 1, 'tos', 'https://old.example/terms', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO version (version_id, doc_id, seq, fetched_at, content_hash_clean, clean_text, title) VALUES (1, 1, 1, '2026-01-01T00:00:00Z', 'abc', 'Old stored terms text that predates sections. ${'More words. '.repeat(100)}', 'Old terms');`);
  d.close();
  const out = await cli(['list'], { allow: [], db: file });
  assert.equal(out.code, 0, out.err); assert.match(out.out, /old\.example\/terms/);
  const q = JSON.parse((await cli(['quality', '--json'], { allow: [], db: file })).out);
  assert.equal(q.total, 1); assert.ok(q.by_issue['no-sections'] >= 1, 'old rows are flagged "re-collect to refresh"');
  assert.match((await cli(['verify', 'https://old.example/terms', '--quote', 'More words. More words.'], { allow: [], db: file })).out, /VERIFIED/);
});

test('zero third-party dependencies still holds for every new file (only relative or node: requires)', () => {
  const files = ['cli/src/netguard-dns.js', 'cli/src/fetcher.js', 'cli/src/collect.js', 'cli/src/store.js', 'cli/bin/tc-collect.js', 'tests/helpers/cli-test-entry.js'];
  for (const f of files) {
    for (const m of fs.readFileSync(path.join(__dirname, '..', f), 'utf8').matchAll(/require\('([^']+)'\)/g)) assert.ok(m[1].startsWith('.') || m[1].startsWith('node:'), `${f}: ${m[1]}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.deepEqual([pkg.dependencies, pkg.devDependencies], [{}, {}]);
});
