'use strict';
/*
 * store.js - local SQLite dataset (node:sqlite, built into Node >= 22.13; no third-party package).
 * Schema follows docs section 6 of the findings (source/document/version), minus the `analysis`
 * table: no AI/summarizing in this phase.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const V = require('../../extension/core/versioning');
const U = require('../../extension/core/untrusted');
const Q = require('../../extension/core/quality');

function defaultDbPath() {
  if (process.env.TC_COLLECT_DB) return process.env.TC_COLLECT_DB;
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'tc-collect', 'dataset.sqlite');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS source (
  source_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'web' CHECK (kind IN ('web','google_play','apple_app_store')),
  app_or_site_id TEXT NOT NULL UNIQUE,
  name TEXT, locale TEXT
);
CREATE TABLE IF NOT EXISTS document (
  doc_id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES source(source_id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('tos','privacy','eula','cookies','other')),
  url TEXT NOT NULL UNIQUE, final_url TEXT, discovered_via TEXT,
  robots_checked_at TEXT, robots_allowed INTEGER, license_note TEXT,
  first_seen_at TEXT, last_checked_at TEXT
);
CREATE TABLE IF NOT EXISTS version (
  version_id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES document(doc_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  http_status INTEGER, mime_type TEXT, user_agent TEXT,
  content_hash_raw TEXT, content_hash_clean TEXT NOT NULL,
  raw_blob BLOB, clean_text TEXT NOT NULL,
  prev_version_id INTEGER, diff_from_prev TEXT,
  extractor TEXT, title TEXT,
  copyright_note TEXT DEFAULT 'Third-party text. Private, local use only until counsel approves any sharing.',
  private_only INTEGER NOT NULL DEFAULT 1,
  UNIQUE (doc_id, seq)
);
CREATE TABLE IF NOT EXISTS section (
  section_id INTEGER PRIMARY KEY,
  version_id INTEGER NOT NULL REFERENCES version(version_id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  heading TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 0,
  anchor TEXT NOT NULL DEFAULT '', anchor_from TEXT,
  text TEXT NOT NULL,
  UNIQUE (version_id, idx)
);
CREATE TABLE IF NOT EXISTS host_throttle (host TEXT PRIMARY KEY, last_request_ms INTEGER NOT NULL);
`;

// Add columns that older dataset files lack (idempotent).
function migrate(db) {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
  const add = (t, c, def) => { if (!has(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  add('document', 'needs_partner', 'TEXT');          // e.g. 'pdftotext': found, but cannot be read until that partner is approved
  add('document', 'needs_partner_since', 'TEXT');
  add('document', 'mime_type', 'TEXT');
  add('version', 'lang', 'TEXT');
  add('version', 'removed_chars', 'INTEGER NOT NULL DEFAULT 0');   // invisible/control characters stripped from the text
  add('version', 'injection_hints', 'INTEGER NOT NULL DEFAULT 0'); // phrases addressed to an AI; flagged, never obeyed
}

function openStore(file) {
  file = file || defaultDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }

  const q = (sql) => db.prepare(sql);

  function upsertSource(host) {
    q('INSERT OR IGNORE INTO source (kind, app_or_site_id, name) VALUES (\'web\', ?, ?)').run(host, host);
    return q('SELECT source_id FROM source WHERE app_or_site_id = ?').get(host).source_id;
  }

  /*
   * rec: {url, finalUrl, docType, discoveredVia, robotsCheckedAt, robotsAllowed, fetchedAt, status,
   *       mime, userAgent, rawBuffer|null, cleanText, extractor, title}
   * Inserts a new version ONLY if the clean-text hash differs from the latest one.
   */
  async function saveVersion(rec) {
    const url = V.normalizeUrl(rec.url);
    // Terms text is untrusted third-party data: strip invisible/control characters, then store as plain text only.
    const removedChars = (rec.removedChars || 0) + U.countSuspicious(rec.cleanText); // collect.js sanitizes first and passes its own count
    const text = V.normalizeText(U.sanitizeText(rec.cleanText));
    const title = U.sanitizeText(rec.title || '');
    const sections = (rec.sections && rec.sections.length ? rec.sections : [{ heading: '', level: 0, anchor: '', anchor_from: null, text }])
      .map((x) => ({ heading: U.sanitizeText(x.heading || ''), level: x.level | 0, anchor: U.sanitizeText(x.anchor || ''), anchor_from: x.anchor_from || null, text: V.normalizeText(U.sanitizeText(x.text || '')) }));
    const lang = rec.lang || Q.guessLanguage(text).lang;
    const injectionHints = U.injectionHints(text);
    const hashClean = await V.sha256Hex(text);
    const hashRaw = rec.rawBuffer ? await V.sha256Hex(rec.rawBuffer.toString('latin1')) : null;
    const host = new URL(rec.finalUrl || url).host;
    db.exec('BEGIN IMMEDIATE');
    try {
      const sourceId = upsertSource(host);
      let doc = q('SELECT * FROM document WHERE url = ?').get(url);
      if (!doc) {
        q(`INSERT INTO document (source_id, doc_type, url, final_url, discovered_via, robots_checked_at, robots_allowed, first_seen_at, last_checked_at)
           VALUES (?,?,?,?,?,?,?,?,?)`).run(sourceId, rec.docType, url, rec.finalUrl, rec.discoveredVia || 'user_pasted',
          rec.robotsCheckedAt, rec.robotsAllowed ? 1 : 0, rec.fetchedAt, rec.fetchedAt);
        doc = q('SELECT * FROM document WHERE url = ?').get(url);
      } else {
        q('UPDATE document SET needs_partner=NULL, needs_partner_since=NULL, last_checked_at=?, final_url=?, robots_checked_at=?, robots_allowed=?, doc_type=? WHERE doc_id=?')
          .run(rec.fetchedAt, rec.finalUrl, rec.robotsCheckedAt, rec.robotsAllowed ? 1 : 0, rec.docType, doc.doc_id);
      }
      const prev = q('SELECT version_id, seq, clean_text, content_hash_clean FROM version WHERE doc_id=? ORDER BY seq DESC LIMIT 1').get(doc.doc_id);
      const d = V.decide(prev ? { sha256: prev.content_hash_clean, text: prev.clean_text } : null, { sha256: hashClean, text });
      let versionId = prev ? prev.version_id : null, seq = prev ? prev.seq : 0;
      if (d.status !== 'unchanged') {
        seq = (prev ? prev.seq : 0) + 1;
        const info = q(`INSERT INTO version (doc_id, seq, fetched_at, http_status, mime_type, user_agent, content_hash_raw, content_hash_clean,
                         raw_blob, clean_text, prev_version_id, diff_from_prev, extractor, title, lang, removed_chars, injection_hints)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(doc.doc_id, seq, rec.fetchedAt, rec.status, rec.mime, rec.userAgent, hashRaw, hashClean,
            rec.rawBuffer || null, text, prev ? prev.version_id : null, d.diff_from_prev, rec.extractor, title, lang, removedChars, injectionHints);
        versionId = Number(info.lastInsertRowid);
        const ins = q('INSERT INTO section (version_id, idx, heading, level, anchor, anchor_from, text) VALUES (?,?,?,?,?,?,?)');
        sections.forEach((x, i) => ins.run(versionId, i, x.heading, x.level, x.anchor, x.anchor_from, x.text));
      }
      db.exec('COMMIT');
      return { status: d.status, docId: doc.doc_id, versionId, seq, sha256: hashClean, added: d.added, removed: d.removed };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  /*
   * A document that was found but cannot be read yet (e.g. a PDF). Stores only the URL and the marker; no text, no file.
   * Never overwrites a document that already has stored versions' status except to note the marker.
   */
  function markNeedsPartner(rec) {
    const url = V.normalizeUrl(rec.url);
    const host = new URL(rec.finalUrl || url).host;
    db.exec('BEGIN IMMEDIATE');
    try {
      const sourceId = upsertSource(host);
      const doc = q('SELECT * FROM document WHERE url = ?').get(url);
      if (!doc) {
        q(`INSERT INTO document (source_id, doc_type, url, final_url, discovered_via, robots_checked_at, robots_allowed, first_seen_at, last_checked_at, needs_partner, needs_partner_since, mime_type)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(sourceId, rec.docType || 'other', url, rec.finalUrl || url, rec.discoveredVia || 'user_pasted',
          rec.robotsCheckedAt || null, 1, rec.fetchedAt, rec.fetchedAt, rec.partner, rec.fetchedAt, rec.mime || null);
      } else {
        q('UPDATE document SET needs_partner=?, needs_partner_since=COALESCE(needs_partner_since, ?), mime_type=?, last_checked_at=? WHERE doc_id=?')
          .run(rec.partner, rec.fetchedAt, rec.mime || null, rec.fetchedAt, doc.doc_id);
      }
      db.exec('COMMIT');
      return { docId: q('SELECT doc_id FROM document WHERE url = ?').get(url).doc_id };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  function getSections(versionId) {
    return q('SELECT idx, heading, level, anchor, anchor_from, text FROM section WHERE version_id=? ORDER BY idx').all(versionId);
  }

  // One row per document with its latest version, for the quality report.
  function qualityRows() {
    return q('SELECT doc_id FROM document ORDER BY doc_id').all().map(({ doc_id }) => {
      const d = q('SELECT * FROM document WHERE doc_id=?').get(doc_id);
      const v = q('SELECT version_id, clean_text, lang, removed_chars, injection_hints, length(raw_blob) AS raw_bytes FROM version WHERE doc_id=? ORDER BY seq DESC LIMIT 1').get(doc_id);
      const n = q('SELECT COUNT(*) AS n FROM version WHERE doc_id=?').get(doc_id).n;
      return { url: d.url, doc_type: d.doc_type, needs_partner: d.needs_partner, last_checked_at: d.last_checked_at, versions: n,
        text: v ? v.clean_text : null, lang: v ? v.lang : null, rawBytes: v ? v.raw_bytes : 0, removedChars: v ? v.removed_chars : 0, injectionHints: v ? v.injection_hints : 0,
        sections: v ? getSections(v.version_id) : [] };
    });
  }

  function listDocs() {
    return q(`SELECT d.doc_id, d.doc_type, d.url, d.needs_partner, d.final_url, d.first_seen_at, d.last_checked_at,
                     (SELECT COUNT(*) FROM version v WHERE v.doc_id = d.doc_id) AS versions,
                     (SELECT content_hash_clean FROM version v WHERE v.doc_id = d.doc_id ORDER BY seq DESC LIMIT 1) AS sha256,
                     (SELECT fetched_at FROM version v WHERE v.doc_id = d.doc_id ORDER BY seq DESC LIMIT 1) AS fetched_at
              FROM document d ORDER BY d.doc_id`).all();
  }
  function getDoc(url) { return q('SELECT * FROM document WHERE url = ?').get(V.normalizeUrl(url)); }
  function getVersions(docId) {
    return q('SELECT version_id, seq, fetched_at, http_status, content_hash_clean, content_hash_raw, clean_text, diff_from_prev, extractor, user_agent, title, lang FROM version WHERE doc_id=? ORDER BY seq').all(docId);
  }

  const persistThrottle = {
    get(host) { const r = q('SELECT last_request_ms FROM host_throttle WHERE host=?').get(host); return r ? r.last_request_ms : null; },
    set(host, ms) { q('INSERT INTO host_throttle (host,last_request_ms) VALUES (?,?) ON CONFLICT(host) DO UPDATE SET last_request_ms=excluded.last_request_ms').run(host, ms); }
  };

  return { db, saveVersion, markNeedsPartner, getSections, qualityRows, listDocs, getDoc, getVersions, persistThrottle, close: () => db.close(), file };
}

module.exports = { openStore, defaultDbPath };
