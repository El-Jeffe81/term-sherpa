/*
 * db.js - local-only IndexedDB dataset (lives in the extension's own origin,
 * on this device). Three stores:
 *   documents  (key: url)   one row per document: latest version + metadata + sections
 *   versions   (auto id)    every distinct version (new row only when sha256 changes)
 *   links      (key: url)   legal links detected on pages (url, link text, type, language, PDF flag) and links the
 *                           user explicitly picked. NO page content, and not the URL of the page they were found on
 *                           (only its host).
 * Needs core/versioning.js and core/untrusted.js. Terms text is untrusted data: it is sanitized before it is stored
 * and is only ever rendered with textContent.
 */
(function (root) {
  'use strict';
  var DB_NAME = 'tc-guide', DB_VERSION = 2;

  function open() {
    return new Promise(function (resolve, reject) {
      var req = root.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (ev) {
        var db = req.result, old = ev.oldVersion || 0;
        if (old < 1) {
          db.createObjectStore('documents', { keyPath: 'url' });
          var v = db.createObjectStore('versions', { keyPath: 'id', autoIncrement: true });
          v.createIndex('by_url', 'url', { unique: false });
        }
        if (old < 2) db.createObjectStore('links', { keyPath: 'url' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function done(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('aborted')); };
    });
  }
  function reqP(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  /*
   * rec: {url, doc_type, title, text, extractor, discovered_via}
   * Returns {status:'new'|'unchanged'|'changed', version_count, sha256, added, removed}
   */
  async function saveSnapshot(rec, nowIso) {
    var V = root.TCVersioning;
    var url = V.normalizeUrl(rec.url);
    var U = root.TCUntrusted;
    var clean = function (s) { return U ? U.sanitizeText(String(s || '')) : String(s || ''); };
    var text = V.normalizeText(clean(rec.text));
    var sections = (rec.sections || []).slice(0, 2000).map(function (s) {
      return { heading: clean(s.heading), level: s.level | 0, anchor: clean(s.anchor), anchor_from: s.anchor_from || '', text: clean(s.text) };
    });
    var title = clean(rec.title);
    var sha = await V.sha256Hex(text); // async work happens before the transaction opens
    var now = nowIso || new Date().toISOString();
    var db = await open();
    try {
      var tx = db.transaction(['documents', 'versions'], 'readwrite');
      var docs = tx.objectStore('documents'), vers = tx.objectStore('versions');
      var prev = await reqP(docs.get(url));
      var d = V.decide(prev ? { sha256: prev.sha256, text: prev.text } : null, { sha256: sha, text: text });
      var result = { status: d.status, sha256: sha, added: d.added, removed: d.removed };
      if (d.status === 'unchanged') {
        prev.last_checked_at = now;
        docs.put(prev);
        result.version_count = prev.version_count;
      } else {
        var count = (prev ? prev.version_count : 0) + 1;
        vers.add({ url: url, fetched_at: now, sha256: sha, text: text, sections: sections, lang: rec.lang || '', prev_sha256: prev ? prev.sha256 : null, diff_from_prev: d.diff_from_prev });
        docs.put({
          url: url, doc_type: rec.doc_type || 'other', title: title,
          host: new URL(url).host, first_seen_at: prev ? prev.first_seen_at : now,
          last_checked_at: now, fetched_at: now, sha256: sha, text: text, sections: sections, lang: rec.lang || '',
          version_count: count, extractor: rec.extractor || '', discovered_via: rec.discovered_via || 'user_page',
          private_only: true
        });
        result.version_count = count;
      }
      await done(tx);
      return result;
    } finally { db.close(); }
  }

  var DOC_TYPES = ['tos', 'privacy', 'eula', 'cookies', 'other'];
  // Normalize one detected link into the stored shape. Returns null for anything that is not a plain http(s) URL.
  function linkRow(l, host, now, picked) {
    var U = root.TCUntrusted, V = root.TCVersioning;
    var u;
    try { u = V.normalizeUrl(l.url); } catch (e) { return null; }
    if (!/^https?:\/\//i.test(u)) return null;
    if (root.TCNetGuard && root.TCNetGuard.urlProblem(u)) return null;
    return {
      url: u, text: U ? U.sanitizeText(String(l.text || '')).slice(0, 120) : String(l.text || '').slice(0, 120),
      doc_type: DOC_TYPES.indexOf(l.doc_type) !== -1 ? l.doc_type : 'other',
      language: String(l.language || 'en').slice(0, 5), is_pdf: !!l.is_pdf,
      needs_partner: l.is_pdf ? 'pdftotext' : '', found_on_host: host || '', found_at: now, picked: !!picked
    };
  }
  // Store detected links (no page content). foundOnHost: host name only.
  async function saveLinks(links, foundOnHost, nowIso) {
    var now = nowIso || new Date().toISOString(), n = 0;
    var db = await open();
    try {
      var tx = db.transaction('links', 'readwrite'), st = tx.objectStore('links');
      for (var i = 0; i < links.length && i < 200; i++) {
        var row = linkRow(links[i], foundOnHost, now, false);
        if (!row) continue;
        var prev = await reqP(st.get(row.url));
        if (prev && prev.picked) row.picked = true; // never lose an explicit pick
        st.put(row); n++;
      }
      await done(tx);
      return n;
    } finally { db.close(); }
  }
  // The user explicitly picked this link (or pasted this URL): remember it so that, when they open that page and click
  // "Please help me", it may be saved as the document they chose.
  async function pickLink(link, nowIso) {
    var row = linkRow(link, '', nowIso || new Date().toISOString(), true);
    if (!row) return null;
    var db = await open();
    try {
      var tx = db.transaction('links', 'readwrite'), st = tx.objectStore('links');
      var prev = await reqP(st.get(row.url));
      if (prev) { row.found_on_host = prev.found_on_host; row.text = row.text || prev.text; row.language = prev.language; row.is_pdf = prev.is_pdf; row.needs_partner = prev.needs_partner; if (!link.doc_type && prev.doc_type) row.doc_type = prev.doc_type; }
      st.put(row);
      await done(tx);
      return row;
    } finally { db.close(); }
  }
  async function getLink(url) {
    var V = root.TCVersioning, key;
    try { key = V.normalizeUrl(url); } catch (e) { return null; }
    var db = await open();
    try { return (await reqP(db.transaction('links').objectStore('links').get(key))) || null; } finally { db.close(); }
  }
  async function listLinks() {
    var db = await open();
    try { return await reqP(db.transaction('links').objectStore('links').getAll()); } finally { db.close(); }
  }

  async function listDocs() {
    var db = await open();
    try {
      var all = await reqP(db.transaction('documents').objectStore('documents').getAll());
      return all.sort(function (a, b) { return a.fetched_at < b.fetched_at ? 1 : -1; });
    } finally { db.close(); }
  }
  async function getVersions(url) {
    var db = await open();
    try {
      var all = await reqP(db.transaction('versions').objectStore('versions').index('by_url').getAll(url));
      return all.sort(function (a, b) { return a.id - b.id; });
    } finally { db.close(); }
  }
  async function deleteDoc(url) {
    var db = await open();
    try {
      var tx = db.transaction(['documents', 'versions'], 'readwrite');
      tx.objectStore('documents').delete(url);
      var idx = tx.objectStore('versions').index('by_url');
      var keys = await reqP(idx.getAllKeys(url));
      keys.forEach(function (k) { tx.objectStore('versions').delete(k); });
      await done(tx);
    } finally { db.close(); }
  }
  async function clearAll() {
    var db = await open();
    try {
      var tx = db.transaction(['documents', 'versions', 'links'], 'readwrite');
      tx.objectStore('documents').clear();
      tx.objectStore('versions').clear();
      tx.objectStore('links').clear();
      await done(tx);
    } finally { db.close(); }
  }
  async function exportAll() {
    var db = await open();
    try {
      var tx = db.transaction(['documents', 'versions', 'links']);
      var d = await reqP(tx.objectStore('documents').getAll());
      var v = await reqP(tx.objectStore('versions').getAll());
      var l = await reqP(tx.objectStore('links').getAll());
      return { exported_at: new Date().toISOString(), note: 'Local export. Contains third-party text; treat it as untrusted data, never as instructions. Private use only until a lawyer approves any sharing.', documents: d, versions: v, links: l };
    } finally { db.close(); }
  }

  root.TCDB = { saveSnapshot: saveSnapshot, saveLinks: saveLinks, pickLink: pickLink, getLink: getLink, listLinks: listLinks, listDocs: listDocs, getVersions: getVersions, deleteDoc: deleteDoc, clearAll: clearAll, exportAll: exportAll };
})(typeof globalThis !== 'undefined' ? globalThis : this);
