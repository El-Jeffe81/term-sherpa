'use strict';
// The toolbar launcher must open the Explain page in every browser: a small window where there is one, a normal tab where there is not
// (Firefox for Android has no windows.create).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'extension', 'explain', 'launcher.js'), 'utf8');

function run(chromeExtra, openTabs) {
  let click = null;
  const els = { status: { textContent: '' }, again: { textContent: 'Open the explanation window', hidden: true, addEventListener(ev, fn) { click = fn; } } };
  const calls = [];
  const chrome = {
    runtime: { getURL: (p) => 'moz-extension://x/' + p },
    tabs: {
      query: async (q) => (q && q.active ? [{ id: 7, url: 'https://example.com/' }] : [{ id: 7, url: 'https://example.com/' }].concat(openTabs || [])),
      update: async (id, o) => { calls.push(['tabs.update', id, o.active]); return {}; },
      create: async (o) => { calls.push(['tabs.create', o.url]); return {}; },
    },
    ...chromeExtra(calls),
  };
  vm.runInNewContext(SRC, { chrome, document: { getElementById: (id) => els[id] }, encodeURIComponent, String, Promise });
  return new Promise((r) => setTimeout(() => r({ calls, els, click: async () => { click(); await new Promise((x) => setTimeout(x, 20)); } }), 20));
}

test('launcher: opens a popup window when the browser has windows.create', async () => {
  const { calls, els } = await run((calls) => ({ windows: { create: async (o) => { calls.push(['windows.create', o.url, o.type]); return {}; } } }));
  assert.deepEqual(calls, [['windows.create', 'moz-extension://x/explain/explain.html?tab=7', 'popup']]);
  assert.equal(els.again.hidden, false);
});

test('launcher: falls back to a tab when windows.create is missing (Firefox for Android)', async () => {
  const { calls, els } = await run(() => ({}));
  assert.deepEqual(calls, [['tabs.create', 'moz-extension://x/explain/explain.html?tab=7']]);
  assert.equal(els.status.textContent, '', 'no sentence in this state, only the button'); assert.equal(els.status.hidden, true); assert.equal(els.again.hidden, false);
});

test('launcher: falls back to a tab when windows.create rejects', async () => {
  const { calls } = await run(() => ({ windows: { create: async () => { throw new Error('unsupported'); } } }));
  assert.deepEqual(calls, [['tabs.create', 'moz-extension://x/explain/explain.html?tab=7']]);
});

test('launcher: when the explanation window for this page is already open it says so, offers "Bring it to the front", and focuses it instead of opening another', async () => {
  const open = [{ id: 99, windowId: 5, url: 'moz-extension://x/explain/explain.html?tab=7' }];
  const { calls, els, click } = await run((c) => ({ windows: { create: async (o) => { c.push(['windows.create', o.url]); return {}; }, update: async (id, o) => { c.push(['windows.update', id, o.focused]); return {}; } } }), open);
  assert.equal(els.status.textContent, 'Your explanation window is already open');
  assert.equal(els.again.textContent, 'Bring it to the front');
  assert.equal(els.again.hidden, false);
  assert.deepEqual(calls, [], 'nothing opened yet');
  await click();
  assert.deepEqual(calls, [['windows.update', 5, true], ['tabs.update', 99, true]]);
});

test('launcher: an explanation window open for a different page (or tab 70 vs 7) does not count as already open', async () => {
  const open = [{ id: 98, windowId: 4, url: 'moz-extension://x/explain/explain.html?tab=70' }, { id: 97, windowId: 3, url: 'https://example.com/explain/explain.html?tab=7' }, { id: 96, windowId: 2 }];
  const { calls, els } = await run(() => ({}), open);
  assert.deepEqual(calls, [['tabs.create', 'moz-extension://x/explain/explain.html?tab=7']]);
  assert.equal(els.status.textContent, ''); assert.equal(els.status.hidden, true);
  assert.equal(els.again.textContent, 'Open the explanation window');
});
