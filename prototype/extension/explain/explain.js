/*
 * explain.js - the Explain window. No network calls. Terms text never goes through HTML: everything from the page is
 * shown with textContent. The analysis (core/analyze.js) is fixed on-device rules, not AI.
 *
 * The page is touched ONLY by run(), which starts when this window opens as a result of the user's click on the
 * toolbar icon (activeTab is granted for that tab by the click). The launcher passes only the tab id in the URL.
 *
 * Storage: by DEFAULT NOTHING ABOUT THE TERMS IS SAVED. The old collection path (TCDB, IndexedDB) is kept but is used
 * only inside maybeSave(), and only if the user ticked "Also save a copy" in Options (a boolean flag in localStorage).
 * The only other thing kept is the one link a user picks from a list ("Open this page"): its URL and type, for one hour.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var INJECT_FILES = ['core/untrusted.js', 'core/extract.js', 'core/detect.js', 'core/consent.js', 'content/run.js'];
  var TYPE_LABEL = { tos: 'Terms', privacy: 'Privacy', eula: 'EULA', cookies: 'Cookies', other: 'Other' };
  var SAVE_KEY = 'tc.saveCopies';
  var PICK_KEY = 'tc.picks';
  var PICK_TTL_MS = 60 * 60 * 1000;

  function setStatus(msg, isErr) { var s = $('status'); s.textContent = msg; s.className = isErr ? 'err' : ''; }
  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }
  function clear(node) { node.textContent = ''; }
  function hostOf(u) { try { return new URL(u).host; } catch (e) { return ''; } }
  function stripHash(u) { return String(u || '').replace(/#.*$/, ''); }

  /* ---------- options and picks (localStorage of the extension page; no terms text) ---------- */
  function saveEnabled() { try { return localStorage.getItem(SAVE_KEY) === '1'; } catch (e) { return false; } }
  function setSaveEnabled(on) { try { if (on) localStorage.setItem(SAVE_KEY, '1'); else localStorage.removeItem(SAVE_KEY); } catch (e) { /* best effort */ } }
  function readPicks() {
    try {
      var now = Date.now();
      return (JSON.parse(localStorage.getItem(PICK_KEY) || '[]') || []).filter(function (p) { return p && p.url && now - p.at < PICK_TTL_MS; });
    } catch (e) { return []; }
  }
  function addPick(url, docType) {
    try {
      var picks = readPicks().filter(function (p) { return stripHash(p.url) !== stripHash(url); });
      picks.push({ url: stripHash(url), doc_type: docType || 'other', at: Date.now() });
      localStorage.setItem(PICK_KEY, JSON.stringify(picks.slice(-20)));
    } catch (e) { /* best effort */ }
  }
  function findPick(url) {
    var u = stripHash(url);
    var p = readPicks().filter(function (x) { return x.url === u; })[0];
    return p ? p.doc_type : '';
  }

  /* ---------- optional saving (OFF by default) ---------- */
  async function maybeSave(extracted) {
    if (!saveEnabled()) return null;
    return TCDB.saveSnapshot(extracted);
  }

  /* ---------- reading the page (only after the user's click on the icon) ---------- */
  async function runOnPage(tab, options) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: function (o) { globalThis.__tcOptions = o; }, args: [options] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: INJECT_FILES });
    var out = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function () { var r = globalThis.__tcResult; delete globalThis.__tcResult; return r; }
    });
    var res = out && out[0] && out[0].result;
    if (!res || !res.ok) throw new Error((res && res.error) || 'The page could not be read.');
    return res;
  }

  /* ---------- rendering (textContent only) ---------- */
  function sevBadge(sev) { return el('span', sev, 'badge sev-' + sev); }

  function quoteBlock(q, truncated) {
    var d = el('div');
    d.appendChild(el('blockquote', q));
    if (truncated) d.appendChild(el('div', 'Shortened: this is an exact piece of a longer sentence.', 'muted'));
    return d;
  }

  // One finding = one plain-English sentence. The exact verified wording is collapsed (a <details>, closed by default).
  function pointItem(f) {
    var li = el('li', undefined, 'point sev-' + f.severity);
    var top = el('div', undefined, 'line');
    top.appendChild(sevBadge(f.severity));
    top.appendChild(el('span', f.line, 'text'));
    li.appendChild(top);
    if (f.contextNote) li.appendChild(el('div', f.contextNote, 'ctx'));
    var d = el('details');
    d.appendChild(el('summary', 'Show exact wording'));
    f.evidence.forEach(function (e) { d.appendChild(quoteBlock(e.quote, e.truncated)); });
    if (f.mitigation) {
      d.appendChild(el('div', 'Opt-out wording:', 'label'));
      d.appendChild(quoteBlock(f.mitigation.quote, false));
    }
    li.appendChild(d);
    return li;
  }

  function renderAnalysis(a) {
    $('result').hidden = false;
    var sum = $('overview-summary'); clear(sum);
    a.overview.summary.forEach(function (t) { sum.appendChild(el('li', t)); });
    var notes = a.overview.notes.slice();
    if (a.injectionHints > 0) notes.push('This page contains text that looks like instructions to an AI. It was ignored; page text is only ever treated as data.');
    $('overview-note').textContent = notes.join(' ');
    $('overview-note').hidden = notes.length === 0;

    var risk = a.findings.filter(function (f) { return f.section === 'risk'; });
    var also = a.findings.filter(function (f) { return f.section === 'also'; });
    var rl = $('risk-list'); clear(rl);
    risk.forEach(function (f) { rl.appendChild(pointItem(f)); });
    $('risks').hidden = risk.length === 0;
    var al = $('also-list'); clear(al);
    also.forEach(function (f) { al.appendChild(pointItem(f)); });
    $('also').hidden = also.length === 0;
  }

  function showCandidates(links) {
    var list = $('candidate-list'); clear(list);
    links.forEach(function (l) {
      var li = el('li');
      li.appendChild(el('span', TYPE_LABEL[l.doc_type] || l.doc_type, 'badge'));
      li.appendChild(el('strong', (l.text || '(no link text)') + (l.language && l.language !== 'en' ? ' [' + l.language + ']' : '')));
      li.appendChild(el('span', ' (' + l.confidence + ' confidence)', 'muted'));
      if (l.is_pdf) li.appendChild(el('div', 'PDF: I cannot read PDFs yet (needs the pdftotext helper, pending approval). You can still open it.', 'muted'));
      li.appendChild(el('div', l.url, 'url'));
      var b = el('button', 'Open this page');
      b.addEventListener('click', function () { addPick(l.url, l.doc_type); chrome.tabs.create({ url: l.url }); });
      li.appendChild(b);
      list.appendChild(li);
    });
    $('candidates').hidden = links.length === 0;
    $('paste').hidden = links.length !== 0;
  }

  /* Turn the injected script's result into what the window shows. Exposed (TCExplainUI.show) so the headless e2e can check the rendering. */
  async function show(res) {
    $('result').hidden = true; $('candidates').hidden = true; $('paste').hidden = true;
    var page = res.page || {};
    if (page.is_pdf) { setStatus('This is a PDF, and I cannot read PDFs yet (it needs the pdftotext helper, pending approval).'); return { kind: 'pdf' }; }
    if (res.extracted) {
      if (res.extracted.text.length < 200) { setStatus('This looks like a terms page, but I could only read a little text. Try again once the page has finished loading.', true); return { kind: 'short' }; }
      var analysis = TCAnalyze.analyze(res.extracted.text, { doc_type: res.extracted.doc_type, title: res.extracted.title, host: hostOf(res.extracted.url) });
      renderAnalysis(analysis);
      var msg = 'Done. Nothing was saved.';
      try {
        var saved = await maybeSave(res.extracted);
        if (saved) msg = 'Done. A copy was saved on this device because you turned that option on (' + saved.status + ').';
      } catch (e) { msg = 'Done, but the copy could not be saved: ' + e.message; }
      setStatus(msg);
      return { kind: 'analysis', analysis: analysis };
    }
    if (page.sensitive) {
      setStatus('This looks like an account, checkout or payment page, so I did not read it. ' + (res.links.length ? 'Legal links found here are listed below.' : 'Open the site\'s terms page and try there.'));
      showCandidates(res.links);
      return { kind: 'sensitive' };
    }
    setStatus(page.is_hub ? 'This is a legal hub. Pick a document below, open it, then click the Terms Guide icon there.'
      : res.links.length ? 'This page is not a terms page, but I found ' + res.links.length + ' link(s) to legal pages. Pick one below.'
      : 'I did not find terms or privacy links on this page.');
    showCandidates(res.links);
    return { kind: 'links' };
  }

  async function run() {
    var tabId = parseInt(new URLSearchParams(location.search).get('tab') || '', 10);
    if (!isFinite(tabId)) { setStatus('Open a web page with terms on it, then click the Terms Guide icon in the toolbar.'); return; }
    try {
      var tab = await chrome.tabs.get(tabId);
      if (!/^https?:/i.test(tab.url || '')) throw new Error('I can only read normal web pages (http/https), not this kind of page.');
      var res = await runOnPage(tab, { pickedType: findPick(tab.url) });
      await show(res);
    } catch (e) {
      setStatus(e.message + ' If the page was changed or closed, click the Terms Guide icon again.', true);
    }
  }

  $('paste-open').addEventListener('click', function () {
    var raw = $('paste-url').value.trim(), u;
    try { u = new URL(raw); } catch (e) { return setStatus('That does not look like a web address.', true); }
    var problem = TCNetGuard.urlProblem(u.href);
    if (problem) return setStatus('I will not open that address: ' + problem, true);
    addPick(u.href, 'other');
    chrome.tabs.create({ url: u.href });
    setStatus('Opened. Click the Terms Guide icon on that page.');
  });

  var box = $('save-copies');
  box.checked = saveEnabled();
  box.addEventListener('change', function () { setSaveEnabled(box.checked); setStatus(box.checked ? 'Saving copies is ON for the next page you explain.' : 'Saving copies is OFF. Nothing about the terms is stored.'); });

  globalThis.TCExplainUI = { show: show, renderAnalysis: renderAnalysis };
  run();
})();
