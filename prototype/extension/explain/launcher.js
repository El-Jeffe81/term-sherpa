/*
 * launcher.js - the toolbar popup. Opening it IS the user's click (this is what grants activeTab for this tab).
 * It opens the Explain window and passes only the tab id. It reads nothing from the page and makes no network calls.
 * chrome.windows needs no permission. If a window cannot be created (or the browser has no windows API) it falls back to a normal tab.
 */
(function () {
  'use strict';
  var status = document.getElementById('status');
  var again = document.getElementById('again');
  var tabId = null;
  var onAgain = function () { openExplain().catch(function (e) { status.textContent = e.message; }); };

  // A small separate window where the browser has one; otherwise (Firefox for Android has no windows.create) a normal tab.
  async function openExplain() {
    var url = chrome.runtime.getURL('explain/explain.html') + '?tab=' + encodeURIComponent(String(tabId));
    if (chrome.windows && typeof chrome.windows.create === 'function') {
      try { return await chrome.windows.create({ url: url, type: 'popup', width: 620, height: 820 }); } catch (e) { /* fall through to a tab */ }
    }
    return chrome.tabs.create({ url: url });
  }

  // Is an explanation window for this very page already open? Only this extension's own pages are looked at (their addresses are visible
  // without any extra permission). Anything unexpected counts as "not open", which just opens a window as before.
  async function findOpen() {
    try {
      var base = chrome.runtime.getURL('explain/explain.html');
      var all = await chrome.tabs.query({});
      for (var i = 0; i < (all || []).length; i++) {
        var u = all[i] && all[i].url;
        if (typeof u === 'string' && u.indexOf(base + '?tab=') === 0 && u.slice((base + '?tab=').length).split(/[&#]/)[0] === encodeURIComponent(String(tabId))) return all[i];
      }
    } catch (e) { /* treat as not open */ }
    return null;
  }

  async function bringToFront(t) {
    if (chrome.windows && typeof chrome.windows.update === 'function' && t.windowId !== undefined) {
      try { await chrome.windows.update(t.windowId, { focused: true }); } catch (e) { /* the tab switch below still helps */ }
    }
    await chrome.tabs.update(t.id, { active: true });
  }

  async function start() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs && tabs[0];
    if (!tab || tab.id === undefined) { status.textContent = 'No active tab found.'; return; }
    if (!/^https?:/i.test(tab.url || '')) { status.textContent = 'I can only read normal web pages (http/https), not this kind of page.'; return; }
    tabId = tab.id;
    var existing = await findOpen();
    if (existing) {
      status.textContent = 'Your explanation window is already open';
      again.textContent = 'Bring it to the front';
      again.hidden = false;
      onAgain = function () {
        bringToFront(existing).then(function () { if (typeof window !== 'undefined' && window.close) window.close(); }, function (e) { status.textContent = e.message; });
      };
      return;
    }
    await openExplain();
    status.textContent = 'The explanation window is open.';
    again.hidden = false;
  }

  again.addEventListener('click', function () { onAgain(); });
  start().catch(function (e) { status.textContent = e.message; });
})();
