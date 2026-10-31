// Optional dev-only e2e for the FIREFOX package: loads dist/firefox into a real Firefox (headless) through geckodriver
// (WebDriver + Marionette, plain HTTP from Node built-ins, no dependency, no real sites) and runs the main flow:
//   fixture news page with an "Agree" dialog -> toolbar action (the real browserAction path: popup -> launcher -> Explain window)
//   -> permission request from a click -> the linked https documents are fetched with the guarded fetch -> one combined explanation.
// Needs: Firefox >= 140 (FIREFOX_BIN or `firefox` on PATH) and geckodriver (GECKODRIVER_BIN or on PATH). Otherwise it SKIPs.
// What a headless run cannot do: a human mouse click on the toolbar icon (the same action-button command the click triggers is dispatched
// instead) and the real permission prompt (extensions.webextOptionalPermissionPrompts=false auto-answers "Allow"). See docs/BROWSER_TESTING.md.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { startSite } = require('../helpers/server.js');
const { startDocsTls } = require('../helpers/docs-tls.js');
const { build } = require('../../scripts/build.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const which = (c) => { const r = spawnSync('which', [c]); return r.status === 0 ? r.stdout.toString().trim() : null; };
const FIREFOX = process.env.FIREFOX_BIN || which('firefox');
const GECKODRIVER = process.env.GECKODRIVER_BIN || which('geckodriver');
if (!FIREFOX || !GECKODRIVER) { console.log('SKIP: Firefox or geckodriver not found (set FIREFOX_BIN and GECKODRIVER_BIN)'); process.exit(0); }

const ADDON_ID = 'terms-guide@el-jeffe81.github.io';
const UUID = '5e1f6c7a-0b9d-4c1e-8a57-3f2d9c4b6a10'; // pinned so moz-extension://<uuid>/ is predictable
const pkg = build('firefox'); // the real Firefox package, built from the shared source
const docsTls = await startDocsTls();
if (!docsTls) { console.log('SKIP: openssl not available for the local https fixture server'); process.exit(0); }
const tlsHits = docsTls.hits;
const site = await startSite({ routes: { '/home': { file: 'newsco/home.html' }, '/terms': { file: 'acme/terms.html' } } });

const gd = spawn(GECKODRIVER, ['--port', '0', '--binary', FIREFOX], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } });
let gdLog = ''; gd.stdout.on('data', (d) => { gdLog += d; }); gd.stderr.on('data', (d) => { gdLog += d; });
let sid = null; let base = '';
const cleanup = async () => {
  try { if (sid) await fetch(`${base}/session/${sid}`, { method: 'DELETE' }); } catch {}
  try { gd.kill('SIGKILL'); } catch {}
  await site.close(); docsTls.close();
};
process.on('exit', () => { try { gd.kill('SIGKILL'); } catch {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const ok = (name) => { results.push(name); console.log('  ok -', name); };

try {
  for (let i = 0; i < 100 && !/Listening on 127\.0\.0\.1:\d+/.test(gdLog); i++) await sleep(100);
  base = 'http://127.0.0.1:' + /Listening on 127\.0\.0\.1:(\d+)/.exec(gdLog)[1];
  const call = async (m, p, b) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    const j = await r.json(); if (!r.ok) throw new Error(`${m} ${p}: ${JSON.stringify(j.value).slice(0, 500)}`); return j.value;
  };
  // Everything below runs in this throw-away profile only: docs.newsco.test -> the local https server (DNS + port 443), whose
  // certificate is added to this profile; optional-permission prompts are auto-answered so a headless run can complete.
  const prefs = {
    'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: UUID }),
    'extensions.webextOptionalPermissionPrompts': false,
    'network.dns.localDomains': 'docs.newsco.test',
    'network.socket.forcePort': `443=${docsTls.port}`,
    'app.update.enabled': false, 'datareporting.policy.dataSubmissionEnabled': false, 'browser.shell.checkDefaultBrowser': false,
  };
  const sess = await call('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { binary: FIREFOX, args: ['-headless'], prefs } } } });
  sid = sess.sessionId; const version = sess.capabilities.browserVersion;
  const S = (p) => `/session/${sid}${p}`;
  const ctx = (c) => call('POST', S('/moz/context'), { context: c });
  const exec = (script, args = []) => call('POST', S('/execute/sync'), { script, args });
  const execAsync = (body, args = []) => call('POST', S('/execute/async'), { script: `const done = arguments[arguments.length - 1]; const args = Array.prototype.slice.call(arguments, 0, -1); (async () => { ${body} })().then((v) => done(v === undefined ? null : v), (e) => done({ __error: String((e && e.message) || e) }));`, args });
  const chromeExec = async (script, args) => { await ctx('chrome'); try { return await exec(script, args); } finally { await ctx('content'); } };
  const chromeAsync = async (body, args) => { await ctx('chrome'); try { return await execAsync(body, args); } finally { await ctx('content'); } };
  const handles = () => call('GET', S('/window/handles'));
  const switchTo = (h) => call('POST', S('/window'), { handle: h });
  const waitFor = async (what, fn, ms = 20000) => { const t = Date.now(); let last; while (Date.now() - t < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(150); } throw new Error('timed out waiting for ' + what + (last ? ' (' + String(last).slice(0, 200) + ')' : '')); };
  const text = (id) => exec('return document.getElementById(arguments[0]).textContent', [id]);
  const addonDir = pkg.dir;

  const certRes = await chromeAsync(`const b64 = args[0].replace(/-----[A-Z ]+-----/g, '').replace(/\\s+/g, ''); const db = Cc['@mozilla.org/security/x509certdb;1'].getService(Ci.nsIX509CertDB); db.addCertFromBase64(b64, 'CT,C,C'); return 'added';`, [docsTls.certPem]);
  assert.equal(certRes, 'added', 'test CA imported into the throw-away profile: ' + JSON.stringify(certRes));
  const installed = await call('POST', S('/moz/addon/install'), { path: addonDir, temporary: true });
  assert.equal(installed, ADDON_ID);
  ok(`Firefox ${version}: the dist/firefox package installs (temporary add-on ${installed})`);

  // open an extension page in a tab (WebDriver cannot navigate to moz-extension:// itself; the browser UI can)
  const openExtPage = async (rel) => {
    const before = new Set(await handles());
    await chromeExec('const t = gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); gBrowser.selectedTab = t; return 1', [`moz-extension://${UUID}/${rel}`]);
    const h = await waitFor('new tab', async () => (await handles()).find((x) => !before.has(x)));
    await switchTo(h); await waitFor('page load', async () => (await exec('return document.readyState')) === 'complete');
    return h;
  };

  // the first tab is the fixture news page
  const [tab0] = await handles();
  await call('POST', S('/url'), { url: site.base + '/home' });
  await waitFor('fixture page', async () => (await exec('return document.title')).startsWith('Daily Example News'));

  // (1) what Firefox loaded
  const ext1 = await openExtPage('explain/launcher.html');
  const loaded = await exec(`const m = chrome.runtime.getManifest(); return JSON.stringify({ perms: m.permissions, host: m.host_permissions || null, cs: m.content_scripts || null, opt: m.optional_host_permissions, bg: m.background || null, gecko: m.browser_specific_settings.gecko.id, api: [typeof chrome.windows.create, typeof chrome.scripting.executeScript, typeof chrome.permissions.request, typeof chrome.tabs.create] })`);
  const lj = JSON.parse(loaded);
  assert.deepEqual(lj.perms.slice().sort(), ['activeTab', 'scripting']); assert.deepEqual(lj.host || [], []); assert.deepEqual(lj.cs || [], []); assert.ok(!lj.bg || Object.keys(lj.bg).length === 0, 'no background: ' + JSON.stringify(lj.bg)); // Firefox reports absent lists as []
  assert.deepEqual(lj.opt, ['https://*/*']); assert.equal(lj.gecko, ADDON_ID); assert.deepEqual(lj.api, ['function', 'function', 'function', 'function']);
  const granted0 = JSON.parse(await execAsync('return JSON.stringify(await chrome.permissions.getAll())'));
  assert.deepEqual(granted0.origins || [], [], 'no site access at install time');
  assert.match(await text('status'), /./);
  ok('loaded manifest in Firefox: only activeTab + scripting, no up-front host access, no content_scripts, no background; chrome.* APIs present (promises)');

  // (2) without the click the extension cannot touch the news page (activeTab not yet granted)
  const homeTabId = await execAsync(`const me = await chrome.tabs.getCurrent(); const all = await chrome.tabs.query({}); return all.map((t) => t.id).filter((i) => i !== me.id)[0];`);
  const denied = await execAsync(`try { await chrome.scripting.executeScript({ target: { tabId: args[0] }, func: () => document.title }); return 'ran'; } catch (e) { return 'denied: ' + e.message; }`, [homeTabId]);
  assert.match(String(denied), /^denied/, 'scripting must be refused before the toolbar click: ' + denied);
  ok('before the toolbar click, scripting into the page is refused (no activeTab, no host access): ' + String(denied).slice(0, 90));

  // (3) the real toolbar path: open the action popup -> launcher -> Explain window
  await chromeExec('gBrowser.removeTab(gBrowser.selectedTab); gBrowser.selectedTab = gBrowser.tabs[0]; return 1');
  await switchTo(tab0);
  const hBefore = new Set(await handles());
  const wid = 'terms-guide_el-jeffe81_github_io-browser-action';
  const clicked = await chromeAsync(`const node = CustomizableUI.getWidget(args[0]).forWindow(window).node; const btn = node.querySelector('.unified-extensions-item-action-button');
    await window.gUnifiedExtensions.openPanel(null, 'extension_browser_action_popup');
    btn.dispatchEvent(new window.CustomEvent('command', { bubbles: true, cancelable: true, detail: { openPopupWithoutUserInteraction: false } }));
    return btn.getAttribute('data-extensionid');`, [wid]);
  assert.equal(clicked, ADDON_ID);
  const exWin = await waitFor('Explain window', async () => (await handles()).find((x) => !hBefore.has(x)));
  await switchTo(exWin);
  await waitFor('Explain page', async () => (await exec('return location.href')).includes('/explain/explain.html?tab='));
  ok('toolbar action -> popup launcher -> Explain window opened for the news tab (type "popup" window)');

  // (4) the page was read (activeTab was granted by the action); documents wait for the user's click
  const hitsBefore = tlsHits.length;
  await waitFor('permission step', async () => (await exec('return !document.getElementById("perm-go").closest("section").hidden')));
  assert.match(await text('perm-text'), /Terms of Use|Terms/); assert.match(await text('perm-text'), /Your browser will ask you once/); assert.equal(tlsHits.length, hitsBefore, 'nothing is fetched before the user approves');
  const g1 = JSON.parse(await execAsync('return JSON.stringify(await chrome.permissions.getAll())'));
  assert.deepEqual(g1.origins || [], []);
  ok('news page read after the toolbar click (activeTab); the Agree dialog and its 4 links found; nothing fetched and no site access yet');

  // (5) the click: chrome.permissions.request from a real (WebDriver) click, then the guarded fetch of the documents
  const goBtn = (await call('POST', S('/element'), { using: 'css selector', value: '#perm-go' }));
  await call('POST', S(`/element/${Object.values(goBtn)[0]}/click`), {});
  try { await waitFor('explanation', async () => (await exec('return !document.getElementById("result").hidden')), 30000); }
  catch (e) { console.error('  status text: ' + (await text('status')) + ' | granted: ' + (await execAsync('return JSON.stringify(await chrome.permissions.getAll())')) + ' | hits: ' + JSON.stringify(tlsHits.map((h) => h.url)) + ' | fetch: ' + (await execAsync("try { const r = await fetch('https://docs.newsco.test/robots.txt', {credentials:'omit',redirect:'manual'}); return r.status + ' ' + r.type; } catch (e) { return 'ERR ' + e.message; }"))); throw e; }
  const view = JSON.parse(await exec(`return JSON.stringify({ status: document.getElementById('status').textContent, summary: [...document.querySelectorAll('#overview-summary li')].map((n) => n.textContent),
    points: [...document.querySelectorAll('#risk-list li.point, #also-list li.point')].map((li) => ({ line: li.querySelector('.line .text').textContent, cls: li.className, src: li.querySelector('.src') ? li.querySelector('.src').textContent : '', open: li.querySelector('details').open, quotes: li.querySelectorAll('blockquote').length })),
    docs: document.getElementById('docs-count').textContent, pwned: typeof window.__tcPwned, elems: document.querySelectorAll('img, iframe, object, embed, script:not([src])').length })`));
  assert.match(view.status, /Read 4 documents\. Nothing was saved\./);
  assert.match(view.summary[0], /: Terms, Privacy, Cookies, Community rules \(from the agree dialog\)\.$/);
  const by = (re) => view.points.find((p) => re.test(p.line));
  const sale = by(/sell your personal data/), arb = by(/private arbitration/), track = by(/track your activity/);
  assert.ok(sale && /sev-High/.test(sale.cls) && sale.src === 'Privacy', 'data sale found in the Privacy policy');
  assert.ok(arb && arb.src === 'Terms'); assert.ok(track && track.src === 'Terms + Privacy + Cookies');
  assert.ok(view.points.every((p) => !p.open && p.quotes >= 1 && p.src), 'exact wording collapsed, every point labelled with its source');
  assert.equal(new Set(view.points.map((p) => p.line)).size, view.points.length);
  assert.match(view.docs, /Documents read \(4 of 4\)/);
  ok('agree dialog -> ONE combined explanation of Terms + Privacy + Cookies + Community rules (permission requested by click, documents fetched by the guarded fetch)');
  assert.equal(view.pwned, 'undefined'); assert.equal(view.elems, 0);
  assert.ok(!tlsHits.some((h) => /__should_never_load/.test(h.url)), 'no subresource of a fetched document was requested');
  ok('hostile linked document: its script / onerror did not run, its image never loaded, only text was used');

  const mine = tlsHits.slice(hitsBefore);
  assert.deepEqual(mine.map((h) => h.url).sort(), ['/community-guidelines', '/cookies', '/privacy', '/robots.txt', '/terms'], 'one GET per document plus one robots.txt');
  for (const h of mine) {
    assert.equal(h.headers.cookie, undefined); assert.equal(h.headers.referer, undefined); assert.equal(h.headers.authorization, undefined);
    assert.ok(/^Mozilla\/5\.0/.test(h.headers['user-agent']) && !/terms|guide|tc-/i.test(h.headers['user-agent']), "the browser's own User-Agent: " + h.headers['user-agent']);
  }
  ok('requests: one GET per document + one robots.txt, no cookies, no Referer, no Authorization, default Firefox User-Agent');
  const g2 = JSON.parse(await execAsync('return JSON.stringify(await chrome.permissions.getAll())'));
  assert.deepEqual(g2.origins, ['https://docs.newsco.test/*'], 'only the one site was granted');
  ok('only that one site was granted: ' + g2.origins.join(', '));

  // (6) the guarded-fetch details that depend on the browser: robots.txt disallow, redirects not followed (opaqueredirect in Firefox too),
  // non-https / loopback links refused. Fed with the real injected-script result of the news page, like the Explain page itself does.
  const home = JSON.parse(await execAsync(`
    const src = await (await fetch(chrome.runtime.getURL('explain/explain.js'))).text();
    const files = [...(/INJECT_FILES\\s*=\\s*\\[([^\\]]+)\\]/.exec(src)[1]).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const tabId = parseInt(new URLSearchParams(location.search).get('tab'), 10);
    await chrome.scripting.executeScript({ target: { tabId }, func: (o) => { globalThis.__tcOptions = o; }, args: [{ pickedType: '' }] });
    await chrome.scripting.executeScript({ target: { tabId }, files });
    const out = await chrome.scripting.executeScript({ target: { tabId }, func: () => { const r = globalThis.__tcResult; delete globalThis.__tcResult; return r; } });
    return JSON.stringify(out[0].result);`));
  assert.equal(home.ok, true); assert.ok(home.consent && home.consent.links.length >= 4);
  const links = (extra) => home.consent.links.filter((l) => /\/(terms|privacy)$/.test(l.url)).concat(extra.map(([u, t]) => ({ url: u, text: t, doc_type: 'other', confidence: 'high', language: 'en', non_english: false, is_pdf: false, score: 3 })));
  const run = async (extra) => JSON.parse(await execAsync(`const home = args[0]; home.consent.links = args[1];
    const out = await TCExplainUI.show(home);
    return JSON.stringify({ kind: out.kind, read: out.read, unread: out.unread, items: [...document.querySelectorAll('#docs-list li')].map((li) => li.textContent.replace(/\\s+/g, ' ')) });`, [home, links(extra)]));
  const before2 = tlsHits.length;
  const rd = await run([['https://docs.newsco.test/blocked-by-robots', 'Blocked Policy'], ['https://docs.newsco.test/moved-terms', 'Moved Terms'], ['https://docs.newsco.test/moved-offsite', 'Offsite Terms'], ['http://127.0.0.1:1/internal', 'Internal Policy']]);
  assert.equal(rd.kind, 'documents'); assert.equal(rd.read, 2); assert.equal(rd.unread, 4);
  assert.ok(rd.items.some((t) => /Blocked Policy/.test(t) && /robots\.txt asks automated tools not to fetch this page/.test(t) && /Open this page/.test(t)), JSON.stringify(rd.items));
  assert.ok(rd.items.some((t) => /Moved Terms/.test(t) && /redirects are not followed/.test(t)), JSON.stringify(rd.items));
  assert.ok(rd.items.some((t) => /Offsite Terms/.test(t) && /redirects are not followed/.test(t)));
  assert.ok(rd.items.some((t) => /Internal Policy/.test(t) && /link not allowed/.test(t)));
  assert.deepEqual(tlsHits.slice(before2).map((h) => h.url).sort(), ['/moved-offsite', '/moved-terms', '/privacy', '/robots.txt', '/terms'], 'robots-disallowed page never requested; redirect targets never requested; loopback never requested');
  ok('Firefox guarded fetch: robots.txt disallow honoured, same-site and off-site redirects NOT followed (targets never requested), loopback/http link refused; the rest still read');

  // (7) the access the user granted can be removed again
  await exec(`document.getElementById('revoke').click(); return 1`);
  await waitFor('revoke', async () => /Removed access to 1 site/.test(await text('status')));
  const g3 = JSON.parse(await execAsync('return JSON.stringify(await chrome.permissions.getAll())'));
  assert.deepEqual(g3.origins || [], []);
  ok('"Remove the site access I have allowed" removes the granted site in Firefox');

  // (8) opt-in storage works in Firefox's IndexedDB (nothing is stored unless the user turns saving on)
  await openExtPage('popup/popup.html');
  const idb = JSON.parse(await execAsync(`await TCDB.clearAll();
    const a = await TCDB.saveSnapshot({ url: 'https://acme.test/terms#x', doc_type: 'tos', title: 'T', text: 'Line one\\nPaid plans renew monthly\\n' }, '2026-01-01T00:00:00Z');
    const b = await TCDB.saveSnapshot({ url: 'https://acme.test/terms', doc_type: 'tos', title: 'T', text: 'Line one\\nPaid plans renew yearly' }, '2026-01-02T00:00:00Z');
    const docs = await TCDB.listDocs(); const vers = await TCDB.getVersions('https://acme.test/terms');
    await TCDB.clearAll();
    return JSON.stringify({ a: a.status, b: b.status, docs: docs.length, vers: vers.length, after: (await TCDB.listDocs()).length });`));
  assert.deepEqual(idb, { a: 'new', b: 'changed', docs: 1, vers: 2, after: 0 });
  ok('IndexedDB wrapper works in Firefox (versions, change detection, clear)');
} catch (e) {
  console.error('FIREFOX E2E FAILED:', e.message);
  console.error(gdLog.split('\n').filter((l) => /error|exception/i.test(l)).slice(-8).join('\n'));
  process.exitCode = 1;
} finally { await cleanup(); }
if (!process.exitCode) console.log(`\nFirefox e2e: ${results.length} checks passed (${path.basename(FIREFOX)}; geckodriver)`);
