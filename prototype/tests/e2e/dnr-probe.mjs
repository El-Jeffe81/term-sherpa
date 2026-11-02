// Evidence for a design decision, re-runnable:  npm run probe:dnr   (needs Chrome 1xx with Extensions.loadUnpacked over a debugging pipe)
//
// Question: can the Explain window vet a redirect target BEFORE the request goes out, using chrome.declarativeNetRequest session rules,
// without adding an install-time permission warning?  Answer measured here, in headless Chrome, with a throw-away probe extension:
//   A. permission warnings:  "declarativeNetRequest" -> "Block content on any page";  "declarativeNetRequestWithHostAccess" -> none.
//   B. plain declarativeNetRequest (+ broad host access): a session rule scoped to the extension (initiatorDomains) DOES apply to the
//      extension page's own fetch(), including redirect hops, and blocks them before they reach the server.
//   C. declarativeNetRequestWithHostAccess with access only to the document's own site: the same rule does NOT block a redirect hop to a
//      site we have no access to - the redirect is followed and, if that site sends CORS "*", its content is readable.
//   D. what ships instead: redirect:'manual' - no rule, no new permission: the redirect is reported, and the target is never requested.
// A + B + C together: the only variant that can fence redirects needs the warning, and the warning-free variant cannot.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import https from 'node:https';
import assert from 'node:assert/strict';

const CHROME = process.env.CHROME_BIN || ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find((c) => spawnSync('which', [c]).status === 0);
if (!CHROME) { console.log('SKIP: no Chrome/Chromium found (set CHROME_BIN)'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dnr-'));
if (spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tmp + '/k.pem', '-out', tmp + '/c.pem', '-days', '2', '-subj', '/CN=x', '-addext', 'subjectAltName=DNS:docs.test,DNS:other.test,DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: openssl missing'); process.exit(0); }
const mkExt = (name, manifest) => { const d = path.join(tmp, name); fs.mkdirSync(d); fs.writeFileSync(d + '/manifest.json', JSON.stringify({ manifest_version: 3, name, version: '1', ...manifest })); fs.writeFileSync(d + '/p.html', '<!doctype html><title>p</title>'); return d; };
const extPlain = mkExt('plain', { permissions: ['declarativeNetRequest', 'management'], host_permissions: ['https://*/*'] });
const extHostAccess = mkExt('hostaccess', { permissions: ['declarativeNetRequestWithHostAccess', 'management'], host_permissions: ['https://docs.test/*'] });

const hits = [];
const srv = await new Promise((r) => { const s = https.createServer({ key: fs.readFileSync(tmp + '/k.pem'), cert: fs.readFileSync(tmp + '/c.pem') }, (req, res) => {
  hits.push(req.headers.host.split(':')[0] + req.url);
  const port = s.address().port;
  const loc = { '/to-same': `https://docs.test:${port}/ok`, '/to-other': `https://other.test:${port}/ok`, '/to-localhost': `https://localhost:${port}/ok`, '/to-ip': `https://127.0.0.1:${port}/ok` }[req.url];
  if (loc) { res.writeHead(302, { location: loc, 'access-control-allow-origin': '*' }); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' }); res.end('OK from ' + req.headers.host.split(':')[0]);
}); s.listen(0, '127.0.0.1', () => r(s)); });
const port = srv.address().port;
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--ignore-certificate-errors',
  `--host-resolver-rules=MAP docs.test 127.0.0.1:${port}, MAP other.test 127.0.0.1:${port}`, `--user-data-dir=${path.join(tmp, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let id = 0, buf = ''; const pending = new Map();
chrome.stdio[4].on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\0')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); } } });
const send = (method, params = {}, sessionId) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); chrome.stdio[3].write(JSON.stringify({ id: i, method, params, sessionId }) + '\0'); });
async function openExt(dir) {
  const { id: extId } = await send('Extensions.loadUnpacked', { path: dir });
  const { targetId } = await send('Target.createTarget', { url: `chrome-extension://${extId}/p.html` });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId); await new Promise((r) => setTimeout(r, 600));
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  return { extId, ev };
}
const log = (...a) => console.log(...a);
let failed = false;
try {
  log(`Chrome: ${(await send('Browser.getVersion')).product}`);
  const base = `https://docs.test:${port}`;
  const GET = (ev, p, redirect = 'follow') => ev(`fetch(${JSON.stringify(base + p)}, { credentials: 'omit', redirect: ${JSON.stringify(redirect)} }).then(async (r) => JSON.stringify({ type: r.type, status: r.status, body: r.type === 'opaqueredirect' ? '' : await r.text() }), (e) => 'BLOCKED ' + e.message)`);
  const rule = (extId) => `chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id: 1001, priority: 1, action: { type: 'block' }, condition: { initiatorDomains: ['${extId}'], resourceTypes: ['xmlhttprequest'], excludedRequestDomains: ['docs.test'] } }] })`;

  // A
  const plain = await openExt(extPlain);
  const warn = (perms) => plain.ev(`chrome.management.getPermissionWarningsByManifest(${JSON.stringify(JSON.stringify({ manifest_version: 3, name: 'x', version: '1', permissions: perms, optional_host_permissions: ['https://*/*'] }))}).then((r) => JSON.stringify(r))`);
  const wCurrent = await warn(['activeTab', 'scripting']), wPlain = await warn(['activeTab', 'scripting', 'declarativeNetRequest']), wHost = await warn(['activeTab', 'scripting', 'declarativeNetRequestWithHostAccess']);
  log('A. install warnings: current =', wCurrent, '| +declarativeNetRequest =', wPlain, '| +declarativeNetRequestWithHostAccess =', wHost);
  assert.equal(wCurrent, '[]'); assert.match(wPlain, /Block content on any page/); assert.equal(wHost, '[]');

  // B
  for (const [p, wantServerSees] of [['/to-same', ['docs.test/to-same', 'docs.test/ok']], ['/to-other', ['docs.test/to-other']], ['/to-localhost', ['docs.test/to-localhost']], ['/to-ip', ['docs.test/to-ip']]]) { hits.length = 0; await GET(plain.ev, p); log(`   (no rule) ${p}: server saw`, JSON.stringify(hits)); }
  await plain.ev(rule(plain.extId));
  const seen = {};
  for (const p of ['/to-same', '/to-other', '/to-localhost', '/to-ip']) { hits.length = 0; seen[p] = { result: await GET(plain.ev, p), server: [...hits] }; log(`B. plain DNR rule, ${p}:`, seen[p].result.slice(0, 60), '| server saw', JSON.stringify(seen[p].server)); }
  assert.match(seen['/to-same'].result, /OK from docs\.test/);
  for (const p of ['/to-other', '/to-localhost', '/to-ip']) { assert.match(seen[p].result, /^BLOCKED/); assert.deepEqual(seen[p].server, ['docs.test' + p], 'the redirect target never reached the server'); }
  await plain.ev('chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1001] })');

  // C
  const host = await openExt(extHostAccess);
  await host.ev(rule(host.extId));
  for (const p of ['/to-other', '/to-localhost', '/to-ip']) {
    hits.length = 0; const r = await GET(host.ev, p);
    log(`C. WithHostAccess rule, ${p}:`, r.slice(0, 80), '| server saw', JSON.stringify(hits));
    assert.match(r, /OK from/, 'NOT blocked: the redirect was followed and its content was readable'); assert.equal(hits.length, 2);
  }

  // D
  for (const p of ['/to-same', '/to-other', '/to-localhost', '/to-ip']) {
    hits.length = 0; const r = await GET(host.ev, p, 'manual');
    log(`D. redirect:'manual', no rule, ${p}:`, r, '| server saw', JSON.stringify(hits));
    assert.match(r, /opaqueredirect/); assert.deepEqual(hits, ['docs.test' + p], 'only the first hop was ever requested');
  }
  log('\nPROBE OK: warning-free DNR cannot fence redirects; fenced DNR needs the "Block content on any page" warning; redirect:manual needs neither.');
} catch (e) { failed = true; console.error('PROBE FAILED:', e.message); }
try { chrome.kill('SIGKILL'); } catch {} srv.closeAllConnections(); srv.close();
setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} process.exit(failed ? 1 : 0); }, 500);
