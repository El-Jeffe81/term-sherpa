// Evidence, re-runnable:  npm run probe:warnings   (Chrome with Extensions.loadUnpacked over a debugging pipe)
// Question: does the shipped permission list add any install-time warning in Chrome / Edge? Asks Chrome itself
// (chrome.management.getPermissionWarningsByManifest) about the real extension/manifest.json. Expected: [] (no warning at all).
// The Firefox side is checked in the lint / e2e docs: Firefox shows a warning only for permissions in its PERMISSIONS_WITH_MESSAGE list ("storage", "dns", "activeTab", "scripting" are not in it).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_BIN || ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find((c) => spawnSync('which', [c]).status === 0);
if (!CHROME) { console.log('SKIP: no Chrome/Chromium found (set CHROME_BIN)'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-warn-'));
const probe = path.join(tmp, 'probe'); fs.mkdirSync(probe);
fs.writeFileSync(probe + '/manifest.json', JSON.stringify({ manifest_version: 3, name: 'probe', version: '1', permissions: ['management'] }));
fs.writeFileSync(probe + '/p.html', '<!doctype html><title>p</title>');
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${path.join(tmp, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let id = 0, buf = ''; const pending = new Map();
chrome.stdio[4].on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\0')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result); } } });
const send = (method, params = {}, sessionId) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); chrome.stdio[3].write(JSON.stringify({ id: i, method, params, sessionId }) + '\0'); });
let failed = false;
try {
  const { id: extId } = await send('Extensions.loadUnpacked', { path: probe });
  const { targetId } = await send('Target.createTarget', { url: `chrome-extension://${extId}/p.html` });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId); await new Promise((r) => setTimeout(r, 600));
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const warn = (m) => ev(`chrome.management.getPermissionWarningsByManifest(${JSON.stringify(JSON.stringify(m))}).then((r) => JSON.stringify(r))`);
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  const w = await warn(real);
  console.log(`Chrome ${(await send('Browser.getVersion')).product}: install warnings for extension/manifest.json (permissions ${JSON.stringify(real.permissions)}, optional hosts ${JSON.stringify(real.optional_host_permissions)}) =`, w);
  assert.equal(w, '[]', 'the shipped manifest must show no install warning');
  const ctrl = await warn(Object.assign({}, real, { permissions: [...real.permissions, 'tabs'] }));
  console.log('(control: adding "tabs" gives', ctrl + ')'); assert.notEqual(ctrl, '[]', 'control: the probe really reports warnings');
  console.log('PROBE OK: no install warning');
} catch (e) { failed = true; console.error('PROBE FAILED:', e.message); }
try { chrome.kill('SIGKILL'); } catch {}
setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {} process.exit(failed ? 1 : 0); }, 500);
