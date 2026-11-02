/*
 * docfetch.js - reads the legal documents an agree dialog links to, on the user's click, and nothing else.
 *
 * This is the ONLY extension code that fetches anything. It is used from the Explain page after the user clicked the
 * toolbar button (and, if needed, approved the browser's one-time "allow access to <site>" prompt for just that site, or the
 * optional "all sites" access that lets a policy link leave the site, see below).
 * Rules, all enforced here and covered by tests/docfetch.test.js:
 *   - https only; the static SSRF guard (core/netguard.js) must pass: no localhost, private/link-local addresses, no
 *     embedded credentials, no file:/data:/javascript:; account/checkout-looking URLs are never fetched
 *   - at most MAX_DOCS documents per click, one request per distinct URL, sequentially, no crawling (links inside a
 *     fetched document are never followed)
 *   - GET only, credentials:'omit' (logged out, no cookies), no Referer, no custom User-Agent (the browser's honest default), no cache
 *   - a time limit per document; only html / xhtml / plain text responses are read
 *   - size: the first MAX_BYTES (8 MB) of a page are read as it streams. A page that is bigger is NOT refused: reading stops at the cap, the
 *     rest of the stream is cancelled, what was read is used and the result is marked truncated:true (the window says "Only part of this
 *     document was read."). A declared content-length above the cap does not matter either.
 *   - REDIRECTS ARE FOLLOWED (redirect:'follow') and the page that finally answers is checked BEFORE its body is read: the final URL
 *     (res.url) must be https and pass the same netguard checks (private/loopback/link-local, credentials, IP literals), and on Firefox
 *     deps.dnsCheck must pass for the final host. Otherwise the response is cancelled and discarded and nothing from it is used.
 *     The result records final_url and, when the final host differs from the link's host, read_from (the real hostname, shown as
 *     "Read from <host>"). Honest limit: a redirect is followed by the browser, so the browser has already made the GET to the redirect
 *     target when we check it; the check decides whether the answer is used (it never is if the target is private, not https, or
 *     named by IP). We still never send cookies or a Referer, and the answer is never run, only parsed inertly.
 *   - Two access modes, decided by the caller (deps.allSites):
 *       all sites allowed (the optional "all https sites" permission, asked for on a click in the window, never installed up front):
 *         any https policy host is readable, wherever the link leads.
 *       only the sites the person allowed one by one: a redirect that stays on hosts we already have access to works; one that
 *         leaves them makes the browser refuse to show us the answer (fetch throws). We then re-ask the SAME url once with
 *         redirect:'manual' only to tell "redirected away" from "offline": that result is { ok:false, redirect:true, needs_all_sites:true }
 *         and the window offers the all-sites opt-in or a "Read it" button that opens the link in a normal tab.
 *   - Firefox only: deps.dnsCheck (core/dnsguard.js, browser.dns.resolve) refuses a name that resolves to a private/loopback/link-local/reserved
 *     address before the first request, and again for the final host of a redirect; Chrome has no such API and keeps the static checks only
 *   - IP-literal hosts (https://203.0.113.9/...) are refused as well as private ranges: legal documents live on named sites
 *   - robots.txt is NOT consulted (v1.1): every fetch here is one page the person asked for with a click, and robots.txt is for crawlers.
 *     Everything else above still applies: no cookies, one page at a time, the per-click limit, the address checks.
 *   - the response is parsed with an injected parser that builds an inert tree (the page's scripts, images and styles
 *     are never run or loaded); all resulting text is treated as untrusted
 * Nothing here stores anything and it uses no browser API of its own (no chrome.*): the permission and "not now" logic live in the window.
 * Dependencies (fetch, parser, guards) are injected so Node tests can drive it.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCDocFetch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_DOCS = 6;
  var TIMEOUT_MS = 12000;
  var MAX_BYTES = 8 * 1024 * 1024;
  var MIN_TEXT = 200; // fewer characters than this after extraction = the page builds its text with JavaScript

  function stripHash(u) { var i = u.indexOf('#'); return i < 0 ? u : u.slice(0, i); }

  /*
   * prepare(docs, deps) -> { accepted, rejected, origins }
   * docs: [{url, label, doc_type, is_pdf?}] (already de-duplicated by document). deps: { guard, detect }
   */
  function prepare(docs, deps) {
    var accepted = [], rejected = [], seen = {};
    (docs || []).forEach(function (d) {
      var url = stripHash(String(d.url || ''));
      var reason = null, u = null;
      try { u = new URL(url); } catch (e) { reason = 'not a valid link'; }
      if (!reason) reason = deps.guard.urlProblem(u) ? 'link not allowed (' + deps.guard.urlProblem(u) + ')' : null;
      if (!reason && u.protocol !== 'https:') reason = 'not an https link';
      if (!reason && deps.guard.isIpLiteral(u.hostname)) reason = 'link not allowed (a bare IP address, not a named site)';
      if (!reason && deps.detect.isSensitivePage(u.href)) reason = 'looks like an account or payment page';
      if (!reason && (d.is_pdf || /\.pdf$/i.test(u.pathname))) reason = 'a PDF (open the link)';
      var key = u ? u.href : url;
      if (!reason && seen[key]) return;
      if (u) seen[key] = true;
      if (reason) { rejected.push({ label: d.label, url: url, doc_type: d.doc_type, reason: reason }); return; }
      if (accepted.length >= MAX_DOCS) { rejected.push({ label: d.label, url: u.href, doc_type: d.doc_type, reason: 'only the first ' + MAX_DOCS + ' documents are read' }); return; }
      accepted.push({ url: u.href, label: d.label, doc_type: d.doc_type, variants: d.variants });
    });
    return { accepted: accepted, rejected: rejected, origins: originsFor(accepted) };
  }

  // Chrome match patterns for the sites that must be allowed (ports are not part of a match pattern).
  function originsFor(docs) {
    var out = [];
    docs.forEach(function (d) {
      var p = 'https://' + new URL(d.url).hostname + '/*';
      if (out.indexOf(p) < 0) out.push(p);
    });
    return out;
  }

  // Reads up to `limit` bytes. Never fails for size: at the cap it cancels the stream and reports truncated:true.
  function readBody(res, deps, signal, limit) {
    if (!res.body || typeof res.body.getReader !== 'function') {
      return res.arrayBuffer().then(function (b) {
        return b.byteLength > limit ? { bytes: new Uint8Array(b, 0, limit), truncated: true } : { bytes: new Uint8Array(b), truncated: false };
      });
    }
    var reader = res.body.getReader(), chunks = [], total = 0, truncated = false;
    function pump() {
      if (signal && signal.aborted) { try { reader.cancel(); } catch (e) { /* ignore */ } return Promise.reject(new Error('timeout')); }
      return reader.read().then(function (r) {
        if (r.done) return null;
        var v = r.value;
        if (total + v.byteLength >= limit) {
          // the cap is reached (or exactly filled): keep what fits, stop reading and cancel the rest of the stream
          var room = limit - total;
          if (v.byteLength > room) { v = v.subarray(0, room); truncated = true; }
          if (v.byteLength) { chunks.push(v); total += v.byteLength; }
          if (!truncated) {
            // exactly at the cap: it is only "truncated" if the stream still has data
            return reader.read().then(function (n) {
              if (!n.done) { truncated = true; try { reader.cancel(); } catch (e) { /* ignore */ } }
              return null;
            });
          }
          try { reader.cancel(); } catch (e) { /* ignore */ }
          return null;
        }
        total += v.byteLength;
        chunks.push(v);
        return pump();
      });
    }
    return pump().then(function () {
      var out = new Uint8Array(total), o = 0;
      chunks.forEach(function (c) { out.set(c, o); o += c.byteLength; });
      return { bytes: out, truncated: truncated };
    });
  }

  function decode(bytes, contentType) {
    var m = /charset=([\w\-]+)/i.exec(contentType || '');
    var cs = m ? m[1] : 'utf-8';
    try { return new TextDecoder(cs).decode(bytes); } catch (e) { return new TextDecoder('utf-8').decode(bytes); }
  }

  function isRedirectResponse(res) {
    return !!res && (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400));
  }
  // Throw away a response we will not use (and stop its download).
  function discard(res) {
    try { if (res && res.body && typeof res.body.cancel === 'function') { var p = res.body.cancel(); if (p && p.catch) p.catch(function () { /* ignore */ }); } } catch (e) { /* ignore */ }
  }
  function hostOf(u) { try { return new URL(u).hostname.toLowerCase().replace(/\.$/, ''); } catch (e) { return ''; } }

  /*
   * fetchDoc(doc, deps) -> Promise<{label, doc_type, url, ok, text?, title?, lang?, final_url?, read_from?, truncated?,
   *                                 reason?, redirect?, needs_all_sites?, needs_js?, unsafe?, variants?}>
   * Never rejects. deps: { fetch, parseHtml, guard, detect, extract, untrusted, allSites?, timeoutMs?, maxBytes?, AbortController?,
   *   dnsCheck? (Firefox only, see above) }
   */
  function fetchDoc(doc, deps) {
    var AC = deps.AbortController || globalThis.AbortController;
    var ctl = new AC(), timedOut = false, timer = null;
    var limit = deps.maxBytes || MAX_BYTES;
    var linkHost = hostOf(doc.url);
    var base = { label: doc.label, doc_type: doc.doc_type, url: doc.url, variants: doc.variants };
    function fail(reason) { return Object.assign({ ok: false, reason: reason }, base); }
    function request(redirect) {
      return deps.fetch(doc.url, {
        method: 'GET', credentials: 'omit', redirect: redirect, referrerPolicy: 'no-referrer', cache: 'no-store',
        signal: ctl.signal, headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' }
      });
    }

    return Promise.resolve().then(function () {
      // Firefox only (deps.dnsCheck exists only there): a name that resolves to a private/internal address is never requested
      return deps.dnsCheck ? deps.dnsCheck(linkHost) : null;
    }).then(function (dnsProblem) {
      if (dnsProblem) return { skipped: fail('not opened: ' + dnsProblem) };
      timer = setTimeout(function () { timedOut = true; ctl.abort(); }, deps.timeoutMs || TIMEOUT_MS);
      return request('follow').catch(function (err) {
        // With only per-site access the browser refuses to show a redirect that leaves the allowed sites (fetch throws).
        // Ask the same url once more, without following, to tell "redirected away" from "offline / blocked".
        var aborted = timedOut || (err && err.name === 'AbortError');
        if (aborted || deps.allSites === true) throw err;
        return request('manual').then(function (probe) {
          var redirected = isRedirectResponse(probe);
          discard(probe);
          if (!redirected) throw err;
          return { crossSite: true };
        }, function () { throw err; });
      });
    }).then(function (res) {
      if (res.skipped) return res.skipped;
      if (res.crossSite) {
        return Object.assign(fail('its link goes to another site, which Term Sherpa does not follow yet'), { redirect: true, needs_all_sites: true });
      }
      // The answer comes from res.url (after any redirects). Vet it BEFORE reading a byte of the body.
      var finalUrl = res.url || doc.url, fu = null;
      try { fu = new URL(finalUrl); } catch (e) { fu = null; }
      var bad = fu ? deps.guard.urlProblem(fu) : 'not a valid address';
      if (!bad && fu.protocol !== 'https:') bad = 'not https';
      if (!bad && deps.guard.isIpLiteral(fu.hostname)) bad = 'a bare IP address';
      if (bad) { discard(res); return Object.assign(fail('its link goes to an address that is not allowed'), { redirect: true, unsafe: true }); }
      var finalHost = fu.hostname.toLowerCase().replace(/\.$/, '');
      var moved = finalHost !== linkHost;
      var after = moved && deps.dnsCheck ? deps.dnsCheck(finalHost) : null; // Firefox only
      return Promise.resolve(after).then(function (finalDns) {
        if (finalDns) { discard(res); return Object.assign(fail('its link goes to a site that was not opened: ' + finalDns), { redirect: true, unsafe: true }); }
        var meta = { final_url: fu.href };
        if (moved) meta.read_from = finalHost;
        if (!res.ok) { discard(res); return fail('the site answered with an error (' + res.status + ')'); }
        var ct = (res.headers && res.headers.get && res.headers.get('content-type') || '').toLowerCase();
        var kind = /^(text\/html|application\/xhtml\+xml)/.test(ct) ? 'html' : /^text\/plain/.test(ct) ? 'text' : '';
        if (!kind) { discard(res); return fail(/pdf/.test(ct) ? 'a PDF (open the link)' : 'not a web page (' + (ct.split(';')[0] || 'unknown type') + ')'); }
        return readBody(res, deps, ctl.signal, limit).then(function (got) {
          var body = decode(got.bytes, ct), text, title = '', lang = '';
          if (kind === 'text') text = body;
          else {
            var tree = deps.parseHtml(body);
            var ex = deps.extract.extractMainText(tree);
            var links = deps.detect.findLegalLinks(deps.extract.collectLinks(tree), fu.href);
            var cls = deps.detect.classifyPage({ url: fu.href, title: ex.title, h1: ex.h1, textLength: ex.text.length, links: links });
            if (cls.isHub) return fail('a list of links to other documents, not a document itself');
            text = ex.text; title = ex.title; lang = ex.lang || '';
          }
          text = deps.untrusted.sanitizeText(text);
          if (text.length < MIN_TEXT) return Object.assign(fail('needs JavaScript to show its text, so it cannot be read from here'), { needs_js: true }, meta);
          return Object.assign({ ok: true, text: text, title: deps.untrusted.sanitizeText(title || ''), lang: lang, truncated: got.truncated }, base, meta);
        });
      });
    }).catch(function (e) {
      var m = String(e && e.message || e);
      if (timedOut || m === 'timeout' || (e && e.name === 'AbortError')) return fail('the site took too long to answer');
      return fail('could not be reached (blocked, offline, or access not allowed)');
    }).then(function (r) { if (timer) clearTimeout(timer); return r; });
  }

  // Sequential, so a click makes at most MAX_DOCS requests, one at a time.
  function fetchAll(docs, deps, onProgress) {
    var out = [];
    return docs.reduce(function (p, d, i) {
      return p.then(function () {
        if (onProgress) onProgress(i, docs.length, d);
        return fetchDoc(d, deps).then(function (r) { out.push(r); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  return { prepare: prepare, originsFor: originsFor, fetchDoc: fetchDoc, fetchAll: fetchAll, MAX_DOCS: MAX_DOCS, TIMEOUT_MS: TIMEOUT_MS, MAX_BYTES: MAX_BYTES, MIN_TEXT: MIN_TEXT };
});
