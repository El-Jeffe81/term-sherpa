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

const ADDON_ID = 'term-sherpa@el-jeffe81.github.io';
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
    'network.dns.localDomains': 'docs.newsco.test,cmp.newsco.test',
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
  const addonDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tc-ff-e2e-'));
  fs.cpSync(pkg.dir, addonDir, { recursive: true });
  { const mf = path.join(addonDir, 'manifest.json'); const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    assert.equal(m.browser_specific_settings.gecko.id, ADDON_ID, 'shipped Firefox package carries the decided add-on ID'); }

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
  assert.deepEqual(lj.perms.slice().sort(), ['activeTab', 'dns', 'scripting', 'storage']); assert.deepEqual(lj.host || [], []); assert.deepEqual(lj.cs || [], []); assert.ok(!lj.bg || Object.keys(lj.bg).length === 0, 'no background: ' + JSON.stringify(lj.bg)); // Firefox reports absent lists as []
  assert.deepEqual(lj.opt, ['https://*/*']); assert.equal(lj.gecko, ADDON_ID); assert.deepEqual(lj.api, ['function', 'function', 'function', 'function']);
  const granted0 = JSON.parse(await execAsync('return JSON.stringify(await chrome.permissions.getAll())'));
  assert.deepEqual(granted0.origins || [], [], 'no site access at install time');
  assert.match(await text('status'), /./);
  ok('loaded manifest in Firefox: activeTab + scripting + storage (+ Firefox-only dns), no up-front host access, no content_scripts, no background; chrome.* APIs present (promises)');

  // (2) without the click the extension cannot touch the news page (activeTab not yet granted)
  const homeTabId = await execAsync(`const me = await chrome.tabs.getCurrent(); const all = await chrome.tabs.query({}); return all.map((t) => t.id).filter((i) => i !== me.id)[0];`);
  const denied = await execAsync(`try { await chrome.scripting.executeScript({ target: { tabId: args[0] }, func: () => document.title }); return 'ran'; } catch (e) { return 'denied: ' + e.message; }`, [homeTabId]);
  assert.match(String(denied), /^denied/, 'scripting must be refused before the toolbar click: ' + denied);
  ok('before the toolbar click, scripting into the page is refused (no activeTab, no host access): ' + String(denied).slice(0, 90));

  // (3) the real toolbar path: open the action popup -> launcher -> Explain window
  await chromeExec('gBrowser.removeTab(gBrowser.selectedTab); gBrowser.selectedTab = gBrowser.tabs[0]; return 1');
  await switchTo(tab0);
  const hBefore = new Set(await handles());
  const wid = 'term-sherpa_el-jeffe81_github_io-browser-action';
  const clicked = await chromeAsync(`const node = CustomizableUI.getWidget(args[0]).forWindow(window).node; const btn = node.querySelector('.unified-extensions-item-action-button');
    await window.gUnifiedExtensions.openPanel(null, 'extension_browser_action_popup');
    btn.dispatchEvent(new window.CustomEvent('command', { bubbles: true, cancelable: true, detail: { openPopupWithoutUserInteraction: false } }));
    return btn.getAttribute('data-extensionid');`, [wid]);
  assert.equal(clicked, ADDON_ID);
  const exWin = await waitFor('Explain window', async () => (await handles()).find((x) => !hBefore.has(x)));
  await switchTo(exWin);
  await waitFor('Explain page', async () => (await exec('return location.href')).includes('/explain/explain.html?tab='));
  ok('toolbar action -> popup launcher -> Explain window opened for the news tab (type "popup" window)');

  // (3a) the launcher's "already open" check depends on the extension seeing its own Explain window's address in tabs.query (no tabs permission)
  { const exUrl = await exec('return location.href'); const exTab = new URL(exUrl).searchParams.get('tab');
    const seen = await execAsync(`const ts = await chrome.tabs.query({}); const base = chrome.runtime.getURL('explain/explain.html') + '?tab='; return ts.filter((t) => (t.url || '').startsWith(base) && new URL(t.url).searchParams.get('tab') === args[0]).length;`, [exTab]);
    assert.equal(seen, 1, 'the extension sees its own Explain window in tabs.query');
    ok('launcher already-open check: the extension sees its own Explain window (explain.html?tab=' + exTab + ') through tabs.query without the tabs permission'); }

  // (3b) first run: the welcome screen comes first (once); the exact disclaimer is always at the bottom; icon in the header
  const DISCLAIMER = "Term Sherpa is a plain-English guide, not a lawyer. It isn't legal advice and can miss or misread things. Read the full terms, and ask a lawyer about anything important.";
  const shown = (id) => exec(`const e = document.getElementById(${JSON.stringify(id)}); return !e.hidden && e.getClientRects().length > 0`);
  await waitFor('welcome screen', async () => await shown('welcome')); assert.equal(await shown('app'), false);
  assert.equal(await text('disclaimer'), DISCLAIMER);
  assert.equal(await exec('const i = document.querySelector("header.brand img"); return i.complete && i.naturalWidth'), 48);
  await exec('document.getElementById("welcome-go").click(); return 1');
  await waitFor('welcome dismissed', async () => (await shown('app')) && !(await shown('welcome')));
  assert.equal(await execAsync("return (await chrome.storage.local.get('tc.welcomeSeen'))['tc.welcomeSeen']"), true);
  ok('first run in Firefox: welcome screen (icon, intro) then Continue stores the marker in storage.local; exact disclaimer shown');

  // (3c) Firefox-only DNS check with the REAL browser.dns.resolve. The test fixture name docs.newsco.test is mapped to 127.0.0.1 by
  // network.dns.localDomains - exactly the "public-looking name that points at this computer" case the check exists to refuse.
  const dnsOut = JSON.parse(await execAsync(`const c = TCDnsGuard.fromBrowser(globalThis, TCNetGuard);
    const r = { present: typeof c, fixture: await c('docs.newsco.test'), localhost: await c('localhost') };
    // a real public name: only meaningful where DNS gives real answers (some sandboxes answer every name with 198.18.0.1, a reserved address, which the check rightly refuses)
    try { const a = (await browser.dns.resolve('example.com')).addresses; r.pubAddrs = a; r.pubExpected = a.some((x) => TCNetGuard.isBlockedIp(x)) ? 'refused' : 'allowed'; r.pub = await c('example.com'); } catch (e) { r.pub = 'offline'; }
    return JSON.stringify(r);`));
  assert.equal(dnsOut.present, 'function'); assert.match(dnsOut.fixture, /private or internal address/); assert.match(dnsOut.localhost, /private or internal address/); 
  if (dnsOut.pub !== 'offline') { if (dnsOut.pubExpected === 'allowed') assert.equal(dnsOut.pub, null, 'a real public name is allowed'); else assert.match(dnsOut.pub, /private or internal address/, 'reserved answer (' + dnsOut.pubAddrs + ') refused'); }
  ok('Firefox DNS check (browser.dns.resolve): names pointing at 127.0.0.1 refused; example.com resolved to ' + dnsOut.pubAddrs + ' -> ' + (dnsOut.pub === null ? 'allowed' : dnsOut.pub === 'offline' ? 'lookup unavailable' : 'refused (reserved address)'));
  // the rest of this test serves its fixture from a name that resolves to 127.0.0.1, so switch the check off in THIS page only (test harness, not extension code)
  await exec('TCDnsGuard.fromBrowser = function () { return null; }; return 1');

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
    docs: document.getElementById('docs-count').textContent, pwned: typeof window.__tcPwned, elems: document.querySelectorAll('#app img, #app iframe, #app object, #app embed, #app script:not([src])').length })`));
  assert.match(view.status, /Read 4 documents\. Nothing was saved\./);
  assert.match(view.summary[0], /: Terms, Privacy, Cookies, Community rules \(from the agree dialog\)\.$/);
  const by = (re) => view.points.find((p) => re.test(p.line));
  const sale = by(/sell your personal data/), arb = by(/private arbitration/), track = by(/track your activity/);
  assert.ok(sale && /sev-High/.test(sale.cls) && sale.src === 'Privacy', 'data sale found in the Privacy policy');
  assert.ok(arb && arb.src === 'Terms'); assert.ok(track && track.src === 'Terms + Privacy + Cookies');
  assert.ok(view.points.every((p) => p.open && p.quotes >= 1 && p.src), 'exact wording open by default, every point labelled with its source');
  assert.equal(new Set(view.points.map((p) => p.line)).size, view.points.length);
  assert.match(view.docs, /Documents read \(4 of 4\)/);
  ok('agree dialog -> ONE combined explanation of Terms + Privacy + Cookies + Community rules (permission requested by click, documents fetched by the guarded fetch)');
  assert.equal(view.pwned, 'undefined'); assert.equal(view.elems, 0);
  assert.ok(!tlsHits.some((h) => /__should_never_load/.test(h.url)), 'no subresource of a fetched document was requested');
  ok('hostile linked document: its script / onerror did not run, its image never loaded, only text was used');

  const mine = tlsHits.slice(hitsBefore);
  assert.deepEqual(mine.map((h) => h.url).sort(), ['/community-guidelines', '/cookies', '/privacy', '/terms'], 'one GET per document, no robots.txt');
  for (const h of mine) {
    assert.equal(h.headers.cookie, undefined); assert.equal(h.headers.referer, undefined); assert.equal(h.headers.authorization, undefined);
    assert.ok(/^Mozilla\/5\.0/.test(h.headers['user-agent']) && !/terms|guide|tc-/i.test(h.headers['user-agent']), "the browser's own User-Agent: " + h.headers['user-agent']);
  }
  ok('requests: one GET per document (no robots.txt), no cookies, no Referer, no Authorization, default Firefox User-Agent');
  const g2 = JSON.parse(await execAsync('return JSON.stringify(await chrome.permissions.getAll())'));
  assert.deepEqual(g2.origins, ['https://docs.newsco.test/*'], 'only the one site was granted');
  ok('only that one site was granted: ' + g2.origins.join(', '));

  // (6) the guarded-fetch details that depend on the browser: redirects (no robots.txt check since v1.1), not followed (opaqueredirect in Firefox too),
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
  assert.equal(rd.kind, 'documents'); assert.equal(rd.read, 3); assert.equal(rd.unread, 3);
  assert.ok(!rd.items.some((t) => /Blocked Policy/.test(t) && /not read/.test(t)), 'a robots.txt Disallow no longer blocks the page: ' + JSON.stringify(rd.items));
  assert.ok(rd.items.some((t) => /Moved Terms/.test(t) && /this link sends you to another page/.test(t) && /Open it and run Term Sherpa there/.test(t)), JSON.stringify(rd.items));
  assert.ok(rd.items.some((t) => /Offsite Terms/.test(t) && /this link sends you to another page/.test(t)));
  assert.ok(rd.items.some((t) => /Internal Policy/.test(t) && /link not allowed/.test(t)));
  assert.deepEqual(tlsHits.slice(before2).map((h) => h.url).sort(), ['/blocked-by-robots', '/moved-offsite', '/moved-terms', '/privacy', '/terms'], 'no robots.txt request, the robots-disallowed page is simply read; redirect targets never requested; loopback never requested');
  ok('Firefox guarded fetch: no robots.txt check, same-site and off-site redirects NOT followed (targets never requested), loopback/http link refused; the rest still read');

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

  // (9) agree banner inside an iframe, through the real toolbar click (activeTab only, no site access): same-site frame and a frame from another site.
  // Firefox decides what activeTab covers; whichever it does, the window must either use the banner or say plainly that it could not read the frame.
  const frameFlow = async (url) => {
    const h0 = new Set(await handles());
    await chromeExec('const t = gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); gBrowser.selectedTab = t; return 1', [url]);
    const nh = await waitFor('new tab', async () => (await handles()).find((x) => !h0.has(x)));
    await switchTo(nh);
    await waitFor('frames page', async () => (await exec('return document.readyState')) === 'complete' && (await exec('return location.href')) === url);
    const before = new Set(await handles());
    await chromeAsync(`const node = CustomizableUI.getWidget(args[0]).forWindow(window).node; const btn = node.querySelector('.unified-extensions-item-action-button');
      await window.gUnifiedExtensions.openPanel(null, 'extension_browser_action_popup');
      btn.dispatchEvent(new window.CustomEvent('command', { bubbles: true, cancelable: true, detail: { openPopupWithoutUserInteraction: false } }));
      return 1;`, ['term-sherpa_el-jeffe81_github_io-browser-action']);
    const w = await waitFor('Explain window for frames page', async () => (await handles()).find((x) => !before.has(x)));
    await switchTo(w);
    await waitFor('Explain page ready', async () => (await exec('return location.href')).includes('/explain/explain.html?tab='));
    await waitFor('frames result', async () => !/^Reading the page/.test(await text('status')) && (await text('status')).length > 0);
    const out = JSON.parse(await exec(`return JSON.stringify({ status: document.getElementById('status').textContent, framesHidden: document.getElementById('frames').hidden, framesText: document.getElementById('frames-text').textContent,
      permHidden: document.getElementById('permission').hidden })`));
    return out;
  };
  const fSame = await frameFlow('https://docs.newsco.test/frames/same');
  assert.match(fSame.status, /found the consent banner \(found inside a frame from docs\.newsco\.test\)/, JSON.stringify(fSame));
  ok('Firefox, real toolbar click: a banner in a same-site iframe is found (activeTab covers same-site frames): ' + fSame.status.slice(0, 80));
  const fCross = await frameFlow('https://docs.newsco.test/frames/cross');
  const usedFrame = /found the consent banner \(found inside a frame from cmp\.newsco\.test\)/.test(fCross.status);
  const saidUnreadable = !fCross.framesHidden && /frame from another site, and I am not allowed to read inside it/.test(fCross.framesText) && /cmp\.newsco\.test/.test(fCross.framesText);
  assert.ok(usedFrame || saidUnreadable, 'cross-origin frame: either read, or plainly reported - got ' + JSON.stringify(fCross));
  ok('Firefox, real toolbar click: a banner in a frame from ANOTHER site is ' + (usedFrame ? 'read (activeTab reached the frame)' : 'reported plainly as unreadable, with the allow-that-site button'));
} catch (e) {
  console.error('FIREFOX E2E FAILED:', e.message);
  console.error(gdLog.split('\n').filter((l) => /error|exception/i.test(l)).slice(-8).join('\n'));
  process.exitCode = 1;
} finally { await cleanup(); }
if (!process.exitCode) console.log(`\nFirefox e2e: ${results.length} checks passed (${path.basename(FIREFOX)}; geckodriver)`);
