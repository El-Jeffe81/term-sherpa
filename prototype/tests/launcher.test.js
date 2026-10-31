'use strict';
// The toolbar launcher must open the Explain page in every browser: a small window where there is one, a normal tab where there is not
// (Firefox for Android has no windows.create).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'extension', 'explain', 'launcher.js'), 'utf8');

function run(chromeExtra) {
  const els = { status: { textContent: '' }, again: { hidden: true, addEventListener() {} } };
  const calls = [];
  const chrome = {
    runtime: { getURL: (p) => 'moz-extension://x/' + p },
    tabs: {
      query: async () => [{ id: 7, url: 'https://example.com/' }],
      create: async (o) => { calls.push(['tabs.create', o.url]); return {}; },
    },
    ...chromeExtra(calls),
  };
  vm.runInNewContext(SRC, { chrome, document: { getElementById: (id) => els[id] }, encodeURIComponent, String, Promise });
  return new Promise((r) => setTimeout(() => r({ calls, els }), 20));
}

test('launcher: opens a popup window when the browser has windows.create', async () => {
  const { calls, els } = await run((calls) => ({ windows: { create: async (o) => { calls.push(['windows.create', o.url, o.type]); return {}; } } }));
  assert.deepEqual(calls, [['windows.create', 'moz-extension://x/explain/explain.html?tab=7', 'popup']]);
  assert.equal(els.again.hidden, false);
});

test('launcher: falls back to a tab when windows.create is missing (Firefox for Android)', async () => {
  const { calls, els } = await run(() => ({}));
  assert.deepEqual(calls, [['tabs.create', 'moz-extension://x/explain/explain.html?tab=7']]);
  assert.equal(els.status.textContent, 'The explanation window is open.');
});

test('launcher: falls back to a tab when windows.create rejects', async () => {
  const { calls } = await run(() => ({ windows: { create: async () => { throw new Error('unsupported'); } } }));
  assert.deepEqual(calls, [['tabs.create', 'moz-extension://x/explain/explain.html?tab=7']]);
});
