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
