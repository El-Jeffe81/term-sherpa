// Optional, NETWORK-DEPENDENT check against ~25 real public pages. NOT part of `npm test` (real sites change and may block automated browsers).
// Run: npm run test:real            (all pages)       TC_REAL_ONLY=google,apple npm run test:real   (name filter)
// Output: $TC_REAL_OUT (default /workspace/real-sites): results.json, results.md and one explain-window screenshot per page.
// Same approach as chrome-smoke.mjs: headless Chrome over the DevTools pipe, a throw-away copy of the built extension whose ONLY change is that
// https://*/* is granted up front (headless Chrome cannot show the permission prompt or grant activeTab), and the REAL explain window opened for each tab.
// A site that blocks us or times out is recorded, not a failure. Exit code is 1 only for a crash in our own code (an extension exception).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = path.join(ROOT, 'extension');
const OUT = process.env.TC_REAL_OUT || '/workspace/real-sites';
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_BIN || ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find((c) => { try { return require('node:child_process').spawnSync('which', [c]).status === 0; } catch { return false; } });
if (!CHROME) { console.log('SKIP: no Chrome/Chromium found (set CHROME_BIN)'); process.exit(0); }

// kind: what a normal user would expect from the page. expect: 'explained' (terms/privacy text read), 'banner' (agree/cookie dialog found),
// 'none' (not a terms page: the extension should NOT claim it is).
export const SITES = [
  { name: 'google-terms', kind: 'big service terms', url: 'https://policies.google.com/terms', expect: 'explained' },
  { name: 'google-privacy', kind: 'big service privacy', url: 'https://policies.google.com/privacy', expect: 'explained' },
  { name: 'apple-privacy', kind: 'big service privacy', url: 'https://www.apple.com/legal/privacy/en-ww/', expect: 'explained' },
  { name: 'apple-site-terms', kind: 'big service terms', url: 'https://www.apple.com/legal/internet-services/terms/site.html', expect: 'explained' },
  { name: 'microsoft-services', kind: 'big service terms', url: 'https://www.microsoft.com/en-us/servicesagreement', expect: 'explained' },
  { name: 'microsoft-privacy', kind: 'big service privacy', url: 'https://privacy.microsoft.com/en-us/privacystatement', expect: 'explained' },
  { name: 'amazon-conditions', kind: 'big service terms', url: 'https://www.amazon.com/gp/help/customer/display.html?nodeId=GLSBYFE9MYSKQEEH', expect: 'explained' },
  { name: 'netflix-terms', kind: 'big service terms', url: 'https://help.netflix.com/legal/termsofuse', expect: 'explained' },
  { name: 'netflix-privacy', kind: 'big service privacy', url: 'https://help.netflix.com/legal/privacy', expect: 'explained' },
  { name: 'spotify-terms', kind: 'big service terms', url: 'https://www.spotify.com/us/legal/end-user-agreement/', expect: 'explained' },
  { name: 'reddit-user-agreement', kind: 'big service terms', url: 'https://www.redditinc.com/policies/user-agreement', expect: 'explained' },
  { name: 'x-terms', kind: 'big service terms (JS heavy)', url: 'https://x.com/en/tos', expect: 'explained' },
  { name: 'x-privacy', kind: 'big service privacy (JS heavy)', url: 'https://x.com/en/privacy', expect: 'explained' },
  { name: 'github-terms', kind: 'big service terms', url: 'https://docs.github.com/en/site-policy/github-terms/github-terms-of-service', expect: 'explained' },
  { name: 'zoom-terms', kind: 'big service terms', url: 'https://explore.zoom.us/en/terms/', expect: 'explained' },
  { name: 'guardian-home', kind: 'news site, cookie banner (usually in an iframe)', url: 'https://www.theguardian.com/international', expect: 'banner' },
  { name: 'bbc-news', kind: 'news site, cookie banner', url: 'https://www.bbc.com/news', expect: 'banner' },
  { name: 'lemonde-home', kind: 'EU news site, consent banner', url: 'https://www.lemonde.fr/', expect: 'banner' },
  { name: 'spiegel-home', kind: 'EU news site, consent banner (iframe)', url: 'https://www.spiegel.de/', expect: 'banner' },
  { name: 'spotify-signup', kind: 'sign-up with agree checkbox', url: 'https://www.spotify.com/us/signup', expect: 'banner' },
  { name: 'dropbox-register', kind: 'sign-up with agree text', url: 'https://www.dropbox.com/register', expect: 'banner' },
  { name: 'airbnb-terms', kind: 'JS heavy terms', url: 'https://www.airbnb.com/help/article/2908', expect: 'explained' },
  { name: 'tiktok-terms', kind: 'JS heavy terms', url: 'https://www.tiktok.com/legal/page/us/terms-of-service/en', expect: 'explained' },
  { name: 'wikipedia-tos-article', kind: 'NOT a terms page (article about terms)', url: 'https://en.wikipedia.org/wiki/Terms_of_service', expect: 'none' },
  { name: 'example-com', kind: 'NOT a terms page (control)', url: 'https://example.com/', expect: 'none' }
];
if (process.argv.includes('--list')) { for (const s of SITES) console.log(s.name, s.url); process.exit(0); }
const only = (process.env.TC_REAL_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
const todo = SITES.filter((s) => !only.length || only.some((o) => s.name.includes(o)));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-real-'));
const grantedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ext-real-'));
fs.cpSync(EXT, grantedDir, { recursive: true });
{ const m = JSON.parse(fs.readFileSync(path.join(grantedDir, 'manifest.json'), 'utf8')); m.host_permissions = m.optional_host_permissions; delete m.optional_host_permissions; fs.writeFileSync(path.join(grantedDir, 'manifest.json'), JSON.stringify(m, null, 2)); }
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--window-size=1280,900', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let id = 0; const pending = new Map(); const exceptions = []; let buf = '';
chrome.stdio[4].on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\0')) >= 0) { const msg = buf.slice(0, i); buf = buf.slice(i + 1); onMessage(JSON.parse(msg)); } });
function onMessage(d) {
  if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.j(new Error(JSON.stringify(d.error))) : p.r(d.result); }
  else if (d.method === 'Runtime.exceptionThrown' && /chrome-extension:/.test(JSON.stringify(d.params.exceptionDetails))) exceptions.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
}
const send = (method, params = {}, sessionId) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); chrome.stdio[3].write(JSON.stringify({ id: i, method, params, sessionId }) + '\0'); });
const T0 = Date.now(); const dbg = (m) => { if (process.env.TC_REAL_DEBUG) console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error('timeout: ' + what)), ms))]);
async function openTab(url, { ua = false, settle = 0, wait = 30000 } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId); await send('Page.enable', {}, sessionId);
  if (ua) { const v = (await send('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome'); await send('Emulation.setUserAgentOverride', { userAgent: v, acceptLanguage: 'en-US,en' }, sessionId); }
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  let navError = null;
  try { const n = await send('Page.navigate', { url }, sessionId); if (n.errorText) navError = n.errorText; } catch (e) { navError = e.message; }
  const t0 = Date.now(); while (Date.now() - t0 < wait) { try { if ((await ev('document.readyState')) === 'complete') break; } catch {} await sleep(250); }
  if (settle) await sleep(settle);
  return { targetId, sessionId, ev, navError, close: () => send('Target.closeTarget', { targetId }).catch(() => {}) };
}
const inject = ['core/untrusted.js', 'core/extract.js', 'core/detect.js', 'core/consent.js', 'content/run.js'].map((f) => fs.readFileSync(path.join(EXT, f), 'utf8')).join('\n;\n');

const rows = [];
try {
  const { id: gid } = await send('Extensions.loadUnpacked', { path: grantedDir });
  const gx = await openTab(`chrome-extension://${gid}/explain/explain.html`);
  await gx.ev(`chrome.storage.local.set({'tc.welcomeSeen': true})`);
  for (const site of todo) {
    const row = { name: site.name, kind: site.kind, url: site.url, expect: site.expect };
    const t0 = Date.now();
    let page, win;
    try {
      page = await openTab(site.url, { ua: true, settle: 4000 });
      dbg('page loaded'); row.navError = page.navError; row.finalUrl = await page.ev('location.href').catch(() => null); row.title = await page.ev('document.title').catch(() => null);
      // 1) what the page scripts alone see (top frame)
      try {
        await page.ev(`globalThis.__tcOptions = {}`); await page.ev(inject);
        const r = JSON.parse(await page.ev('JSON.stringify(globalThis.__tcResult)'));
        row.top = { ok: r.ok, error: r.error, looks_like_terms: r.page && r.page.looks_like_terms, doc_type: r.page && r.page.doc_type, is_hub: r.page && r.page.is_hub, sensitive: r.page && r.page.sensitive, thin: r.page && r.page.thin,
          textLen: r.extracted ? r.extracted.text.length : 0, consent: r.consent && r.consent.found ? { kind: r.consent.kind, links: r.consent.links.length, buttons: r.consent.buttons.slice(0, 3) } : null, links: (r.links || []).length,
          frames: (r.frames || []).filter((f) => f.likely).map((f) => { try { return new URL(f.src).host; } catch { return f.src; } }) };
      } catch (e) { row.top = { error: e.message }; }
      dbg('top scripts done');
      if (process.env.TC_REAL_EVAL) console.log('EVAL', site.name, JSON.stringify(await page.ev(process.env.TC_REAL_EVAL).catch((e) => 'ERR ' + e.message)).slice(0, 1500));
      // 2) the real explain window (all frames, documents fetched with the granted access)
      const tabId = JSON.parse(await gx.ev(`chrome.tabs.query({}).then((ts) => JSON.stringify((ts.find((x) => x.url === ${JSON.stringify(row.finalUrl)}) || ts.find((x) => x.url && x.url.startsWith(${JSON.stringify(site.url.slice(0, 40))})) || {}).id))`));
      win = await openTab(`chrome-extension://${gid}/explain/explain.html?tab=${tabId}`, { wait: 10000 });
      dbg('explain opened'); let last = '', stable = 0;
      for (let i = 0; i < 160 && stable < 6; i++) { // up to ~40 s, until the status stops changing
        const st = await win.ev(`document.getElementById('status').textContent`).catch(() => '');
        if (st === last && !/^(Reading the page|Opening)/.test(st) && st) stable++; else stable = 0; last = st; await sleep(250);
      }
      dbg('status stable: ' + last.slice(0, 60));
      const out = JSON.parse(await win.ev(`JSON.stringify({ status: document.getElementById('status').textContent, err: document.getElementById('status').className === 'err',
        resultHidden: document.getElementById('result').hidden, summary: [...document.querySelectorAll('#overview-summary li')].map((n) => n.textContent),
        risks: [...document.querySelectorAll('#risk-list li.point')].map((li) => (li.querySelector('.badge') ? li.querySelector('.badge').textContent : '') + ': ' + li.querySelector('.line .text').textContent),
        also: [...document.querySelectorAll('#also-list li.point')].map((li) => li.querySelector('.line .text').textContent),
        nothingFound: !document.getElementById('nothing-found').hidden, framesNote: !document.getElementById('frames').hidden, permission: !document.getElementById('permission').hidden,
        docs: [...document.querySelectorAll('details.docs li')].map((n) => n.textContent.slice(0, 160)), visibleLen: document.getElementById('result').innerText.length })`));
      Object.assign(row, { status: out.status, statusErr: out.err, explained: !out.resultHidden, summary: out.summary, risks: out.risks, also: out.also, riskCount: out.risks.length + out.also.length, highCount: out.risks.filter((r) => /^High/.test(r)).length,
        nothingFound: out.nothingFound, framesNote: out.framesNote, docs: out.docs });
      await send('Target.activateTarget', { targetId: win.targetId }).catch(() => {}); const sh = await withTimeout(send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, win.sessionId), 20000, 'explain screenshot'); fs.writeFileSync(path.join(OUT, site.name + '.png'), Buffer.from(sh.data, 'base64'));
      await send('Target.activateTarget', { targetId: page.targetId }).catch(() => {}); const sp = await withTimeout(send('Page.captureScreenshot', { format: 'png' }, page.sessionId), 15000, 'page screenshot').catch(() => null); if (sp) fs.writeFileSync(path.join(OUT, site.name + '-page.png'), Buffer.from(sp.data, 'base64'));
      dbg('shots done');
      row.detected = !!(row.top && (row.top.looks_like_terms || row.top.consent)) || row.explained || /found .* (link|dialog|banner)|legal document/.test(out.status);
    } catch (e) { row.error = e.message; }
    finally { if (win) await win.close(); if (page) await page.close(); }
    row.seconds = Math.round((Date.now() - t0) / 1000);
    rows.push(row);
    console.log(`${row.name.padEnd(24)} detected=${String(row.detected).padEnd(5)} explained=${String(row.explained).padEnd(5)} risks=${row.riskCount ?? '-'} ${row.error ? 'ERROR ' + row.error : ''} | ${(row.status || '').slice(0, 110)}`);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, 2));
  }
  const md = ['| Page | Expect | Detected | Type | Risks (High) | Result |', '|---|---|---|---|---|---|'];
  for (const r of rows) md.push(`| ${r.name} | ${r.expect} | ${r.detected ? 'yes' : 'no'} | ${(r.top && r.top.doc_type) || (r.summary && r.summary[0]) || '-'} | ${r.riskCount ?? '-'} (${r.highCount ?? '-'}) | ${(r.error ? 'ERROR: ' + r.error : (r.status || '')).replace(/\|/g, '/').slice(0, 120)} |`);
  fs.writeFileSync(path.join(OUT, 'results.md'), md.join('\n') + '\n');
  console.log(`\nReal-sites run: ${rows.length} pages, results in ${OUT}`);
  if (exceptions.length) { console.error('UNCAUGHT EXTENSION EXCEPTIONS:\n' + exceptions.slice(0, 5).join('\n')); process.exitCode = 1; }
} catch (e) { console.error('REAL-SITES CRASHED:', e.message); process.exitCode = 1; }
finally { try { chrome.kill('SIGKILL'); } catch {} await sleep(300); for (const d of [profile, grantedDir]) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} }
