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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-chrome-'));
// Pipe transport: Extensions.loadUnpacked is only available with --remote-debugging-pipe + --enable-unsafe-extension-debugging
// (branded Chrome ignores --load-extension). This flag is for this throw-away test profile only.
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let stderr = ''; chrome.stderr.on('data', (d) => { stderr += d; });
const site = await startSite({ routes: {
  '/terms': { file: 'acme/terms.html' }, '/signup': { file: 'acme/index.html' }, '/cookies': { file: 'acme/cookies.html' }, '/privacy': { file: 'divsoup/privacy.html' },
  '/accordion/terms': { file: 'accordion/terms.html' }, '/langlist/terms': { file: 'langlist/terms.html' }, '/legal': { file: 'hub/legal.html' },
  '/hostile/terms': { headers: { 'content-type': 'text/html; charset=utf-8' }, body: fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'sites', 'hostile', 'terms.html'), 'utf8').replace('alert(2)', 'window.__pageOwnScript=1') } /* the fixture's own onerror would open a blocking dialog in a real browser; swapped for a harmless flag */, '/i18n': { file: 'i18n/index.html' }, '/about': { file: 'acme/index.html' }, '/checkout/terms': { file: 'acme/terms.html' }
} });
const cleanup = async () => { try { chrome.kill('SIGKILL'); } catch {} await site.close(); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {}; };
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

let id = 0; const pending = new Map(); const exceptions = [];
let buf = '';
chrome.stdio[4].on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\0')) >= 0) { const msg = buf.slice(0, i); buf = buf.slice(i + 1); onMessage(JSON.parse(msg)); } });
function onMessage(d) {
  if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.j(new Error(JSON.stringify(d.error))) : p.r(d.result); }
  else if (d.method === 'Runtime.exceptionThrown') exceptions.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
}
const send = (method, params = {}, sessionId) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); chrome.stdio[3].write(JSON.stringify({ id: i, method, params, sessionId }) + '\0'); });
async function openTab(url) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId); await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url }, sessionId);
  for (let i = 0; i < 100; i++) { const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId); if (r.result.value === 'complete' && (await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId)).result.value !== 'about:blank') break; await new Promise((r2) => setTimeout(r2, 100)); }
  return { targetId, sessionId, ev: async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; } };
}

const results = []; const ok = (name) => { results.push(name); console.log('  ok -', name); };
try {
  // (1) injected scripts in a real DOM
  const inject = ['core/untrusted.js', 'core/extract.js', 'core/detect.js', 'content/run.js'].map((f) => fs.readFileSync(path.join(EXT, f), 'utf8')).join('\n;\n');
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
  assert.equal(await popup.ev('document.title'), 'Terms Guide');
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
  assert.deepEqual(manifestPerms.sort(), ['activeTab', 'scripting']);
  assert.equal(await launcher.ev('JSON.stringify(chrome.runtime.getManifest().host_permissions || null) + JSON.stringify(chrome.runtime.getManifest().content_scripts || null)'), 'nullnull');
  ok('loaded manifest: only activeTab + scripting, no host permissions, no content_scripts');

  const ex = await openTab(`chrome-extension://${extId}/explain/explain.html`);
  assert.match(await ex.ev('document.getElementById("status").textContent'), /click the Terms Guide icon/i);
  assert.match(await ex.ev('document.getElementById("notice").textContent'), /Informational, not legal advice/);
  await ex.ev('TCDB.clearAll().then(() => localStorage.clear())');
  const view = async (res) => JSON.parse(await ex.ev(`(async () => {
    const out = await TCExplainUI.show(${JSON.stringify(res)});
    const q = (sel) => [...document.querySelectorAll(sel)].map((n) => n.textContent);
    return JSON.stringify({ kind: out.kind, hidden: document.getElementById('result').hidden, status: document.getElementById('status').textContent,
      summary: q('#overview-summary li'), service: q('#service-quotes blockquote'), obligations: q('#obligation-quotes blockquote'),
      cards: [...document.querySelectorAll('#risk-list .card')].map((c) => ({ cls: c.className, title: c.querySelector('h3').textContent, quotes: [...c.querySelectorAll('blockquote')].map((b) => b.textContent), explain: c.querySelector('p').textContent })),
      agree: q('#agree-list li'), imgs: document.querySelectorAll('img, script:not([src]), iframe, object, embed').length, docs: (await TCDB.listDocs()).length });
  })()`));
  const v1 = await view(terms);
  assert.equal(v1.kind, 'analysis'); assert.equal(v1.hidden, false);
  assert.equal(v1.docs, 0, 'default: nothing saved in IndexedDB');
  assert.match(v1.status, /Nothing was saved/);
  assert.deepEqual(v1.cards.map((c) => c.cls.split(' ').pop()), ['sev-High', 'sev-High', 'sev-Medium', 'sev-Medium', 'sev-Medium', 'sev-Low', 'sev-Low', 'sev-Low'], 'ranked High, Medium, Low');
  assert.ok(v1.cards.every((c) => c.quotes.length >= 1 && c.explain.length > 60));
  for (const c of v1.cards) for (const qt of c.quotes) assert.ok(terms.extracted.text.replace(/\s+/g, ' ').includes(qt.replace(/\s+/g, ' ')), 'quote is verbatim in the page text: ' + qt);
  assert.ok(v1.cards[0].quotes[0].includes('individual arbitration') );
  assert.ok(v1.agree.length === 8 && v1.summary.length >= 3 && v1.service.length >= 1 && v1.obligations.length >= 1);
  ok('explain window renders overview, ranked risks with exact quotes, and the agreeing list; nothing saved by default');

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
  assert.equal(await ex.ev("document.querySelectorAll('#candidate-list li').length"), 4);
  assert.equal(await ex.ev("localStorage.getItem('tc.saveCopies')"), null);
  ok('explain window: non-terms page -> candidate links only, no analysis, no storage');
  if (process.env.TC_SHOT) { await view(terms); const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, ex.sessionId); fs.writeFileSync(process.env.TC_SHOT, Buffer.from(shot.data, 'base64')); }

  const nav = await popup.ev('JSON.stringify(performance.getEntriesByType("resource").map(r=>r.name).filter(n=>!n.startsWith("chrome-extension://")))');
  assert.equal(nav, '[]'); ok('popup made no non-extension network requests');
  assert.deepEqual(exceptions.filter((e) => !/127\.0\.0\.1/.test(e || '')), []); ok('no uncaught exceptions from extension code (the fixture page script error is ignored)');
  console.log(`\nChrome e2e: ${results.length} checks passed (${(await send('Browser.getVersion')).product})`);
  await cleanup();
} catch (e) { console.error('E2E FAILED:', e.message); if (process.env.DEBUG) console.error(stderr); console.error(stderr.split('\n').filter((l) => /extension|manifest/i.test(l)).slice(-5).join('\n')); await cleanup(); process.exit(1); }
