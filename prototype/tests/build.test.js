'use strict';
// The Chrome and Firefox packages are built from one shared source; these tests pin what may differ between them.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { firefoxManifest, chromeManifest, merge, zip } = require('../scripts/build.js');
const { validatePackages } = require('./validate-manifest');
const base = require('../extension/manifest.json');

test('firefox manifest = shared manifest + browser_specific_settings only', () => {
  const f = firefoxManifest(base);
  assert.equal(f.browser_specific_settings.gecko.id, 'terms-guide@el-jeffe81.github.io');
  assert.ok(parseInt(f.browser_specific_settings.gecko.strict_min_version, 10) >= 140);
  assert.deepEqual(f.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] });
  const rest = Object.assign({}, f); delete rest.browser_specific_settings;
  assert.deepEqual(rest, base);
  assert.equal('browser_specific_settings' in chromeManifest(base), false);
});

test('shared source is not mutated by the Firefox overlay', () => {
  const before = JSON.stringify(base);
  firefoxManifest(base);
  assert.equal(JSON.stringify(base), before);
});

test('a future service worker would become background.scripts for Firefox only', () => {
  const withBg = Object.assign({}, base, { background: { service_worker: 'bg.js', type: 'module' } });
  const f = firefoxManifest(withBg);
  assert.deepEqual(f.background, { scripts: ['bg.js'] });
});

test('merge skips _comment keys and merges nested objects', () => {
  assert.deepEqual(merge({ a: { b: 1 }, c: 1 }, { _comment: 'x', a: { d: 2 } }), { a: { b: 1, d: 2 }, c: 1 });
});

test('built chrome + firefox packages pass every manifest rule and share all other files byte for byte', () => {
  assert.deepEqual(validatePackages(), []);
});

test('zip writer is reproducible and round-trips', () => {
  const entries = [{ name: 'a.txt', data: Buffer.from('hello hello hello hello hello') }, { name: 'd/b.bin', data: Buffer.from([1, 2, 3]) }];
  const z1 = zip(entries); const z2 = zip(entries);
  assert.ok(z1.equals(z2));
  // read it back with the central directory
  const end = z1.length - 22;
  assert.equal(z1.readUInt32LE(end), 0x06054b50);
  const count = z1.readUInt16LE(end + 10);
  let p = z1.readUInt32LE(end + 16); const got = {};
  for (let i = 0; i < count; i++) {
    const method = z1.readUInt16LE(p + 10); const csize = z1.readUInt32LE(p + 20); const nlen = z1.readUInt16LE(p + 28);
    const off = z1.readUInt32LE(p + 42); const name = z1.toString('utf8', p + 46, p + 46 + nlen);
    const dstart = off + 30 + z1.readUInt16LE(off + 26) + z1.readUInt16LE(off + 28);
    const raw = z1.subarray(dstart, dstart + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(zlib.crc32(data) >>> 0, z1.readUInt32LE(p + 16));
    got[name] = Buffer.from(data); p += 46 + nlen;
  }
  assert.ok(got['a.txt'].equals(entries[0].data) && got['d/b.bin'].equals(entries[1].data));
});
