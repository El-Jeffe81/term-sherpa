'use strict';
// Firefox-only DNS check (core/dnsguard.js) with a MOCK resolver (no real DNS), and how docfetch uses it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TCDnsGuard = require('../extension/core/dnsguard');
const TCDocFetch = require('../extension/core/docfetch');
const guard = require('../extension/core/netguard');
const detect = require('../extension/core/detect');
const extract = require('../extension/core/extract');
const untrusted = require('../extension/core/untrusted');
const { parseHtml } = require('../cli/src/htmltree');

const mock = (table, calls) => async (host) => { (calls || []).push(host); if (!(host in table)) throw new Error('NS_ERROR_UNKNOWN_HOST'); return { addresses: table[host], canonicalName: host, isTRR: false }; };

test('dnsguard: public answers pass; private, loopback, link-local, CGNAT, ULA and IPv4-mapped answers are refused', async () => {
  const table = {
    'good.example': ['93.184.216.34'], 'good6.example': ['2606:2800:220:1:248:1893:25c8:1946'], 'dual.example': ['93.184.216.34', '2606:2800:220:1::1'],
    'home.example': ['192.168.1.20'], 'lo.example': ['127.0.0.1'], 'meta.example': ['169.254.169.254'], 'ten.example': ['10.1.2.3'], 'cgnat.example': ['100.64.0.1'],
    'lo6.example': ['::1'], 'ula.example': ['fd12:3456::1'], 'll6.example': ['fe80::1'], 'mapped.example': ['::ffff:127.0.0.1'], 'zero.example': ['0.0.0.0'],
    'mixed.example': ['93.184.216.34', '10.0.0.8'], 'empty.example': []
  };
  const check = TCDnsGuard.createCheck(mock(table));
  for (const h of ['good.example', 'good6.example', 'dual.example']) assert.equal(await check(h), null, h);
  for (const h of ['home.example', 'lo.example', 'meta.example', 'ten.example', 'cgnat.example', 'lo6.example', 'ula.example', 'll6.example', 'mapped.example', 'zero.example', 'mixed.example']) {
    assert.match(await check(h), /private or internal address/, h);
  }
  assert.match(await check('empty.example'), /could not be looked up/);
  assert.match(await check('nxdomain.example'), /could not be looked up/, 'a failed lookup refuses (never "assume it is fine")');
});

test('dnsguard: one lookup per site per analysis (cached), case and trailing dot ignored', async () => {
  const calls = [];
  const check = TCDnsGuard.createCheck(mock({ 'a.example': ['93.184.216.34'] }, calls));
  await Promise.all([check('a.example'), check('A.Example'), check('a.example.')]); await check('a.example');
  assert.deepEqual(calls, ['a.example']);
});

test('dnsguard: fromBrowser uses browser.dns.resolve in Firefox and gives null where it does not exist (Chrome/Edge)', async () => {
  assert.equal(TCDnsGuard.fromBrowser({}), null);
  assert.equal(TCDnsGuard.fromBrowser({ browser: {} }), null);
  assert.equal(TCDnsGuard.fromBrowser({ chrome: { dns: {} } }), null, 'Chrome has no dns API; behaviour unchanged');
  const seen = [];
  const c = TCDnsGuard.fromBrowser({ browser: { dns: { resolve: async (h) => { seen.push(h); return { addresses: ['10.0.0.1'] }; } } } });
  assert.match(await c('x.example'), /private or internal/); assert.deepEqual(seen, ['x.example']);
});

test('docfetch: with a dnsCheck, a name pointing at a private address is never requested (not even robots.txt); without one nothing changes', async () => {
  const LONG = '<p>' + 'You agree that we may collect and use information about you to run the service. '.repeat(8) + '</p>';
  const html = '<!doctype html><html lang="en"><head><title>Terms</title></head><body><main><h1>Terms</h1>' + LONG + '</main></body></html>';
  const calls = [];
  const fetch = async (url) => { calls.push(url); const b = new TextEncoder().encode(url.endsWith('robots.txt') ? 'User-agent: *\nAllow: /' : html);
    return { ok: true, status: 200, url, type: 'basic', redirected: false, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (url.endsWith('robots.txt') ? 'text/plain' : 'text/html') : null) }, body: { getReader() { let d = false; return { read: async () => (d ? { done: true } : ((d = true), { done: false, value: b })), cancel() {} }; } } }; };
  const base = { fetch, parseHtml, guard, detect, extract, untrusted };
  const dnsCheck = TCDnsGuard.createCheck(mock({ 'evil.example': ['192.168.0.10'], 'fine.example': ['93.184.216.34'] }));
  const docs = [{ url: 'https://evil.example/terms', label: 'Terms', doc_type: 'tos' }, { url: 'https://fine.example/terms', label: 'Terms', doc_type: 'tos' }];

  const withDns = await TCDocFetch.fetchAll(docs, Object.assign({ dnsCheck }, base));
  assert.equal(withDns[0].ok, false); assert.match(withDns[0].reason, /^not opened: its name points to a private or internal address/);
  assert.equal(withDns[1].ok, true);
  assert.ok(!calls.some((u) => u.includes('evil.example')), 'no request of any kind went to the private-resolving host: ' + calls);

  calls.length = 0;
  const noDns = await TCDocFetch.fetchAll([docs[0]], base);
  assert.equal(noDns[0].ok, true, 'Chrome/Edge: no dnsCheck, behaviour unchanged (static checks only)');
});

test('the dns permission is in the Firefox overlay only, and only dnsguard.js touches browser.dns', () => {
  const overlay = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifests', 'firefox.overlay.json'), 'utf8'));
  const shared = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
  assert.ok(overlay.permissions.includes('dns')); assert.ok(!shared.permissions.includes('dns'));
  assert.deepEqual(overlay.permissions.filter((p) => p !== 'dns').sort(), shared.permissions.slice().sort());
  const srcs = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.js$/.test(f)) srcs.push(f); } })(path.join(__dirname, '..', 'extension'));
  for (const f of srcs) if (!/dnsguard\.js$/.test(f)) assert.ok(!/\.dns\b/.test(fs.readFileSync(f, 'utf8').replace(/\/\*[^]*?\*\//g, '').replace(/\/\/.*$/gm, '')), f + ' must not use a dns API');
});
