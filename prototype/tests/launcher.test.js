'use strict';
// The toolbar popup: the Term Sherpa name with its icon, and ONE full-width "Explain this page" button. The button opens the Explain page in every
// browser: a small window where there is one, a normal tab where there is not (Firefox for Android has no windows.create).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT = path.join(__dirname, '..', 'extension', 'explain');
const SRC = fs.readFileSync(path.join(EXT, 'launcher.js'), 'utf8');

function run(chromeExtra, openTabs, activeTab) {
  let click = null;
  const els = { status: { textContent: '', hidden: true }, again: { textContent: 'Explain this page', hidden: false, disabled: false, addEventListener(ev, fn) { click = fn; } } };
  const calls = [];
  const active = activeTab === undefined ? { id: 7, url: 'https://example.com/' } : activeTab;
  const chrome = {
    runtime: { getURL: (p) => 'moz-extension://x/' + p },
    tabs: {
      query: async (q) => (q && q.active ? (active ? [active] : []) : [{ id: 7, url: 'https://example.com/' }].concat(openTabs || [])),
      update: async (id, o) => { calls.push(['tabs.update', id, o.active]); return {}; },
      create: async (o) => { calls.push(['tabs.create', o.url]); return {}; },
    },
    ...chromeExtra(calls),
  };
  vm.runInNewContext(SRC, { chrome, document: { getElementById: (id) => els[id] }, encodeURIComponent, String, Promise });
  return new Promise((r) => setTimeout(() => r({ calls, els, click: async () => { click(); await new Promise((x) => setTimeout(x, 20)); } }), 20));
}

test('launcher: nothing opens by itself - the popup shows the button, and clicking "Explain this page" opens a popup window when the browser has windows.create', async () => {
  const { calls, els, click } = await run((calls) => ({ windows: { create: async (o) => { calls.push(['windows.create', o.url, o.type]); return {}; } } }));
  assert.deepEqual(calls, [], 'opening the popup does not open the window; the button does');
  assert.equal(els.again.textContent, 'Explain this page'); assert.equal(els.again.disabled, false);
  await click();
  assert.deepEqual(calls, [['windows.create', 'moz-extension://x/explain/explain.html?tab=7', 'popup']]);
});

test('launcher: the button falls back to a tab when windows.create is missing (Firefox for Android)', async () => {
  const { calls, els, click } = await run(() => ({}));
  await click();
  assert.deepEqual(calls, [['tabs.create', 'moz-extension://x/explain/explain.html?tab=7']]);
  assert.equal(els.status.textContent, '', 'no sentence in this state, only the button'); assert.equal(els.status.hidden, true);
});

test('launcher: the button falls back to a tab when windows.create rejects', async () => {
  const { calls, click } = await run(() => ({ windows: { create: async () => { throw new Error('unsupported'); } } }));
  await click();
  assert.deepEqual(calls, [['tabs.create', 'moz-extension://x/explain/explain.html?tab=7']]);
});

test('launcher: when the explanation window for this page is already open it says so and the same button focuses it instead of opening another', async () => {
  const open = [{ id: 99, windowId: 5, url: 'moz-extension://x/explain/explain.html?tab=7' }];
  const { calls, els, click } = await run((c) => ({ windows: { create: async (o) => { c.push(['windows.create', o.url]); return {}; }, update: async (id, o) => { c.push(['windows.update', id, o.focused]); return {}; } } }), open);
  assert.match(els.status.textContent, /already open/);
  assert.equal(els.status.hidden, false);
  assert.equal(els.again.textContent, 'Explain this page', 'still the one button');
  assert.deepEqual(calls, [], 'nothing opened yet');
  await click();
  assert.deepEqual(calls, [['windows.update', 5, true], ['tabs.update', 99, true]]);
});

test('launcher: an explanation window open for a different page (or tab 70 vs 7) does not count as already open', async () => {
  const open = [{ id: 98, windowId: 4, url: 'moz-extension://x/explain/explain.html?tab=70' }, { id: 97, windowId: 3, url: 'https://example.com/explain/explain.html?tab=7' }, { id: 96, windowId: 2 }];
  const { calls, els, click } = await run(() => ({}), open);
  assert.equal(els.status.textContent, ''); assert.equal(els.status.hidden, true);
  await click();
  assert.deepEqual(calls, [['tabs.create', 'moz-extension://x/explain/explain.html?tab=7']]);
});

test('launcher: on a page it cannot read (not http/https) the button is disabled and a plain sentence says why', async () => {
  const { calls, els } = await run(() => ({}), [], { id: 3, url: 'chrome://extensions' });
  assert.equal(els.again.disabled, true);
  assert.match(els.status.textContent, /normal web pages/);
  assert.deepEqual(calls, []);
});

test('popup layout: a fixed ~320px width set explicitly, icon + name side by side on top, one full-width button underneath, no letter-by-letter wrapping', () => {
  const html = fs.readFileSync(path.join(EXT, 'launcher.html'), 'utf8');
  const css = fs.readFileSync(path.join(EXT, 'explain.css'), 'utf8');
  // markup: a header row (icon, then the name) comes before exactly one button labelled "Explain this page"
  assert.match(html, /<body class="launcher">/);
  assert.match(html, /<header class="brand"><img [^>]*icon-48\.png[^>]*><h1>Term Sherpa<\/h1><\/header>\s*<button id="again" class="primary">Explain this page<\/button>/);
  assert.equal((html.match(/<button\b/g) || []).length, 1, 'exactly one button');
  // css: body.launcher has an explicit width of 320px (and min-width, so the popup cannot shrink to its content)
  const rule = (css.match(/body\.launcher\s*\{([^}]*)\}/) || [])[1] || '';
  assert.match(rule, /(^|[;\s])width:\s*320px/); assert.match(rule, /min-width:\s*320px/);
  assert.match(rule, /box-sizing:\s*border-box/);
  // the brand header is a flex row; the button is full width
  assert.match(css, /header\.brand\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center/);
  assert.match(css, /body\.launcher button\.primary\s*\{[^}]*width:\s*100%/);
  // the old causes of the thin column are gone: no auto-width override for the popup, and no break-anywhere inside the popup
  assert.ok(!/@media[^{]*\{\s*body\.launcher\s*\{\s*width:\s*auto/.test(css), 'no @media rule makes the popup auto-width');
  assert.match(rule, /overflow-wrap:\s*normal/); assert.match(rule, /word-break:\s*normal/);
});
