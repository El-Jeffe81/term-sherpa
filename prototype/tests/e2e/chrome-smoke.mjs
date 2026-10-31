// Optional dev-only e2e: drives the locally installed Google Chrome (headless) through the DevTools
// protocol using only Node built-ins (global WebSocket, fetch to 127.0.0.1). No dependency, no real sites.
// Verifies in a REAL browser: (1) the injected scripts (domToTree + extractor + detector) on a fixture page,
// (2) the real IndexedDB wrapper (TCDB) inside the loaded unpacked extension's popup page.
// Not verifiable headless: the activeTab user gesture itself (a human click) - see README.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { startSite } = require('../helpers/server.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = path.join(ROOT, 'extension');
const CHROME = process.env.CHROME_BIN || ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find((c) => { try { return require('node:child_process').spawnSync('which', [c]).status === 0; } catch { return false; } });
if (!CHROME) { console.log('SKIP: no Chrome/Chromium found (set CHROME_BIN)'); process.exit(0); }

// A real https server for the documents an agree dialog links to (the extension fetches https only, never loopback http).
// docs.newsco.test is mapped to it inside this throw-away Chrome only (--host-resolver-rules), with a self-signed certificate
// (--ignore-certificate-errors). Nothing in the extension is relaxed for this: the production URL guard sees a normal https URL.
const docsTls = await require('../helpers/docs-tls.js').startDocsTls(); // null when openssl is missing
const tls = docsTls && docsTls.server; const tlsHits = docsTls ? docsTls.hits : [];
const tlsFlags = tls ? ['--ignore-certificate-errors', `--host-resolver-rules=MAP docs.newsco.test 127.0.0.1:${tls.address().port}, MAP cmp.newsco.test 127.0.0.1:${tls.address().port}`] : [];

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-chrome-'));
// Pipe transport: Extensions.loadUnpacked is only available with --remote-debugging-pipe + --enable-unsafe-extension-debugging
// (branded Chrome ignores --load-extension). This flag is for this throw-away test profile only.
const chrome = spawn(CHROME, [...(process.env.TC_HEADFUL ? [] : ['--headless=new']), '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', ...tlsFlags, `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let stderr = ''; chrome.stderr.on('data', (d) => { stderr += d; });
const site = await startSite({ routes: {
  '/terms': { file: 'acme/terms.html' }, '/signup': { file: 'acme/index.html' }, '/cookies': { file: 'acme/cookies.html' }, '/privacy': { file: 'divsoup/privacy.html' },
  '/accordion/terms': { file: 'accordion/terms.html' }, '/langlist/terms': { file: 'langlist/terms.html' }, '/legal': { file: 'hub/legal.html' },
  '/hostile/terms': { headers: { 'content-type': 'text/html; charset=utf-8' }, body: fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'sites', 'hostile', 'terms.html'), 'utf8').replace('alert(2)', 'window.__pageOwnScript=1') } /* the fixture's own onerror would open a blocking dialog in a real browser; swapped for a harmless flag */, '/i18n': { file: 'i18n/index.html' }, '/about': { file: 'acme/index.html' }, '/checkout/terms': { file: 'acme/terms.html' }, '/news/terms': { file: 'newsco/terms.html' },
  '/home': { file: 'newsco/home.html' }, '/cookie-banner': { file: 'newsco/cookie-banner.html' }, '/article': { file: 'newsco/article.html' }, '/privacy-center': { file: 'mediaco/privacy-center.html' }
} });
const cleanup = async () => { try { chrome.kill('SIGKILL'); } catch {} await site.close(); if (docsTls) docsTls.close(); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {}; };
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

let id = 0; const pending = new Map(); const exceptions = [];
let buf = '';
chrome.stdio[4].on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\0')) >= 0) { const msg = buf.slice(0, i); buf = buf.slice(i + 1); onMessage(JSON.parse(msg)); } });
function onMessage(d) {
  if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.j(new Error(JSON.stringify(d.error))) : p.r(d.result); }
  else if (d.method === 'Runtime.exceptionThrown') exceptions.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
}
const send = (method, params = {}, sessionId) => new Promise((r, j) => { const i = ++id; if (process.env.TC_TRACE) console.error('->', method, JSON.stringify(params).slice(0, 120)); pending.set(i, { r, j }); chrome.stdio[3].write(JSON.stringify({ id: i, method, params, sessionId }) + '\0'); });
// Vivaldi's tabs live in its own UI (a web app), so Target.createTarget makes a tab that never loads. For such browsers (auto-detected,
// or TC_OPEN_VIA_OPENER=1) a new tab is opened with window.open() from the browser's own first tab instead; everything after that is identical.
const VIA_OPENER = !!process.env.TC_OPEN_VIA_OPENER || /vivaldi/i.test(CHROME);
let opener = null; let openerReady = false;
async function createTab() {
  if (!VIA_OPENER) return (await send('Target.createTarget', { url: 'about:blank' })).targetId;
  const pages = async () => (await send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page');
  if (!openerReady) { openerReady = true; await new Promise((r) => setTimeout(r, 5000)); } // let the browser's own UI finish starting before touching its first tab
  for (let i = 0; i < 100 && !opener; i++) { const p = (await pages()).find((t) => /^chrome-extension:/.test(t.url)); if (p) opener = (await send('Target.attachToTarget', { targetId: p.targetId, flatten: true })).sessionId; else await new Promise((r) => setTimeout(r, 200)); }
  if (!opener) throw new Error('no first tab to open new tabs from');
  const known = new Set((await pages()).map((t) => t.targetId));
  await send('Runtime.evaluate', { expression: `window.open(${JSON.stringify(site.base + '/terms')}); 1`, userGesture: true }, opener);
  for (let i = 0; i < 100; i++) { const n = (await pages()).find((t) => !known.has(t.targetId)); if (n) return n.targetId; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('window.open did not create a tab');
}
async function openTab(url) {
  const targetId = await createTab();
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId); await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url }, sessionId);
  for (let i = 0; i < 100; i++) { const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId); if (r.result.value === 'complete' && (await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId)).result.value !== 'about:blank') break; await new Promise((r2) => setTimeout(r2, 100)); }
  return { targetId, sessionId, ev: async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; } };
}

const results = []; const ok = (name) => { results.push(name); console.log('  ok -', name); };
try {
  // (1) injected scripts in a real DOM
  const inject = ['core/untrusted.js', 'core/extract.js', 'core/detect.js', 'core/consent.js', 'content/run.js'].map((f) => fs.readFileSync(path.join(EXT, f), 'utf8')).join('\n;\n');
  const runIn = async (url, opts) => { const t = await openTab(url); await t.ev(`globalThis.__tcOptions = ${JSON.stringify(opts)}`); await t.ev(inject); const r = await t.ev('JSON.stringify(globalThis.__tcResult)'); await send('Target.closeTarget', { targetId: t.targetId }); return JSON.parse(r); };

  const terms = await runIn(site.base + '/terms', {});
  assert.equal(terms.ok, true, JSON.stringify(terms));
  assert.equal(terms.page.looks_like_terms, true); assert.equal(terms.page.doc_type, 'tos');
  assert.match(terms.extracted.text, /Paid plans renew/); assert.ok(terms.extracted.text.length > 500);
  assert.ok(!/jane\.doe@example\.test/.test(terms.extracted.text), 'account chrome not captured');
  assert.equal(terms.extracted.discovered_via, 'user_page');
  assert.ok(terms.extracted.sections.length >= 8 && terms.extracted.sections.every((x) => x.heading !== undefined && x.anchor !== undefined && typeof x.text === 'string'), 'sections (heading, anchor, text)');
  ok('real DOM: terms page detected, main text and sections extracted');

  const signup = await runIn(site.base + '/signup', {});
  assert.equal(signup.extracted, null, 'a non-terms page returns no text');
  assert.deepEqual(signup.links.map((l) => l.doc_type), ['tos', 'privacy', 'eula', 'cookies']);
  assert.ok(!JSON.stringify(signup).includes('jane.doe'), 'nothing from the page itself in the result');
  ok('real DOM: signup page -> candidate links only, no page text taken');

  const picked = await runIn(site.base + '/about', { pickedType: 'other' });
  assert.equal(picked.extracted.doc_type, 'other'); assert.equal(picked.extracted.discovered_via, 'user_picked_link');
  const unpicked = await runIn(site.base + '/about', {});
  assert.equal(unpicked.extracted, null, 'without a pick, a non-terms page is never read');
  ok('real DOM: a document the user explicitly picked is read (and only then)');

  const checkout = await runIn(site.base + '/checkout/terms', { pickedType: 'tos' });
  assert.equal(checkout.page.sensitive, true); assert.equal(checkout.extracted, null, 'checkout/account pages are never captured, even if picked');
  assert.equal((await runIn(site.base + '/checkout/terms', {})).extracted, null);
  ok('real DOM: sensitive (checkout/account) page -> nothing captured');

  const hub = await runIn(site.base + '/legal', { pickedType: 'tos' });
  assert.equal(hub.page.is_hub, true); assert.equal(hub.extracted, null);
  assert.ok(hub.links.length >= 4 && hub.links.every((l) => l.url.startsWith('http')));
  ok('real DOM: legal hub page -> its links are listed, hub text is not stored');

  const acc = await runIn(site.base + '/accordion/terms', {});
  assert.match(acc.extracted.text, /starts collapsed inside a details element/); assert.match(acc.extracted.text, /hidden accordion panel/);
  assert.ok(acc.extracted.sections.length >= 4);
  ok('real DOM: collapsed accordion / <details> text is read without clicking');

  const ll = await runIn(site.base + '/langlist/terms', {});
  assert.ok(!/Español|Français|Deutsch|Português|Italiano/.test(ll.extracted.text), 'language list stripped');
  assert.match(ll.extracted.text, /Paid plans renew automatically/);
  ok('real DOM: language switcher and page chrome are not part of the stored text');

  const hostile = await runIn(site.base + '/hostile/terms', {});
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200b\u2060\ufeff]|[\udb40][\udc00-\udc7f]/.test(hostile.extracted.text), 'control, bidi, zero-width and tag characters removed');
  assert.ok(hostile.extracted.text.length > 100);
  assert.equal(hostile.extracted.doc_type, 'tos');
  ok('real DOM: hostile text is sanitized to plain data');

  const i18n = await runIn(site.base + '/i18n', {});
  const langs = new Set(i18n.links.map((l) => l.language));
  for (const l of ['es', 'fr', 'de', 'pt', 'it']) assert.ok(langs.has(l), 'link language ' + l);
  assert.ok(i18n.links.some((l) => l.is_pdf), 'a PDF link is flagged');
  ok('real DOM: non-English legal links (es, fr, de, pt, it) and PDF links detected');

  // (2) real extension popup + IndexedDB
  const { id: extId } = await send('Extensions.loadUnpacked', { path: EXT });
  const popup = await openTab(`chrome-extension://${extId}/popup/popup.html`);
  assert.equal(await popup.ev('document.title'), 'Term Sherpa');
  assert.equal(await popup.ev("typeof chrome.scripting + '/' + typeof chrome.tabs"), 'object/object');
  assert.equal(await popup.ev('document.getElementById("help").textContent'), 'Please help me');
  ok('extension loads in Chrome; popup renders with "Please help me" (id ' + extId + ')');

  const flow = await popup.ev(`(async () => {
    await TCDB.clearAll();
    const a = await TCDB.saveSnapshot({url:'https://acme.test/terms#x', doc_type:'tos', title:'T', text:'Line one\\nPaid plans renew monthly\\n'}, '2026-01-01T00:00:00Z');
    const b = await TCDB.saveSnapshot({url:'https://acme.test/terms', doc_type:'tos', title:'T', text:'Line one\\r\\nPaid plans renew monthly'}, '2026-01-02T00:00:00Z');
    const c = await TCDB.saveSnapshot({url:'https://acme.test/terms', doc_type:'tos', title:'T', text:'Line one\\nPaid plans renew yearly'}, '2026-01-03T00:00:00Z');
    const n1 = await TCDB.saveLinks([{url:'https://acme.test/privacy', text:'Privacy', doc_type:'privacy', language:'en'}, {url:'https://acme.test/terms.pdf', text:'Terms (PDF)', doc_type:'tos', is_pdf:true}, {url:'http://127.0.0.1/x', text:'loopback', doc_type:'tos'}, {url:'file:///etc/passwd', text:'file', doc_type:'tos'}], 'acme.test');
    const pk = await TCDB.pickLink({url:'https://acme.test/privacy', doc_type:'privacy'});
    const got = await TCDB.getLink('https://acme.test/privacy#top'); const pdf = await TCDB.getLink('https://acme.test/terms.pdf');
    const links = {n: n1, picked: got.picked, host: got.found_on_host, pdf: pdf.needs_partner, total: (await TCDB.listLinks()).length, hasPageUrl: JSON.stringify(await TCDB.listLinks()).includes('signup')};
    const sec = await TCDB.saveSnapshot({url:'https://acme.test/s', doc_type:'tos', title:'S', text:'A\\nB', lang:'en', sections:[{heading:'A', anchor:'#a', text:'x'}]}, '2026-01-04T00:00:00Z');
    const secV = (await TCDB.getVersions('https://acme.test/s'))[0];
    const dirty = await TCDB.saveSnapshot({url:'https://acme.test/d', doc_type:'tos', title:'D', text:'ok\\u202e text\\u200b here \\u0007'}, '2026-01-05T00:00:00Z');
    const dirtyText = (await TCDB.getVersions('https://acme.test/d'))[0].text;
    const docs = await TCDB.listDocs(); const vers = await TCDB.getVersions('https://acme.test/terms');
    const exp = await TCDB.exportAll(); const expLinks = exp.links ? exp.links.length : -1;
    await TCDB.deleteDoc('https://acme.test/terms');
    const after = (await TCDB.listDocs()).length + '/' + (await TCDB.getVersions('https://acme.test/terms')).length;
    await TCDB.clearAll(); const cleared = (await TCDB.listLinks()).length + '/' + (await TCDB.listDocs()).length;
    return JSON.stringify({links, expLinks, secSections: (secV.sections||[]).length, secLang: secV.lang, dirtyText, cleared, a:a.status,b:b.status,c:c.status,n:c.version_count,docs:docs.length,vers:vers.length,private:docs[0].private_only,sha:/^[0-9a-f]{64}$/.test(docs[0].sha256),diff:vers[1].diff_from_prev,exp:[exp.documents.length,exp.versions.length],after});
  })()`);
  const f = JSON.parse(flow);
  assert.deepEqual([f.a, f.b, f.c, f.n, f.private, f.sha, f.after], ['new', 'unchanged', 'changed', 2, true, true, '2/0']);
  assert.match(JSON.stringify(f.diff), /yearly/); assert.deepEqual(f.exp, [3, 4]);
  // version 2 data: links hold no page content, loopback/file links are refused, PDFs are flagged, sections and sanitizing apply on save
  assert.deepEqual(f.links, { n: 2, picked: true, host: 'acme.test', pdf: 'pdftotext', total: 2, hasPageUrl: false });
  assert.equal(f.expLinks, 2); assert.equal(f.secSections, 1); assert.equal(f.secLang, 'en');
  assert.equal(f.dirtyText.replace(/\s+/g, ' ').trim(), 'ok text here'); assert.equal(f.cleared, '0/0');
  ok('real IndexedDB (v2): versions + diff, links (picked, PDF flag, unsafe refused), sections, sanitizing on save, export, delete, clear');

  // (3) Explain window: launcher + explain page in the real extension, fed with the real injected-script result
  const launcher = await openTab(`chrome-extension://${extId}/explain/launcher.html`);
  assert.equal(await launcher.ev("typeof chrome.windows.create"), 'function');
  assert.match(await launcher.ev('document.getElementById("status").textContent'), /./);
  ok('launcher page loads in Chrome and chrome.windows is available without extra permission');
  const manifestPerms = JSON.parse(await launcher.ev('JSON.stringify(chrome.runtime.getManifest().permissions)'));
  assert.deepEqual(manifestPerms.sort(), ['activeTab', 'scripting', 'storage']);
  assert.equal(await launcher.ev('JSON.stringify(chrome.runtime.getManifest().host_permissions || null) + JSON.stringify(chrome.runtime.getManifest().content_scripts || null)'), 'nullnull');
  assert.equal(await launcher.ev('JSON.stringify(chrome.runtime.getManifest().optional_host_permissions)'), '["https://*/*"]');
  const grantedNow = await launcher.ev('chrome.permissions.getAll().then((a) => JSON.stringify(a))');
  assert.deepEqual(JSON.parse(grantedNow).origins || [], [], 'no site access is granted at install time');
  ok('loaded manifest: only activeTab + scripting, no up-front host access (only optional https), no content_scripts');

  const ex = await openTab(`chrome-extension://${extId}/explain/explain.html`);
  // first run: the welcome screen is shown once, before anything else, and Continue remembers it
  const DISCLAIMER = "Term Sherpa is a plain-English guide, not a lawyer. It isn't legal advice and can miss or misread things. Read the full terms, and ask a lawyer about anything important.";
  const vis = (id) => ex.ev(`!document.getElementById(${JSON.stringify(id)}).hidden && document.getElementById(${JSON.stringify(id)}).getClientRects().length > 0`);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await vis('welcome'), true, 'first run: welcome screen visible'); assert.equal(await vis('app'), false, 'nothing else is shown before Continue');
  assert.match(await ex.ev('document.getElementById("welcome").textContent'), /Nothing leaves your device[\s\S]*Nothing is saved by default/);
  assert.equal(await ex.ev('document.getElementById("welcome-go").textContent'), 'Continue');
  assert.equal(await ex.ev('document.getElementById("disclaimer").textContent'), DISCLAIMER); assert.equal(await vis('disclaimer'), true, 'disclaimer visible on the welcome screen too');
  assert.equal(await ex.ev('document.querySelector("header.brand img").complete && document.querySelector("header.brand img").naturalWidth'), 48, 'extension icon shown in the header');
  await ex.ev('document.getElementById("welcome-go").click()'); await new Promise((r) => setTimeout(r, 500));
  assert.equal(await vis('welcome'), false); assert.equal(await vis('app'), true);
  assert.equal(await ex.ev("chrome.storage.local.get('tc.welcomeSeen').then((o) => o['tc.welcomeSeen'])"), true, 'marker stored in chrome.storage.local');
  assert.match(await ex.ev('document.getElementById("status").textContent'), /click the Term Sherpa icon/i);
  ok('first run: welcome screen (icon, what it does, nothing leaves the device, nothing saved) shown once; Continue stores the marker and shows the app');
  const ex2 = await openTab(`chrome-extension://${extId}/explain/explain.html`); await new Promise((r) => setTimeout(r, 500));
  assert.equal(await ex2.ev('document.getElementById("welcome").hidden'), true, 'welcome is not shown a second time'); await send('Target.closeTarget', { targetId: ex2.targetId });
  assert.equal(await vis('disclaimer'), true); assert.equal(await ex.ev('document.getElementById("disclaimer").textContent'), DISCLAIMER);
  ok('welcome screen does not come back; the exact disclaimer is shown at the bottom of the explain window');
  const iconInfo = JSON.parse(await launcher.ev(`JSON.stringify([...Object.values(chrome.runtime.getManifest().icons), ...Object.values(chrome.runtime.getManifest().action.default_icon)])`));
  const missing = []; for (const f of [...new Set(iconInfo)]) { const okf = await launcher.ev(`fetch(chrome.runtime.getURL(${JSON.stringify(f)})).then((r) => r.ok && r.headers.get('content-type'))`); if (!/png/.test(okf || '')) missing.push(f); }
  assert.deepEqual(missing, []); ok('all icon files named in the manifest load from the installed extension (' + [...new Set(iconInfo)].length + ' files)');
  await ex.ev('TCDB.clearAll().then(() => localStorage.clear())');
  const view = async (res) => JSON.parse(await ex.ev(`(async () => {
    const out = await TCExplainUI.show(${JSON.stringify(res)});
    const q = (sel) => [...document.querySelectorAll(sel)].map((n) => n.textContent);
    const point = (li) => ({ sec: li.closest('ul').id, cls: li.className, badge: li.querySelector('.badge') ? li.querySelector('.badge').textContent : '', line: li.querySelector('.line .text').textContent,
      ctx: li.querySelector('.ctx') ? li.querySelector('.ctx').textContent : '', open: li.querySelector('details').open, toggle: li.querySelector('summary').textContent,
      quotes: [...li.querySelectorAll('blockquote')].map((b) => b.textContent), quoteVisible: [...li.querySelectorAll('blockquote')].some((b) => b.checkVisibility()) });
    return JSON.stringify({ kind: out.kind, hidden: document.getElementById('result').hidden, nothing: { hidden: document.getElementById('nothing-found').hidden, text: document.getElementById('nothing-found').textContent }, status: document.getElementById('status').textContent,
      summary: q('#overview-summary li'), points: [...document.querySelectorAll('#risk-list li.point, #also-list li.point')].map(point),
      visibleText: document.getElementById('result').innerText, imgs: document.querySelectorAll('#app img, #app script:not([src]), #app iframe, #app object, #app embed').length, docs: (await TCDB.listDocs()).length });
  })()`));
  const v1 = await view(terms);
  assert.equal(v1.kind, 'analysis'); assert.equal(v1.hidden, false);
  assert.equal(v1.docs, 0, 'default: nothing saved in IndexedDB');
  assert.match(v1.status, /Nothing was saved/);
  assert.deepEqual(v1.points.map((c) => c.cls.split(' ').pop()), ['sev-High', 'sev-High', 'sev-Medium', 'sev-Medium', 'sev-Low', 'sev-Low', 'sev-Low'], 'ranked High, Medium, Low, with the dispute points merged into one');
  assert.deepEqual(v1.points.map((c) => c.sec), ['risk-list', 'risk-list', 'risk-list', 'risk-list', 'also-list', 'also-list', 'also-list']);
  assert.ok(v1.points.every((c) => c.line.length > 10 && c.line.length < 120 && !c.open && c.toggle === 'Show exact wording' && c.quotes.length >= 1));
  assert.ok(v1.points.every((c) => !c.quoteVisible), 'exact wording is collapsed by default');
  for (const c of v1.points) for (const qt of c.quotes) assert.ok(terms.extracted.text.replace(/\s+/g, ' ').includes(qt.replace(/\s+/g, ' ')), 'quote is verbatim in the page text: ' + qt);
  assert.equal(v1.points[0].line, "Disputes go to private arbitration, and you can't join a class action lawsuit.");
  assert.ok(v1.points[0].quotes.some((x) => x.includes('individual arbitration')));
  assert.equal(v1.summary.length, 3);
  assert.ok(!/\bwords?\b|minutes|reading time|of the 12|topics/i.test(v1.visibleText), 'no word count or other filler in the visible text');
  assert.ok(!terms.extracted.text.split(/\n/).some((l) => l.length > 60 && v1.visibleText.includes(l)), 'long passages of the terms are not copied into the window');
  ok('explain window: 3-line overview, one sentence per point, ranked, exact wording collapsed and verbatim; no word count; nothing saved by default');
  assert.equal(v1.nothing.hidden, true, 'risks were found, so the "nothing found" line is not shown');
  const calmText = 'You may use this service if you follow the rules of the site and treat other people with respect. You keep ownership of what you post. You can ask us a question at any time by writing to the address on the contact page. We will answer as soon as we can. These terms describe how the service works today.';
  const calm = JSON.parse(JSON.stringify(terms)); calm.extracted.text = calmText; if (calm.extracted.sections) calm.extracted.sections = [];
  const vCalm = await view(calm);
  assert.equal(vCalm.kind, 'analysis'); assert.equal(vCalm.points.length, 0, JSON.stringify(vCalm.points));
  assert.equal(vCalm.nothing.hidden, false); assert.equal(vCalm.nothing.text, "Nothing found doesn't mean there's no risk.");
  assert.match(vCalm.visibleText, /Nothing found doesn't mean there's no risk\./);
  ok('a terms text with no risk points still shows "Nothing found doesn\'t mean there\'s no risk." (and the line is hidden when risks are listed)');

  // small screen (Firefox for Android is about 360 CSS px wide): no sideways scrolling, tap targets at least 44 px, readable text
  {
    const narrow = async (page, prep) => {
      await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 2, mobile: true }, page.sessionId);
      await new Promise((r) => setTimeout(r, 250));
      const out = JSON.parse(await page.ev(`(async () => { ${prep || ''}
        const tall = [...document.querySelectorAll('button, summary, a[href], input:not([type=checkbox]), select, label.opt')].filter((e) => e.getClientRects().length > 0 && !e.closest('[hidden]'));
        const small = tall.filter((e) => e.getBoundingClientRect().height < 44).map((e) => (e.id || e.tagName) + ':' + Math.round(e.getBoundingClientRect().height));
        const text = [...document.querySelectorAll('body *')].filter((e) => e.getClientRects().length > 0 && e.children.length === 0 && e.textContent.trim()).map((e) => parseFloat(getComputedStyle(e).fontSize));
        return JSON.stringify({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth, width: document.documentElement.clientWidth, small, minFont: Math.min(...text), controls: tall.length }); })()`));
      return out;
    };
    const open = `document.querySelectorAll('details').forEach((d) => { d.open = true; });`;
    const exN = await narrow(ex, `await TCExplainUI.show(${JSON.stringify(terms)}); ${open}`);
    assert.equal(exN.width, 360); assert.ok(exN.over <= 0, 'explain: sideways scroll ' + JSON.stringify(exN)); assert.deepEqual(exN.small, [], 'explain: small tap targets'); assert.ok(exN.minFont >= 13, 'explain: tiny text ' + exN.minFont);
    const exN2 = await narrow(ex, `for (const e of document.querySelectorAll('#app [hidden], #welcome')) e.hidden = false; ${open}`);
    assert.ok(exN2.over <= 0, 'explain (all sections shown): sideways scroll ' + JSON.stringify(exN2)); assert.deepEqual(exN2.small, [], 'explain (all sections shown): small tap targets');
    if (process.env.TC_SHOT) { const sh = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, ex.sessionId); fs.writeFileSync(process.env.TC_SHOT.replace(/\.png$/, '-phone-explain.png'), Buffer.from(sh.data, 'base64')); }
    const lN = await narrow(launcher, `document.getElementById('again').hidden = false;`);
    assert.ok(lN.over <= 0, 'launcher: sideways scroll ' + JSON.stringify(lN)); assert.deepEqual(lN.small, [], 'launcher: small tap targets');
    const pN = await narrow(popup, `for (const e of document.querySelectorAll('section[hidden]')) e.hidden = false;`);
    assert.ok(pN.over <= 0, 'popup page: sideways scroll ' + JSON.stringify(pN)); assert.deepEqual(pN.small, [], 'popup page: small tap targets');
    for (const pg of [ex, launcher, popup]) await send('Emulation.clearDeviceMetricsOverride', {}, pg.sessionId);
    ok(`360 px wide phone layout: explain window (result, and every section shown), launcher and saved-copies page - no sideways scroll, every button/link/summary at least 44 px tall, text at least 13 px (explain ${exN.controls}+${exN2.controls}, launcher ${lN.controls}, saved ${pN.controls} controls checked)`);
  }

  const nv = await view(await runIn(site.base + '/news/terms', {}));
  const liab = nv.points.find((c) => /limit what they owe/.test(c.line));
  assert.ok(liab && liab.sec === 'also-list' && liab.cls.endsWith('sev-Low'), 'on a news site limited liability is a lower concern');
  assert.match(liab.ctx, /news or media/);
  assert.match(nv.summary[1], /news \/ media/);
  assert.equal(nv.points.filter((c) => /arbitration|class action|jury/i.test(c.line)).length, 1, 'arbitration, class action and jury waiver are one line');
  ok('explain window: news-site terms are read in context (limited liability not a High risk, dispute points merged)');

  const hv = await view(await runIn(site.base + '/hostile/terms', {}));
  assert.equal(hv.imgs, 0, 'no img/script/iframe elements created from page text');
  ok('explain window: hostile page text is shown as text only (no elements created)');

  await ex.ev("localStorage.setItem('tc.saveCopies','1')");
  const v2 = await view(terms);
  assert.equal(v2.docs, 1, 'with the explicit opt-in the old collection path saves a copy');
  assert.match(v2.status, /because you turned that option on/);
  await ex.ev("localStorage.removeItem('tc.saveCopies'); TCDB.clearAll()");
  ok('opt-in "save copies" switches the old IndexedDB path on; off again afterwards');

  const lk = await view(await runIn(site.base + '/about', {}));
  assert.equal(lk.kind, 'links'); assert.equal(lk.hidden, true);
  // this fixture page has an inline "By signing up you agree to the Terms and Privacy Policy" prompt, but it is served over loopback http,
  // which the fetch guard refuses -> the two linked documents are listed (not read) with the reason
  assert.equal(await ex.ev("document.querySelectorAll('#candidate-list li').length"), 2);
  assert.match(lk.status, /none of them can be read here/);
  assert.equal(await ex.ev("localStorage.getItem('tc.saveCopies')"), null);
  ok('explain window: non-terms page -> candidate links only, no analysis, no storage');
  if (process.env.TC_SHOT) { await view(terms); const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, ex.sessionId); fs.writeFileSync(process.env.TC_SHOT, Buffer.from(shot.data, 'base64')); }


  // (4) The agree dialog: explain the documents it links to (Terms + Privacy + Cookies + ...), one combined explanation.
  if (!tls) console.log('  SKIP (4): openssl not available for the local https fixture server');
  else {
    const home = await runIn(site.base + '/home', {});
    assert.equal(home.consent.found, true); assert.equal(home.consent.kind, 'dialog'); assert.deepEqual(home.consent.buttons, ['Agree']);
    assert.deepEqual(home.consent.links.map((l) => l.doc_type), ['tos', 'privacy', 'cookies', 'other']);
    assert.equal(home.extracted, null, 'the page behind the dialog is not read');
    ok('real DOM: a CNN-style "Legal Terms and Privacy" Agree modal is found with its Terms, Privacy, Cookies and Community Guidelines links');
    const cb = await runIn(site.base + '/cookie-banner', {});
    assert.equal(cb.consent.found, true); assert.equal(cb.consent.kind, 'banner');
    const art = await runIn(site.base + '/article', {});
    assert.equal(art.consent.found, false);
    assert.equal((await runIn(site.base + '/privacy-center', {})).consent.found, false);
    ok('real DOM: cookie banner found; plain article and privacy centre have no dialog');
    // reading must never touch the dialog: keep the tab open and look at it afterwards
    {
      const t = await openTab(site.base + '/home');
      await t.ev(`globalThis.__tcOptions = {}`); await t.ev(inject); await t.ev('JSON.stringify(globalThis.__tcResult)');
      assert.equal(await t.ev('typeof window.__agreeClicked'), 'undefined', 'Agree was not clicked');
      assert.equal(await t.ev("document.querySelector('[role=dialog]').checkVisibility()"), true, 'the dialog is still showing');
      assert.equal(await t.ev("document.querySelectorAll('input:checked').length"), 0);
      await send('Target.closeTarget', { targetId: t.targetId });
      ok('real DOM: the injected reader never clicks Agree or touches the dialog');
    }

    // (4a) real manifest: nothing is read until the user approves the site
    const hitsBefore = tlsHits.length;
    const pend = JSON.parse(await ex.ev(`(async () => {
      const out = await TCExplainUI.show(${JSON.stringify(home)});
      return JSON.stringify({ kind: out.kind, docs: out.docs, origins: out.origins, permHidden: document.getElementById('permission').hidden, perm: document.getElementById('perm-text').textContent,
        btn: document.getElementById('perm-go').textContent, resultHidden: document.getElementById('result').hidden, status: document.getElementById('status').textContent,
        granted: (await chrome.permissions.getAll()).origins || [] });
    })()`));
    assert.equal(pend.kind, 'permission'); assert.deepEqual(pend.docs, ['Terms', 'Privacy', 'Cookies', 'Community rules']);
    assert.deepEqual(pend.origins, ['https://docs.newsco.test/*']);
    assert.equal(pend.permHidden, false); assert.equal(pend.resultHidden, true);
    assert.match(pend.perm, /Your browser will ask you once to allow access to that site/); assert.match(pend.btn, /Read these 4 documents/);
    assert.match(pend.status, /agree dialog/); assert.match(pend.status, /will not click it/);
    assert.deepEqual(pend.granted, []); assert.equal(tlsHits.length, hitsBefore, 'nothing was fetched before the user approved the site');
    ok('real manifest: dialog found -> a "Read these 4 documents" button, no site access, zero requests to the document server until approved');

    if (process.env.TC_SHOT) { const sh = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, ex.sessionId); fs.writeFileSync(process.env.TC_SHOT.replace(/\.png$/, '-permission.png'), Buffer.from(sh.data, 'base64')); }
    // A real mouse click (CDP Input events count as a user gesture) makes the window ask Chrome for the site access. Headless Chrome shows no
    // prompt UI, so the request just stays pending: all we can check here is that nothing is fetched without the user's answer.
    {
      const r = JSON.parse(await ex.ev("JSON.stringify(document.getElementById('perm-go').getBoundingClientRect())"));
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x + r.width / 2, y: r.y + r.height / 2, button: 'left', clickCount: 1 }, ex.sessionId);
      await new Promise((r2) => setTimeout(r2, 1500));
      assert.equal(tlsHits.length, hitsBefore, 'clicking asks Chrome for access; without an answer nothing is fetched');
      assert.deepEqual((JSON.parse(await ex.ev('chrome.permissions.getAll().then((a) => JSON.stringify(a))')).origins) || [], []);
    }
    // (4b) the permission itself needs a real click + Chrome's prompt. A headless run cannot answer that prompt, so the full flow runs on a
    // copy of the extension whose ONLY change is that the same https://*/* is granted up front (host_permissions instead of optional).
    const grantedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ext-granted-'));
    fs.cpSync(EXT, grantedDir, { recursive: true });
    const gm = JSON.parse(fs.readFileSync(path.join(grantedDir, 'manifest.json'), 'utf8'));
    gm.host_permissions = gm.optional_host_permissions; delete gm.optional_host_permissions;
    fs.writeFileSync(path.join(grantedDir, 'manifest.json'), JSON.stringify(gm, null, 2));
    const { id: gid } = await send('Extensions.loadUnpacked', { path: grantedDir });
    await send('Storage.setCookies', { cookies: [{ name: 'session', value: 'secret-session-cookie', domain: 'docs.newsco.test', path: '/', secure: true }] });
    const gx = await openTab(`chrome-extension://${gid}/explain/explain.html`);
    await gx.ev('TCDB.clearAll().then(() => localStorage.clear())');
    const gview = async (res, extra) => JSON.parse(await gx.ev(`(async () => {
      const out = await TCExplainUI.show(${JSON.stringify(res)});
      const point = (li) => ({ sec: li.closest('ul').id, cls: li.className.split(' ').pop(), line: li.querySelector('.line .text').textContent, src: li.querySelector('.src') ? li.querySelector('.src').textContent : '',
        open: li.querySelector('details').open, labels: [...li.querySelectorAll('details .label')].map((n) => n.textContent), quotes: [...li.querySelectorAll('blockquote')].map((b) => b.textContent), visible: [...li.querySelectorAll('blockquote')].some((b) => b.checkVisibility()) });
      return JSON.stringify({ kind: out.kind, read: out.read, unread: out.unread, status: document.getElementById('status').textContent, resultHidden: document.getElementById('result').hidden,
        summary: [...document.querySelectorAll('#overview-summary li')].map((n) => n.textContent), note: document.getElementById('overview-note').textContent,
        points: [...document.querySelectorAll('#risk-list li.point, #also-list li.point')].map(point),
        docsSummary: document.getElementById('docs-count').textContent, docsHidden: document.getElementById('docs-read').hidden, docsOpen: document.getElementById('docs-read').open,
        docItems: [...document.querySelectorAll('#docs-list li')].map((li) => li.textContent.replace(/\\s+/g, ' ')),
        pwned: typeof window.__tcPwned, elems: document.querySelectorAll('#app img, #app iframe, #app object, #app embed, #app script:not([src])').length,
        visibleText: document.getElementById('result').innerText, savedDocs: (await TCDB.listDocs()).length });
    })()`));

    const d = await gview(home);
    assert.equal(d.kind, 'documents'); assert.equal(d.read, 4); assert.equal(d.resultHidden, false);
    assert.match(d.status, /Read 4 documents\. Nothing was saved\./); assert.equal(d.savedDocs, 0);
    assert.equal(d.summary.length, 3);
    assert.match(d.summary[0], /: Terms, Privacy, Cookies, Community rules \(from the agree dialog\)\.$/);
    const by = (re) => d.points.find((p) => re.test(p.line));
    const sale = by(/sell your personal data/), arb = by(/private arbitration/), track = by(/track your activity/);
    assert.ok(sale && sale.cls === 'sev-High' && sale.src === 'Privacy', 'data sale found in the Privacy policy');
    assert.ok(arb && arb.src === 'Terms'); assert.ok(track && track.src === 'Terms + Privacy + Cookies', 'one tracking point, three sources: ' + (track && track.src));
    assert.equal(new Set(d.points.map((p) => p.line)).size, d.points.length, 'no repeated point');
    assert.ok(d.points.length <= 12);
    assert.ok(d.points.every((p) => !p.open && !p.visible && p.quotes.length >= 1 && p.src), 'exact wording collapsed, every point labelled with its source');
    assert.ok(track.labels.includes('From Terms:') && track.labels.includes('From Privacy:') && track.labels.includes('From Cookies:'));
    assert.match(d.docsSummary, /Documents read \(4 of 4\)/); assert.equal(d.docsOpen, false); assert.equal(d.docItems.length, 4);
    if (process.env.TC_DUMP) console.log(JSON.stringify({ summary: d.summary, status: d.status, points: d.points.map((p) => [p.cls, p.src, p.line]), docs: d.docItems }, null, 1));
    ok('agree dialog -> ONE combined explanation of Terms + Privacy + Cookies + Community rules, source-labelled, deduplicated, wording collapsed');

    // hostile linked document: its script / onerror must not run, its image must not load, its instructions are only data
    assert.equal(d.pwned, 'undefined'); assert.equal(d.elems, 0);
    assert.ok(!tlsHits.some((h) => /__should_never_load/.test(h.url)) && !site.hits.some((h) => /__should_never_load/.test(h.url)), 'no subresource of a fetched document was ever requested');
    assert.ok(/Community rules/.test(d.summary[0]) && d.points.some((p) => /lasting, wide licence|close your account/.test(p.line) && /Community rules/.test(p.src)), 'but its legal content was still read');
    ok('hostile linked document: no script, no onerror, no image load, no elements - only text');

    // the requests the extension made
    const mine = tlsHits.slice(hitsBefore);
    assert.deepEqual(mine.map((h) => h.url).sort(), ['/community-guidelines', '/cookies', '/privacy', '/robots.txt', '/terms'], 'one request per document plus ONE robots.txt for the site, nothing else (no crawling, no favicon)');
    for (const h of mine) {
      assert.equal(h.headers.cookie, undefined, 'logged out: no cookies sent although one exists for the site');
      assert.equal(h.headers.referer, undefined);
      assert.ok(/^Mozilla\/5\.0/.test(h.headers['user-agent']) && !/terms|guide|tc-/i.test(h.headers['user-agent']), 'the browser\'s own User-Agent');
      assert.equal(h.headers.authorization, undefined);
    }
    ok('requests: one GET per document + one robots.txt for the site, no cookies (even with a session cookie present), no Referer, default User-Agent');

    // a JS-only linked document is said to be unreadable and its link is offered
    const withJs = JSON.parse(JSON.stringify(home));
    withJs.consent.links.push({ url: 'https://docs.newsco.test/subscriber-agreement', text: 'Subscriber Agreement', doc_type: 'other', confidence: 'high', language: 'en', non_english: false, is_pdf: false, score: 3 });
    withJs.consent.links.push({ url: 'http://127.0.0.1:1/internal', text: 'Internal Policy', doc_type: 'other', confidence: 'high', language: 'en', non_english: false, is_pdf: false, score: 3 });
    const j = await gview(withJs);
    assert.equal(j.kind, 'documents'); assert.equal(j.read, 4); assert.equal(j.unread, 2);
    assert.match(j.note, /Not read: .*needs JavaScript to show its text/); assert.match(j.note, /Internal Policy|Other 2|Other \(link not allowed/);
    assert.ok(j.docItems.some((t) => /not read: needs JavaScript/.test(t) && /Open it, then click Term Sherpa there and I will explain what is on the screen/.test(t) && /Open this page/.test(t)), JSON.stringify(j.docItems));
    assert.ok(j.docItems.some((t) => /not read: link not allowed/.test(t)));
    assert.ok(!tlsHits.some((h) => /internal/.test(h.url)));
    ok('JS-only document -> "needs JavaScript" with its link offered; a non-https / loopback link is refused and never requested');

    // robots.txt disallow and redirects: skipped / not followed, with the link offered, and the other documents still read
    const withRedir = JSON.parse(JSON.stringify(home));
    withRedir.consent.links = withRedir.consent.links.filter((l) => /\/(terms|privacy)$/.test(l.url));
    for (const [pth, text] of [['blocked-by-robots', 'Blocked Policy'], ['moved-terms', 'Moved Terms'], ['moved-offsite', 'Offsite Terms']]) {
      withRedir.consent.links.push({ url: 'https://docs.newsco.test/' + pth, text, doc_type: 'other', confidence: 'high', language: 'en', non_english: false, is_pdf: false, score: 3 });
    }
    const before2 = tlsHits.length;
    const rd = await gview(withRedir);
    assert.equal(rd.kind, 'documents'); assert.equal(rd.read, 2); assert.equal(rd.unread, 3);
    assert.ok(rd.docItems.some((t) => /Blocked Policy/.test(t) && /not read: the site's robots\.txt asks automated tools not to fetch this page/.test(t) && /Open this page/.test(t)), JSON.stringify(rd.docItems));
    assert.ok(rd.docItems.some((t) => /Moved Terms/.test(t) && /not read: this link sends you to another page/.test(t) && /Open it and run Term Sherpa there/.test(t) && /Open this page/.test(t)), JSON.stringify(rd.docItems));
    assert.ok(rd.docItems.some((t) => /Offsite Terms/.test(t) && /not read: this link sends you to another page/.test(t) && /Open this page/.test(t)));
    const hits2 = tlsHits.slice(before2).map((h) => h.url).sort();
    assert.deepEqual(hits2, ['/moved-offsite', '/moved-terms', '/privacy', '/robots.txt', '/terms'], 'robots-disallowed page never requested; redirect targets (/redirect-trap and the same-site /terms hop) never requested; each redirecting URL requested once');
    ok('robots.txt disallow -> page never requested, link + reason shown; redirects (same-site and off-site) are not followed, never requested, link shown; the rest still read');

    // list mode: regional duplicates collapsed, three shown, the rest behind a toggle, and the dialog result still works for a banner
    const pc = await runIn(site.base + '/privacy-center', {});
    assert.ok(pc.links.filter((l) => l.doc_type === 'privacy').length >= 18, 'the raw page really lists 18+ privacy links');
    const lv = JSON.parse(await gx.ev(`(async () => { const out = await TCExplainUI.show(${JSON.stringify(pc)});
      return JSON.stringify({ kind: out.kind, items: [...document.querySelectorAll('#candidate-list li')].map((li) => li.textContent.replace(/\\s+/g, ' ')), shown: [...document.querySelectorAll('#candidate-list li')].filter((li) => !li.hidden).length, moreHidden: document.getElementById('candidate-more').hidden, allHidden: document.getElementById('candidate-all').hidden, status: document.getElementById('status').textContent }); })()`));
    assert.equal(lv.kind, 'links'); assert.equal(lv.items.length, 4, 'not 18'); assert.equal(lv.shown, 3); assert.equal(lv.moreHidden, false);
    assert.ok(lv.items.some((t) => /Privacy Policy/.test(t) && /17 other regional or language versions/.test(t) && /en-us/.test(t)), JSON.stringify(lv.items));
    assert.equal(lv.items.filter((t) => /Privacy Policy/.test(t) && !/Workforce/.test(t)).length, 1, 'one Privacy Policy entry, not one per region');
    const many = JSON.parse(JSON.stringify(pc)); many.links = ['terms', 'privacy', 'cookie-policy', 'community-guidelines', 'subscription-terms', 'arbitration-agreement'].map((n, i) => ({ url: 'https://x.example.test/' + n, text: ['Terms of Use', 'Privacy Policy', 'Cookie Policy', 'Community Guidelines', 'Subscription Terms', 'Arbitration Agreement'][i], doc_type: ['tos', 'privacy', 'cookies', 'other', 'tos', 'other'][i], confidence: 'high', language: 'en', is_pdf: false, score: 3 }));
    const mv = JSON.parse(await gx.ev(`(async () => { await TCExplainUI.show(${JSON.stringify(many)}); const li = () => [...document.querySelectorAll('#candidate-list li')];
      const before = li().filter((n) => !n.hidden).length; const total = li().length; const mb = document.getElementById('candidate-more'); const label = mb.textContent;
      mb.click(); const after = li().filter((n) => !n.hidden).length; const label2 = mb.textContent; mb.click(); const again = li().filter((n) => !n.hidden).length;
      return JSON.stringify({ before, total, label, after, label2, again, all: document.getElementById('candidate-all').hidden, explainBtns: document.querySelectorAll('#candidate-list button').length }); })()`));
    assert.deepEqual([mv.before, mv.total, mv.label, mv.after, mv.label2, mv.again], [3, 6, 'Show 3 more', 6, 'Show fewer', 3]);
    assert.equal(mv.all, false); assert.equal(mv.explainBtns, 12);
    ok('list mode: 18 regional privacy links -> one entry (17 variants collapsed); long lists show 3 with a "Show more" toggle; "Explain this" per entry');

    // a consent banner on a non-terms page and a plain article
    const cv = await gview(cb);
    assert.equal(cv.kind, 'documents'); assert.match(cv.summary[0], /Cookies, Privacy|Privacy, Cookies/); assert.match(cv.summary[0], /consent banner/);
    ok('consent banner -> its Cookie and Privacy documents explained together');
    const av = await gview(art);
    assert.equal(av.kind, 'links'); assert.equal(av.resultHidden, true);
    ok('no dialog on the page -> falls back to listing the page\'s legal links');

    // a terms page itself wins over its own cookie banner (existing behaviour)
    const hitsPre = tlsHits.length;
    const tp = await gview(terms);
    assert.equal(tp.kind, 'analysis'); assert.equal(tlsHits.length, hitsPre);
    ok('a terms page is still explained from its own text (no extra fetches)');

    // with the opt-in, fetched documents are saved; without it nothing is
    await gx.ev("localStorage.setItem('tc.saveCopies','1')");
    const sv = await gview(home);
    assert.equal(sv.savedDocs, 4); assert.match(sv.status, /Copies were saved on this device because you turned that option on/);
    await gx.ev("localStorage.removeItem('tc.saveCopies'); TCDB.clearAll()");
    ok('fetched documents are saved only with the explicit "save copies" opt-in');


    // (4c) consent boxes and terms inside iframes, through the REAL window: explain.html?tab=<id> runs run() -> runOnPage (allFrames) -> TCFrames.combine -> show().
    // Same-site frame and a frame from another site (cmp.newsco.test) with every https site allowed; then with ONLY the top site allowed (the situation where a
    // cross-origin frame cannot be entered): the window must say so plainly and offer to allow that site. (Headless cannot grant activeTab, so site access
    // comes from host_permissions on throw-away copies of the extension; the code path is the same.)
    {
      await gx.ev("chrome.storage.local.set({'tc.welcomeSeen': true})");
      const narrowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ext-narrow-'));
      fs.cpSync(EXT, narrowDir, { recursive: true });
      const nm = JSON.parse(fs.readFileSync(path.join(narrowDir, 'manifest.json'), 'utf8'));
      nm.host_permissions = ['https://docs.newsco.test/*'];
      fs.writeFileSync(path.join(narrowDir, 'manifest.json'), JSON.stringify(nm, null, 2));
      const { id: nid } = await send('Extensions.loadUnpacked', { path: narrowDir });
      { const w0 = await openTab(`chrome-extension://${nid}/explain/explain.html`); await w0.ev("chrome.storage.local.set({'tc.welcomeSeen': true})"); await send('Target.closeTarget', { targetId: w0.targetId }); }
      const windowFor = async (extIdX, pageUrl, until) => {
        const t = await openTab(pageUrl);
        const tabId = JSON.parse(await gx.ev(`chrome.tabs.query({}).then((ts) => JSON.stringify(ts.find((x) => x.url === ${JSON.stringify(pageUrl)}).id))`));
        const w = await openTab(`chrome-extension://${extIdX}/explain/explain.html?tab=${tabId}`);
        let st = '';
        for (let i = 0; i < 100; i++) { st = await w.ev("document.getElementById('status').textContent"); if (until.test(st)) break; await new Promise((r) => setTimeout(r, 150)); }
        const out = JSON.parse(await w.ev(`JSON.stringify({ status: document.getElementById('status').textContent, summary: [...document.querySelectorAll('#overview-summary li')].map((n) => n.textContent),
          framesHidden: document.getElementById('frames').hidden, framesText: document.getElementById('frames-text').textContent, framesBtn: document.getElementById('frames-go').textContent, framesBtnHidden: document.getElementById('frames-go').hidden,
          permHidden: document.getElementById('permission').hidden, perm: document.getElementById('perm-text').textContent, resultHidden: document.getElementById('result').hidden })`));
        out.shot = async (name) => { if (process.env.TC_SHOT) { const sh = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, w.sessionId); fs.writeFileSync(process.env.TC_SHOT.replace(/\.png$/, '-' + name + '.png'), Buffer.from(sh.data, 'base64')); } };
        await out.shot(name_of(pageUrl));
        await send('Target.closeTarget', { targetId: w.targetId }); await send('Target.closeTarget', { targetId: t.targetId });
        return out;
      };
      const name_of = (u) => 'frames-' + u.split('/').slice(-1)[0];
      const same = await windowFor(gid, 'https://docs.newsco.test/frames/same', /^Done\./);
      assert.match(same.status, /^Done\. Read 2 documents/, JSON.stringify(same)); assert.match(same.summary[0], /Cookies, Privacy|Privacy, Cookies/);
      ok('iframe (same site) with an agree/cookie banner: found through allFrames and its Cookie + Privacy documents explained');
      const cross = await windowFor(gid, 'https://docs.newsco.test/frames/cross', /^Done\./);
      assert.match(cross.status, /^Done\. Read 2 documents/, JSON.stringify(cross)); assert.match(cross.summary[0], /Cookies, Privacy|Privacy, Cookies/);
      ok('iframe from ANOTHER site (cmp.newsco.test), site access allowed: the banner inside it is found and explained');
      const narrow = await windowFor(nid, 'https://docs.newsco.test/frames/cross', /frame I could not read|Done\./);
      assert.match(narrow.status, /I did not find terms or privacy links on this page\. Part of the page is in a frame I could not read/, JSON.stringify(narrow));
      assert.equal(narrow.framesHidden, false); assert.match(narrow.framesText, /frame from another site, and I am not allowed to read inside it/); assert.match(narrow.framesText, /cmp\.newsco\.test/);
      assert.match(narrow.framesText, /open the terms link yourself and run Term Sherpa on that page/); assert.match(narrow.framesBtn, /Allow that site and look again/); assert.equal(narrow.framesBtnHidden, false);
      ok('iframe from another site NOT allowed: the window says plainly what it could not read, names the site, offers "Allow that site and look again" or opening the terms yourself');
      const js = await windowFor(gid, 'https://docs.newsco.test/app/terms', /terms or privacy page|Done\./);
      assert.match(js.status, /^This looks like a terms or privacy page, but I can see very little text on it\./); assert.match(js.status, /Wait for it to finish/);
      assert.equal(js.resultHidden, true);
      ok('JavaScript-only terms page (address says terms, almost no text) -> a plain "very little text, wait / open the read-more parts, then click again" message');
      try { fs.rmSync(narrowDir, { recursive: true, force: true }); } catch {}
    }

    // the access can be removed again
    const rv = await ex.ev("document.getElementById('revoke').click(), new Promise((r) => setTimeout(r, 400)).then(() => document.getElementById('status').textContent)");
    assert.match(rv, /No extra site access is allowed right now|Removed access/);
    ok('"Remove the site access I have allowed" is wired up');
    if (process.env.TC_SHOT) {
      await gview(home);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, gx.sessionId); fs.writeFileSync(process.env.TC_SHOT.replace(/\.png$/, '-dialog.png'), Buffer.from(shot.data, 'base64'));
    }
    try { fs.rmSync(grantedDir, { recursive: true, force: true }); } catch {}
  }

  const nav = await popup.ev('JSON.stringify(performance.getEntriesByType("resource").map(r=>r.name).filter(n=>!n.startsWith("chrome-extension://")))');
  assert.equal(nav, '[]'); ok('popup made no non-extension network requests');
  assert.deepEqual(exceptions.filter((e) => !/127\.0\.0\.1/.test(e || '')), []); ok('no uncaught exceptions from extension code (the fixture page script error is ignored)');
  console.log(`\nChrome e2e: ${results.length} checks passed (${(await send('Browser.getVersion')).product}; binary: ${path.basename(CHROME)})`);
  await cleanup();
} catch (e) { console.error('E2E FAILED:', e.message); if (process.env.DEBUG) console.error(stderr); console.error(stderr.split('\n').filter((l) => /extension|manifest/i.test(l)).slice(-5).join('\n')); await cleanup(); process.exit(1); }
