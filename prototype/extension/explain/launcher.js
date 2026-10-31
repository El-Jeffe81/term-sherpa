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

  // A small separate window where the browser has one; otherwise (Firefox for Android has no windows.create) a normal tab.
  async function openExplain() {
    var url = chrome.runtime.getURL('explain/explain.html') + '?tab=' + encodeURIComponent(String(tabId));
    if (chrome.windows && typeof chrome.windows.create === 'function') {
      try { return await chrome.windows.create({ url: url, type: 'popup', width: 620, height: 820 }); } catch (e) { /* fall through to a tab */ }
    }
    return chrome.tabs.create({ url: url });
  }

  async function start() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs && tabs[0];
    if (!tab || tab.id === undefined) { status.textContent = 'No active tab found.'; return; }
    if (!/^https?:/i.test(tab.url || '')) { status.textContent = 'I can only read normal web pages (http/https), not this kind of page.'; return; }
    tabId = tab.id;
    await openExplain();
    status.textContent = 'The explanation window is open.';
    again.hidden = false;
  }

  again.addEventListener('click', function () { openExplain().catch(function (e) { status.textContent = e.message; }); });
  start().catch(function (e) { status.textContent = e.message; });
})();
