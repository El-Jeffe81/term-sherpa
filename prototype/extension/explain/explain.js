/*
 * explain.js - the Explain window. Terms text never goes through HTML: everything from the page is shown with
 * textContent. The analysis (core/analyze.js) is fixed on-device rules, not AI.
 *
 * The page is touched ONLY by run(), which starts when this window opens as a result of the user's click on the
 * toolbar icon (activeTab is granted for that tab by the click). The launcher passes only the tab id in the URL.
 *
 * Network: none, EXCEPT reading the legal documents the page's "I agree" dialog links to (core/docfetch.js, the only
 * fetching code). That happens only after the click above, only for the https links found in the dialog (max 6),
 * logged out (credentials omitted), and only once the user allowed the browser's one-time "access to <site>" prompt for
 * just those sites (optional_host_permissions: nothing is allowed up front). The dialog itself is only read, never
 * clicked. Fetched text is untrusted, shown through textContent, and not saved unless "Also save a copy" is on.
 *
 * Storage: by DEFAULT NOTHING ABOUT THE TERMS IS SAVED. The old collection path (TCDB, IndexedDB) is kept but is used
 * only inside maybeSave(), and only if the user ticked "Also save a copy" in Options (a boolean flag in localStorage).
 * The only other thing kept is the one link a user picks from a list ("Open this page"): its URL and type, for one hour.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  // Leading slash = relative to the extension root in every browser. Without it Firefox resolves the path against the calling page (explain/ or popup/) and the injection fails.
  var INJECT_FILES = ['/core/untrusted.js', '/core/extract.js', '/core/detect.js', '/core/consent.js', '/content/run.js'];
  var SHOW_LINKS = 3; // list mode: this many, the rest behind "Show more"
  var pending = null; // documents waiting for the user's OK to read them: { links, ctx }
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

  function userLang() { return (navigator.languages && navigator.languages[0]) || navigator.language || 'en-US'; }

  // One finding = one plain-English sentence. The exact verified wording is collapsed (a <details>, closed by default).
  // When several documents were read, each point says which of them it comes from.
  function pointItem(f, multi) {
    var li = el('li', undefined, 'point sev-' + f.severity);
    var top = el('div', undefined, 'line');
    top.appendChild(sevBadge(f.severity));
    top.appendChild(el('span', f.line, 'text'));
    if (multi && f.sources && f.sources.length) top.appendChild(el('span', f.sources.join(' + '), 'src'));
    li.appendChild(top);
    if (f.contextNote) li.appendChild(el('div', f.contextNote, 'ctx'));
    var d = el('details');
    d.appendChild(el('summary', 'Show exact wording'));
    var lastSource = null;
    f.evidence.forEach(function (e) {
      if (multi && e.source && e.source !== lastSource) { d.appendChild(el('div', 'From ' + e.source + ':', 'label')); lastSource = e.source; }
      d.appendChild(quoteBlock(e.quote, e.truncated));
    });
    if (f.mitigation) {
      d.appendChild(el('div', (multi && f.mitigation.source ? 'Opt-out wording (' + f.mitigation.source + '):' : 'Opt-out wording:'), 'label'));
      d.appendChild(quoteBlock(f.mitigation.quote, false));
    }
    li.appendChild(d);
    return li;
  }

  function renderAnalysis(a) {
    $('result').hidden = false;
    var multi = (a.documents || []).filter(function (d) { return d.label; }).length > 0;
    var sum = $('overview-summary'); clear(sum);
    a.overview.summary.forEach(function (t) { sum.appendChild(el('li', t)); });
    var notes = a.overview.notes.slice();
    if (a.injectionHints > 0) notes.push('This page contains text that looks like instructions to an AI. It was ignored; page text is only ever treated as data.');
    $('overview-note').textContent = notes.join(' ');
    $('overview-note').hidden = notes.length === 0;

    var risk = a.findings.filter(function (f) { return f.section === 'risk'; });
    var also = a.findings.filter(function (f) { return f.section === 'also'; });
    var rl = $('risk-list'); clear(rl);
    risk.forEach(function (f) { rl.appendChild(pointItem(f, multi)); });
    $('risks').hidden = risk.length === 0;
    var al = $('also-list'); clear(al);
    also.forEach(function (f) { al.appendChild(pointItem(f, multi)); });
    $('also').hidden = also.length === 0;
  }

  function variantNote(d) { return d.variants ? '(' + d.variants + ' other regional or language version' + (d.variants === 1 ? '' : 's') + ' of this page not shown)' : ''; }

  // Which documents were read, which were not and why. Collapsed. Links are opened by the user, never followed here.
  function renderDocuments(items) {
    var box = $('docs-read'), list = $('docs-list'); clear(list);
    items.forEach(function (it) {
      var li = el('li');
      li.appendChild(el('span', it.label || 'Document', 'badge'));
      li.appendChild(el('span', it.ok ? 'read' : 'not read: ' + it.reason, it.ok ? 'muted' : 'muted warn'));
      if (variantNote(it)) li.appendChild(el('div', variantNote(it), 'muted'));
      li.appendChild(el('div', it.url, 'url'));
      var b = el('button', 'Open this page');
      b.addEventListener('click', function () { addPick(it.url, it.doc_type); chrome.tabs.create({ url: it.url }); });
      li.appendChild(b);
      list.appendChild(li);
    });
    $('docs-count').textContent = 'Documents read (' + items.filter(function (x) { return x.ok; }).length + ' of ' + items.length + ')';
    box.hidden = items.length === 0;
  }

  // List mode: the distinct documents (regional / language copies collapsed), 3 shown, the rest behind a toggle.
  function showCandidates(links, ctx) {
    var list = $('candidate-list'); clear(list);
    var docs = TCLinkGroup.dedupe(links, { lang: userLang() }).docs;
    docs.forEach(function (l, idx) {
      var li = el('li');
      li.hidden = idx >= SHOW_LINKS;
      li.className = idx >= SHOW_LINKS ? 'extra' : '';
      li.appendChild(el('span', l.label, 'badge'));
      li.appendChild(el('strong', (l.text || '(no link text)') + (l.language && l.language !== 'en' ? ' [' + l.language + ']' : '')));
      if (variantNote(l)) li.appendChild(el('div', variantNote(l), 'muted'));
      if (l.is_pdf) li.appendChild(el('div', 'PDF: I cannot read PDFs yet (needs the pdftotext helper, pending approval). You can still open it.', 'muted'));
      li.appendChild(el('div', l.url, 'url'));
      if (!l.is_pdf) {
        var ex = el('button', 'Explain this');
        ex.addEventListener('click', function () { explainLinks([l], { host: ctx.host, via: 'links', gesture: true }); });
        li.appendChild(ex);
        li.appendChild(document.createTextNode(' '));
      }
      var b = el('button', 'Open this page');
      b.addEventListener('click', function () { addPick(l.url, l.doc_type); chrome.tabs.create({ url: l.url }); });
      li.appendChild(b);
      list.appendChild(li);
    });
    var more = $('candidate-more');
    more.hidden = docs.length <= SHOW_LINKS;
    more.textContent = 'Show ' + (docs.length - SHOW_LINKS) + ' more';
    more.onclick = function () {
      var open = more.getAttribute('data-open') !== '1';
      more.setAttribute('data-open', open ? '1' : '0');
      Array.prototype.forEach.call(list.querySelectorAll('li.extra'), function (n) { n.hidden = !open; });
      more.textContent = open ? 'Show fewer' : 'Show ' + (docs.length - SHOW_LINKS) + ' more';
    };
    var all = $('candidate-all');
    var readable = docs.filter(function (d) { return !d.is_pdf; });
    all.hidden = readable.length < 2;
    all.onclick = function () { explainLinks(readable, { host: ctx.host, via: 'links', gesture: true }); };
    $('candidates').hidden = docs.length === 0;
    $('paste').hidden = docs.length !== 0;
  }

  /* ---------- reading the linked documents (after the click; needs the site's one-time OK) ---------- */
  function hasAccess(origins) { return chrome.permissions.contains({ origins: origins }).then(function (ok) { return !!ok; }, function () { return false; }); }
  // chrome.permissions.request only works from a user gesture; without one it fails and we show the button instead.
  function requestAccess(origins) { return chrome.permissions.request({ origins: origins }).then(function (ok) { return !!ok; }, function () { return false; }); }
  function fetchDeps() {
    return { fetch: window.fetch.bind(window), parseHtml: TCDomParse.parseHtml, guard: TCNetGuard, detect: TCDetect, extract: TCExtract, untrusted: TCUntrusted };
  }
  function siteNames(origins) { return origins.map(function (o) { return o.replace(/^https:\/\//, '').replace(/\/\*$/, ''); }).join(', '); }

  function showPermission(prep, links, ctx) {
    pending = { links: links, ctx: ctx };
    var labels = prep.accepted.map(function (d) { return d.label; });
    $('perm-text').textContent = 'To explain ' + labels.join(', ') + ' I need to read ' + (prep.accepted.length === 1 ? 'that document' : 'those ' + prep.accepted.length + ' documents') +
      ' from ' + siteNames(prep.origins) + '. Your browser will ask you once to allow access to ' + (prep.origins.length === 1 ? 'that site' : 'those sites') + '. I read them logged out (no cookies) and do not click anything on your page.';
    $('perm-go').textContent = 'Read ' + (prep.accepted.length === 1 ? 'this document' : 'these ' + prep.accepted.length + ' documents');
    $('permission').hidden = false;
  }

  async function explainLinks(links, ctx) {
    $('permission').hidden = true; $('result').hidden = true; $('docs-read').hidden = true;
    var docs = TCLinkGroup.dedupe(links, { lang: userLang() }).docs;
    var prep = TCDocFetch.prepare(docs.map(function (d) { return { url: d.url, label: d.label, doc_type: d.doc_type, is_pdf: d.is_pdf, variants: d.variants }; }), { guard: TCNetGuard, detect: TCDetect });
    if (!prep.accepted.length) {
      setStatus('I found links to legal pages, but none of them can be read here (' + prep.rejected.map(function (r) { return r.label + ': ' + r.reason; }).join('; ') + '). They are listed below.', true);
      showCandidates(links, ctx);
      return { kind: 'links' };
    }
    if (ctx.gesture) setStatus('Waiting for your browser to ask you about access to ' + siteNames(prep.origins) + '...');
    var granted = ctx.gesture ? await requestAccess(prep.origins) : (await hasAccess(prep.origins)) || (await requestAccess(prep.origins));
    if (!granted) {
      if (ctx.gesture) setStatus('Access to ' + siteNames(prep.origins) + ' was not allowed, so nothing was read.', true);
      else setStatus(ctx.intro);
      showPermission(prep, links, ctx);
      showCandidates(links, ctx);
      return { kind: 'permission', docs: prep.accepted.map(function (d) { return d.label; }), origins: prep.origins };
    }
    pending = null;
    var results = await TCDocFetch.fetchAll(prep.accepted, fetchDeps(), function (i, n, d) { setStatus('Reading ' + (i + 1) + ' of ' + n + ': ' + d.label + '...'); });
    var read = results.filter(function (r) { return r.ok; });
    var unread = results.filter(function (r) { return !r.ok; }).concat(prep.rejected.map(function (r) { return Object.assign({ ok: false }, r); }));
    renderDocuments(results.concat(prep.rejected.map(function (r) { return Object.assign({ ok: false }, r); })));
    if (!read.length) {
      setStatus('I could not read any of the ' + (results.length + prep.rejected.length) + ' documents (see below). Open them from the list.', true);
      showCandidates(links, ctx);
      return { kind: 'unreadable', unread: unread.map(function (u) { return u.label + ': ' + u.reason; }) };
    }
    var analysis = TCAnalyze.analyzeDocuments(read.map(function (r) { return { text: r.text, doc_type: r.doc_type, label: r.label, url: r.url }; }),
      { host: ctx.host, via: ctx.via, unread: unread.map(function (u) { return { label: u.label, reason: u.reason }; }) });
    renderAnalysis(analysis);
    var msg = 'Done. Read ' + read.length + (read.length === 1 ? ' document' : ' documents') + '. Nothing was saved.';
    if (saveEnabled()) {
      try {
        for (var k = 0; k < read.length; k++) {
          await maybeSave({ url: read[k].url, title: read[k].title, doc_type: read[k].doc_type, discovered_via: 'consent_link', text: read[k].text, sections: [], lang: read[k].lang });
        }
        msg = 'Done. Read ' + read.length + ' documents. Copies were saved on this device because you turned that option on.';
      } catch (e) { msg = 'Done, but a copy could not be saved: ' + e.message; }
    }
    setStatus(msg);
    return { kind: 'documents', analysis: analysis, read: read.length, unread: unread.length };
  }

  /* Turn the injected script's result into what the window shows. Exposed (TCExplainUI.show) so the headless e2e can check the rendering. */
  async function show(res) {
    ['result', 'candidates', 'paste', 'permission', 'docs-read'].forEach(function (id) { $(id).hidden = true; });
    var page = res.page || {};
    var host = hostOf(page.url || (res.extracted && res.extracted.url) || '');
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
    // An "I agree" dialog, consent banner or checkbox on this page: explain the documents it links to (never click it).
    var cons = res.consent || { found: false, links: [], buttons: [] };
    if (cons.found && cons.links.length && !page.is_hub) {
      var via = cons.kind === 'banner' ? 'banner' : cons.kind === 'inline' ? 'inline' : 'dialog';
      var what = via === 'banner' ? 'the consent banner' : via === 'inline' ? 'the agree prompt' : 'the agree dialog';
      var intro = 'I found ' + what + (cons.buttons.length ? ' (button: "' + cons.buttons[0] + '")' : '') + ' on this page. I will not click it. Allow access below and I will read the ' + cons.links.length + ' document link(s) it mentions.';
      return explainLinks(cons.links, { host: host, via: via, gesture: false, intro: intro });
    }
    if (page.sensitive) {
      setStatus('This looks like an account, checkout or payment page, so I did not read it. ' + (res.links.length ? 'Legal links found here are listed below.' : 'Open the site\'s terms page and try there.'));
      showCandidates(res.links, { host: host });
      return { kind: 'sensitive' };
    }
    var n = TCLinkGroup.dedupe(res.links, { lang: userLang() }).docs.length;
    setStatus(page.is_hub ? 'This is a legal hub. Pick a document below to explain it.'
      : n ? 'This page is not a terms page, but I found ' + n + ' legal document' + (n === 1 ? '' : 's') + ' linked from it. Pick one below.'
      : 'I did not find terms or privacy links on this page.');
    showCandidates(res.links, { host: host });
    return { kind: 'links' };
  }

  async function run() {
    var tabId = parseInt(new URLSearchParams(location.search).get('tab') || '', 10);
    if (!isFinite(tabId)) { setStatus('Open a web page with terms on it, then click the Term Sherpa icon in the toolbar.'); return; }
    try {
      var tab = await chrome.tabs.get(tabId);
      if (!/^https?:/i.test(tab.url || '')) throw new Error('I can only read normal web pages (http/https), not this kind of page.');
      var res = await runOnPage(tab, { pickedType: findPick(tab.url) });
      await show(res);
    } catch (e) {
      setStatus(e.message + ' If the page was changed or closed, click the Term Sherpa icon again.', true);
    }
  }

  $('perm-go').addEventListener('click', function () { if (pending) explainLinks(pending.links, Object.assign({}, pending.ctx, { gesture: true })); });

  $('revoke').addEventListener('click', async function () {
    try {
      var all = await chrome.permissions.getAll();
      var origins = (all.origins || []).slice();
      if (!origins.length) return setStatus('No extra site access is allowed right now.');
      await chrome.permissions.remove({ origins: origins });
      setStatus('Removed access to ' + origins.length + ' site' + (origins.length === 1 ? '' : 's') + '. I will ask again next time.');
    } catch (e) { setStatus('Could not remove site access: ' + e.message, true); }
  });

  $('paste-open').addEventListener('click', function () {
    var raw = $('paste-url').value.trim(), u;
    try { u = new URL(raw); } catch (e) { return setStatus('That does not look like a web address.', true); }
    var problem = TCNetGuard.urlProblem(u.href);
    if (problem) return setStatus('I will not open that address: ' + problem, true);
    addPick(u.href, 'other');
    chrome.tabs.create({ url: u.href });
    setStatus('Opened. Click the Term Sherpa icon on that page.');
  });

  var box = $('save-copies');
  box.checked = saveEnabled();
  box.addEventListener('change', function () { setSaveEnabled(box.checked); setStatus(box.checked ? 'Saving copies is ON for the next page you explain.' : 'Saving copies is OFF. Nothing about the terms is stored.'); });

  globalThis.TCExplainUI = { show: show, renderAnalysis: renderAnalysis };
  run();
})();
