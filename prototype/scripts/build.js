#!/usr/bin/env node
'use strict';
/*
 * build.js - makes the store/release packages from the ONE shared source tree (extension/). No dependencies.
 *
 *   node scripts/build.js                 -> dist/chrome/, dist/firefox/, dist/terms-guide-<ver>-chrome.zip, dist/terms-guide-<ver>-firefox.zip
 *   node scripts/build.js chrome|firefox  -> just that one
 *
 * Both packages contain exactly the same files as extension/. They differ ONLY in manifest.json:
 *   chrome  = extension/manifest.json unchanged (it is also what "Load unpacked" on extension/ uses; works in Edge, Brave, Opera, Vivaldi)
 *   firefox = extension/manifest.json + manifests/firefox.overlay.json (browser_specific_settings.gecko minimum versions, data_collection_permissions, ...)
 *             and, if the shared manifest ever has background.service_worker, it becomes background.scripts (Firefox MV3 format).
 * The zips are reproducible (sorted entries, fixed timestamps) so the same source always gives the same bytes.
 * The build never deletes anything: it overwrites files in dist/<target>/ and stops with a message if dist/<target>/ holds a
 * file that is not part of the package (stale output from an older source tree), so you can remove that by hand.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function walk(dir, base) {
  base = base || dir;
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((d) => {
    if (d.name.startsWith('.') || d.name.endsWith('.map')) return [];
    const full = path.join(dir, d.name);
    return d.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

function isPlainObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }
function merge(base, over) {
  const out = Object.assign({}, base);
  for (const k of Object.keys(over)) {
    if (k.startsWith('_')) continue; // "_comment" keys are notes, not manifest keys
    out[k] = isPlainObject(over[k]) && isPlainObject(base[k]) ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

function chromeManifest(base) { return base; }

function firefoxManifest(base) {
  const m = merge(base, readJson(path.join(ROOT, 'manifests', 'firefox.overlay.json')));
  // Firefox MV3 has no extension service worker: it uses an event page declared as background.scripts.
  if (m.background && m.background.service_worker) m.background = { scripts: [m.background.service_worker] };
  return m;
}

const TARGETS = { chrome: chromeManifest, firefox: firefoxManifest };

// ---- a tiny reproducible zip writer (deflate or store, no zip64, no extra fields) ----
const DOS_TIME = 0; const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixed 2026-01-01 00:00
function zip(entries) { // entries: [{ name, data: Buffer }] already sorted
  const locals = []; const centrals = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const comp = zlib.deflateRawSync(e.data, { level: 9 });
    const useDeflate = comp.length < e.data.length;
    const body = useDeflate ? comp : e.data;
    const crc = zlib.crc32(e.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
    lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(useDeflate ? 8 : 0, 10);
    ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function build(target) {
  const base = readJson(path.join(SRC, 'manifest.json'));
  const manifest = TARGETS[target](base);
  const outDir = path.join(DIST, target);
  const entries = walk(SRC).filter((f) => f !== 'manifest.json').map((f) => ({ name: f, data: fs.readFileSync(path.join(SRC, f)) }));
  const mjson = target === 'chrome' ? fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8') : JSON.stringify(manifest, null, 2) + '\n'; // chrome: the source file byte for byte
  entries.push({ name: 'manifest.json', data: Buffer.from(mjson) });
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  if (fs.existsSync(outDir)) {
    const want = new Set(entries.map((e) => e.name));
    const stale = walk(outDir).filter((f) => !want.has(f));
    if (stale.length) throw new Error('dist/' + target + ' has files that are not in the package (' + stale.slice(0, 3).join(', ') + '); remove dist/' + target + ' by hand and build again');
  }
  for (const e of entries) {
    const dest = path.join(outDir, e.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.data);
  }
  const zipPath = path.join(DIST, 'terms-guide-' + base.version + '-' + target + '.zip');
  fs.writeFileSync(zipPath, zip(entries));
  return { target, dir: outDir, zip: zipPath, files: entries.length, version: manifest.version };
}

module.exports = { build, firefoxManifest, chromeManifest, merge, zip, walk, TARGETS };

if (require.main === module) {
  const arg = process.argv[2];
  const targets = arg ? [arg] : Object.keys(TARGETS);
  fs.mkdirSync(DIST, { recursive: true });
  for (const t of targets) {
    if (!TARGETS[t]) { console.error('unknown target: ' + t + ' (use chrome or firefox)'); process.exit(2); }
    try {
      const r = build(t);
      console.log(`built ${r.target}: ${path.relative(process.cwd(), r.dir)}/ (${r.files} files, v${r.version}) + ${path.relative(process.cwd(), r.zip)}`);
    } catch (e) { console.error('build failed: ' + e.message); process.exit(1); }
  }
}
