/*
 * popup.js - runs only inside the extension popup. No network calls.
 * The page is touched ONLY inside the click handler of "Please help me", via chrome.scripting.executeScript
 * (activeTab). The page's text is kept only when the page itself is a terms document (or a link the user picked);
 * otherwise only the detected legal links are kept, never other page content.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var TYPE_LABEL = { tos: 'Terms', privacy: 'Privacy', eula: 'EULA', cookies: 'Cookies', other: 'Other' };
  // Leading slash = relative to the extension root in every browser. Without it Firefox resolves the path against the calling page (explain/ or popup/) and the injection fails.
  var INJECT_FILES = ['/core/untrusted.js', '/core/extract.js', '/core/detect.js', '/core/consent.js', '/content/run.js'];

  function setStatus(msg, isErr) {
    var s = $('status'); s.textContent = msg; s.className = isErr ? 'err' : '';
  }
  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }
  function shortPreview(text) { // keep quotes short: first ~160 chars only
    var t = text.replace(/\s+/g, ' ').trim();
    return t.length > 160 ? t.slice(0, 157) + '...' : t;
  }

  async function activeTab() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }

  // Inject the detector into the current tab (user just clicked) and read its result.
  async function runOnPage(options) {
    var tab = await activeTab();
    if (!tab || !tab.id) throw new Error('No active tab.');
    if (!/^https?:/i.test(tab.url || '')) throw new Error('I can only read normal web pages (http/https), not this kind of page.');
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

  function langLabel(l) { return l.language && l.language !== 'en' ? ' [' + l.language + ']' : ''; }

  function showCandidates(links, hubNote) {
    var list = $('candidate-list'); list.textContent = '';
    links.forEach(function (l) {
      var li = el('li');
      li.appendChild(el('span', TYPE_LABEL[l.doc_type] || l.doc_type, 'badge'));
      li.appendChild(el('strong', (l.text || '(no link text)') + langLabel(l)));
      li.appendChild(el('span', ' (' + l.confidence + ' confidence)', 'muted'));
      if (l.is_pdf) li.appendChild(el('div', 'PDF: I cannot read PDFs yet (needs the pdftotext helper, pending approval). You can still open it.', 'muted'));
      li.appendChild(el('div', l.url, 'url'));
      var b = el('button', 'Open this page');
      b.addEventListener('click', async function () {
        try { await TCDB.pickLink(l); } catch (e) { /* remembering the pick is best-effort */ }
        chrome.tabs.create({ url: l.url });
      });
      li.appendChild(b);
      list.appendChild(li);
    });
    $('candidates').hidden = links.length === 0;
    $('paste').hidden = links.length !== 0;
  }

  async function onHelp() {
    $('candidates').hidden = true; $('paste').hidden = true;
    setStatus('Looking at this page...');
    try {
      var tab = await activeTab();
      var picked = tab && tab.url ? await TCDB.getLink(tab.url) : null;
      var res = await runOnPage({ pickedType: picked && picked.picked ? picked.doc_type : '' });
      var page = res.page || {};
      if (page.is_pdf) {
        // A PDF: nothing is read. Only note that it exists (URL + type) when it looks like a legal document or was picked.
        if (page.pdf_doc_type || (picked && picked.picked)) {
          await TCDB.saveLinks([{ url: page.url, text: '', doc_type: (picked && picked.doc_type) || page.pdf_doc_type || 'other', is_pdf: true }], '');
          setStatus('This is a PDF. I cannot read PDFs yet (it needs the pdftotext helper, pending approval), so I only noted that it exists.');
        } else setStatus('This is a PDF, and I cannot read PDFs yet.');
        return;
      }
      if (res.extracted) {
        if (res.extracted.text.length < 200) throw new Error('This looks like a terms page, but I could only read a little text. Try again once the page has finished loading.');
        var r = await TCDB.saveSnapshot(res.extracted);
        var label = TYPE_LABEL[res.extracted.doc_type] || res.extracted.doc_type;
        var secs = res.extracted.sections ? ' (' + res.extracted.sections.length + ' sections)' : '';
        setStatus(r.status === 'new' ? 'Saved: ' + label + ' (first version)' + secs + '.'
          : r.status === 'changed' ? 'Saved a new version of this ' + label + ' page (+' + r.added + ' / -' + r.removed + ' lines). Version ' + r.version_count + '.'
          : 'No change since last time (' + label + ', version ' + r.version_count + ').');
      } else if (page.sensitive) {
        // Account, checkout, payment...: not read and nothing about it is stored. The links are shown but not kept.
        setStatus('This looks like an account, checkout or payment page, so I did not read or save it. ' + (res.links.length ? 'Legal links found here are listed below (not saved).' : 'Open the site\'s terms page and try there.'));
        showCandidates(res.links);
        return;
      } else {
        if (res.links.length) await TCDB.saveLinks(res.links, hostOf(page.url));
        setStatus(page.is_hub ? 'This is a legal hub. Pick a document below, open it, then click "Please help me" there.'
          : res.links.length ? 'This page is not a terms page, but I found ' + res.links.length + ' link(s). Only the links were kept.'
          : 'I did not find terms or privacy links on this page.');
      }
      if (!res.extracted) showCandidates(res.links);
      await renderDocs();
    } catch (e) { setStatus(e.message, true); }
  }

  function hostOf(u) { try { return new URL(u).host; } catch (e) { return ''; } }

  async function onPasteOpen() {
    var raw = $('paste-url').value.trim();
    var u;
    try { u = new URL(raw); } catch (e) { return setStatus('That does not look like a web address.', true); }
    var problem = TCNetGuard.urlProblem(u.href);
    if (problem) return setStatus('I will not open that address: ' + problem, true);
    // The user typed this URL themselves: remember it as an explicit pick, so "Please help me" on that page may save it.
    try { await TCDB.pickLink({ url: u.href, text: '', doc_type: 'other', language: 'en' }); } catch (e) { /* best effort */ }
    chrome.tabs.create({ url: u.href });
    setStatus('Opened. Click "Please help me" on that page.');
  }

  async function renderDocs() {
    var docs = await TCDB.listDocs();
    var ul = $('docs'); ul.textContent = '';
    $('count').textContent = docs.length ? '(' + docs.length + ')' : '';
    $('empty').hidden = docs.length > 0;
    docs.forEach(function (d) {
      var li = el('li');
      li.appendChild(el('span', TYPE_LABEL[d.doc_type] || d.doc_type, 'badge'));
      li.appendChild(el('strong', d.host));
      li.appendChild(el('div', d.title || d.url, 'muted'));
      li.appendChild(el('div', d.url, 'url'));
      li.appendChild(el('div', 'Saved ' + new Date(d.fetched_at).toLocaleString() + ' | versions: ' + d.version_count + ' | sha256: ' + d.sha256.slice(0, 12) + '...', 'muted'));
      li.appendChild(el('div', shortPreview(d.text), 'muted'));
      var row = el('div', undefined, 'row');
      if (d.version_count > 1) {
        var c = el('button', 'Show last change');
        c.addEventListener('click', async function () {
          var vs = await TCDB.getVersions(d.url);
          var last = vs[vs.length - 1];
          var pre = li.querySelector('pre') || li.appendChild(el('pre'));
          pre.textContent = (last.diff_from_prev || '').split('\n').slice(0, 40).join('\n');
        });
        row.appendChild(c);
      }
      var del = el('button', 'Delete', 'danger');
      del.addEventListener('click', async function () { await TCDB.deleteDoc(d.url); await renderDocs(); });
      row.appendChild(del);
      li.appendChild(row);
      ul.appendChild(li);
    });
  }

  async function onExport() {
    var data = await TCDB.exportAll();
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'term-sherpa-export.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  async function onClear() {
    if (!confirm('Delete everything saved by this extension on this device?')) return;
    await TCDB.clearAll(); await renderDocs(); setStatus('Deleted.');
  }

  $('help').addEventListener('click', onHelp);
  $('paste-open').addEventListener('click', onPasteOpen);
  $('export').addEventListener('click', onExport);
  $('clear').addEventListener('click', onClear);
  // Showing the saved list reads only this extension's own local database; it does not touch any web page.
  renderDocs().catch(function (e) { setStatus(e.message, true); });
})();
