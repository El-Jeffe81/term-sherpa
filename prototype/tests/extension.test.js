'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validate } = require('./validate-manifest');
const ROOT = path.join(__dirname, '..');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const EXT = path.join(ROOT, 'extension');

function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]); }

test('manifest is valid MV3 and follows the hard rules', () => {
  assert.deepEqual(validate(), []);
});

test('manifest has no content_scripts and only activeTab + scripting', () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  assert.equal(m.content_scripts, undefined);
  assert.equal(m.host_permissions, undefined);
  assert.deepEqual([...m.permissions].sort(), ['activeTab', 'scripting']);
});

test('the page is only touched inside click handlers (executeScript appears only in runOnPage, called from click handlers)', () => {
  const js = stripComments(fs.readFileSync(path.join(EXT, 'popup', 'popup.js'), 'utf8'));
  assert.equal((js.match(/executeScript/g) || []).length, 3, 'three calls, all inside runOnPage');
  const body = /async function runOnPage[\s\S]*?\n  }\n/.exec(js)[0];
  assert.equal((body.match(/executeScript/g) || []).length, 3);
  const callers = [...js.matchAll(/runOnPage\(/g)].length;
  assert.equal(callers, 2, 'definition + 1 caller (onHelp); there is no "save this page" path any more');
  assert.match(js, /\$\('help'\)\.addEventListener\('click', onHelp\)/);
  assert.ok(!/force/i.test(js) && !/force/i.test(fs.readFileSync(path.join(EXT, 'popup', 'popup.html'), 'utf8')), 'forced save of arbitrary pages was removed');
  assert.ok(!/user_page_forced|mode:\s*'save'/.test(stripComments(fs.readFileSync(path.join(EXT, 'content', 'run.js'), 'utf8'))));
  // nothing at top level runs it automatically
  const tail = js.slice(js.indexOf("$('help').addEventListener"));
  assert.ok(!/runOnPage|executeScript/.test(tail));
});

test('privacy lint: the extension contains no network calls, tracking, remote code or beacons', () => {
  const banned = [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /\bimport\s*\(/, /importScripts/, /\beval\s*\(/, /new Function/,
    /google-analytics|googletagmanager|gtag\(|mixpanel|segment\.(io|com)|sentry|amplitude|hotjar|plausible/i, /document\.cookie/, /\.innerHTML\s*=/, /chrome\.cookies|chrome\.history|chrome\.webRequest|chrome\.identity|chrome\.downloads/];
  for (const f of walk(EXT).filter((x) => /\.(js|html|json|css)$/.test(x))) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const re of banned) assert.ok(!re.test(src), `${path.relative(ROOT, f)} matches ${re}`);
    if (f.endsWith('.html')) assert.ok(!/(src|href)="https?:/i.test(src), f + ' loads a remote resource');
  }
});

test('extension code is dependency-free and package.json declares no third-party dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, {});
  assert.deepEqual(pkg.devDependencies, {});
  assert.ok(!fs.existsSync(path.join(ROOT, 'node_modules')), 'no node_modules');
  for (const f of walk(path.join(ROOT, 'cli')).filter((x) => x.endsWith('.js'))) {
    for (const mm of fs.readFileSync(f, 'utf8').matchAll(/require\('([^']+)'\)/g)) {
      assert.ok(mm[1].startsWith('.') || mm[1].startsWith('node:'), `${f}: non-builtin require ${mm[1]}`);
    }
  }
});

test('content script returns data only; it does not call chrome.* APIs or leave the page', () => {
  const src = stripComments(fs.readFileSync(path.join(EXT, 'content', 'run.js'), 'utf8'));
  assert.ok(!/chrome\./.test(src));
  assert.match(src, /globalThis\.__tcResult = result/);
});

test('required documents exist and mark every partner as pending owner approval', () => {
  for (const f of ['README.md', 'PARTNERS.md', 'OPEN_QUESTIONS.md']) assert.ok(fs.existsSync(path.join(ROOT, f)), f + ' missing');
  const partners = fs.readFileSync(path.join(ROOT, 'PARTNERS.md'), 'utf8');
  const rows = partners.split('\n').filter((l) => /^\|/.test(l) && !/^\|[-\s|]+\|$/.test(l) && !/^\| *Partner/i.test(l));
  assert.ok(rows.length >= 3);
  for (const r of rows) assert.match(r, /pending owner approval/i, r);
  const oq = fs.readFileSync(path.join(ROOT, 'OPEN_QUESTIONS.md'), 'utf8');
  for (const k of [/dataset location/i, /naming|name/i, /lawyer/i]) assert.match(oq, k);
});

// ---- Explain phase ----
const explainSrc = () => stripComments(fs.readFileSync(path.join(EXT, 'explain', 'explain.js'), 'utf8'));
const launcherSrc = () => stripComments(fs.readFileSync(path.join(EXT, 'explain', 'launcher.js'), 'utf8'));

test('explain: the toolbar popup is the launcher; it opens a window with chrome.windows (no new permission) and reads nothing', () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  assert.equal(m.action.default_popup, 'explain/launcher.html');
  assert.equal(m.background, undefined);
  assert.deepEqual([...m.permissions].sort(), ['activeTab', 'scripting']);
  const l = launcherSrc();
  assert.match(l, /chrome\.windows\.create\(/);
  assert.ok(!/executeScript|scripting|TCDB|indexedDB|localStorage/.test(l), 'launcher never reads the page or stores anything');
});

test('explain: the page is read in one place only (runOnPage, started from run() when the window opens)', () => {
  const js = explainSrc();
  assert.equal((js.match(/executeScript/g) || []).length, 3);
  const body = /async function runOnPage[\s\S]*?\n  }\n/.exec(js)[0];
  assert.equal((body.match(/executeScript/g) || []).length, 3);
  assert.equal([...js.matchAll(/runOnPage\(/g)].length, 2, 'definition + one caller (run)');
  assert.equal([...js.matchAll(/\brun\(\)/g)].length, 2, 'definition + one call at the end');
  assert.ok(!/chrome\.(history|cookies|webRequest|downloads|identity|storage)/.test(js));
});

test('explain: page text is rendered with textContent only (no HTML sinks)', () => {
  const js = explainSrc();
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|srcdoc|\.setAttribute\(\s*['"]on/.test(js));
  assert.ok(/\.textContent = text/.test(js), "page-derived strings are set through textContent");
  const html = fs.readFileSync(path.join(EXT, 'explain', 'explain.html'), 'utf8');
  assert.match(html, /Informational, not legal advice/, 'notice is in the page itself, before any result');
  assert.ok(html.indexOf('Informational, not legal advice') < html.indexOf('id="result"'));
});

test('explain: terms are NOT saved by default - TCDB is used only inside maybeSave(), which needs the opt-in flag', () => {
  const js = explainSrc();
  const uses = [...js.matchAll(/TCDB\./g)].length;
  assert.equal(uses, 1, 'exactly one TCDB call in the Explain window');
  const fn = /async function maybeSave\(extracted\) \{[\s\S]*?\n  }\n/.exec(js)[0];
  assert.match(fn, /if \(!saveEnabled\(\)\) return null;\s*return TCDB\.saveSnapshot\(extracted\);/);
  assert.match(js, /function saveEnabled\(\) \{ try \{ return localStorage\.getItem\(SAVE_KEY\) === '1'; \} catch \(e\) \{ return false; \} \}/, 'default is off, also if storage fails');
  assert.ok(!/TCDB\.(saveLinks|pickLink|getLink)/.test(js), 'no link/pick records in IndexedDB from the new window');
  const html = fs.readFileSync(path.join(EXT, 'explain', 'explain.html'), 'utf8');
  assert.match(html, /<input type="checkbox" id="save-copies">(?!.*checked)/, 'checkbox is not checked by default in the markup');
  // legacy collection code is kept, not deleted
  for (const f of ['popup/popup.js', 'popup/popup.html', 'popup/db.js']) assert.ok(fs.existsSync(path.join(EXT, f)), f + ' kept');
});

test('explain: no Chrome built-in AI / Prompt API, no network, no remote code anywhere in the extension', () => {
  for (const f of walk(EXT).filter((x) => /\.(js|html)$/.test(x))) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    assert.ok(!/LanguageModel|window\.ai\b|self\.ai\b|\bai\.(languageModel|summarizer|writer|rewriter)|Summarizer\b|chrome\.aiOriginTrial|navigator\.ml/.test(src), f);
  }
});

test('explain: Explain window loads the engine scripts in dependency order from the extension itself', () => {
  const html = fs.readFileSync(path.join(EXT, 'explain', 'explain.html'), 'utf8');
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const at = (f) => srcs.indexOf(f);
  assert.ok(at('../core/quote.js') > -1 && at('../core/rules.js') > -1 && at('../core/analyze.js') > -1 && at('explain.js') > -1);
  assert.ok(at('../core/rules.js') < at('../core/analyze.js') && at('../core/quote.js') < at('../core/analyze.js') && at('../core/analyze.js') < at('explain.js'));
  assert.ok(at('../core/context.js') > -1 && at('../core/context.js') < at('../core/analyze.js'), 'context.js is loaded before analyze.js');
});

test('explain: concise window - exact wording sits in a collapsed <details>, and the filler is gone from the page', () => {
  const html = fs.readFileSync(path.join(EXT, 'explain', 'explain.html'), 'utf8');
  const js = explainSrc();
  assert.match(js, /el\('details'\)/);
  assert.match(js, /el\('summary', 'Show exact wording'\)/);
  assert.ok(!/\.open\s*=|setAttribute\(\s*['"]open/.test(js), 'details are never opened by script');
  assert.ok(!/<details[^>]*\bopen\b/.test(html), 'and never open in the markup');
  for (const f of [html, js]) assert.ok(!/word count|reading time|\bminutes\b|of the 12|What you have to do|What it is about|What you.re agreeing to/i.test(f), 'no filler text');
  assert.match(html, /Worth knowing/);
});

test('docs: README documents the Explain usage and implementation.md keeps CSO Concerns first', () => {
  const impl = fs.readFileSync(path.join(ROOT, '..', 'implementation.md'), 'utf8');
  assert.match(impl, /^# Implementation\n\n## CSO Concerns \(read first\)\n/);
  assert.match(impl, /## Explain phase/);
  assert.match(impl, /on-device/i);
  assert.match(impl, /not saved by default/i);
  assert.match(impl, /parked/i);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /Explain/);
  assert.match(readme, /not legal advice/i);
});
