/*
 * docfetch.js - reads the legal documents an agree dialog links to, on the user's click, and nothing else.
 *
 * This is the ONLY extension code that fetches anything. It is used from the Explain page after the user clicked the
 * toolbar button (and, if needed, approved the browser's one-time "allow access to <site>" prompt for just that site).
 * Rules, all enforced here and covered by tests/docfetch.test.js:
 *   - https only; the static SSRF guard (core/netguard.js) must pass: no localhost, private/link-local addresses, no
 *     embedded credentials, no file:/data:/javascript:; account/checkout-looking URLs are never fetched
 *   - at most MAX_DOCS documents per click, one request per distinct URL, sequentially, no crawling (links inside a
 *     fetched document are never followed)
 *   - credentials:'omit' (logged out, no cookies), no Referer, no custom User-Agent (the browser's honest default),
 *     no cache, GET only
 *   - a time limit and a size limit per document; only html / xhtml / plain text responses are read
 *   - NO redirect is followed (redirect:'manual'): a page that redirects is reported as "not read" and the window shows its link.
 *     Why: the only way to vet a redirect target BEFORE the request goes out would be a declarativeNetRequest block rule, and
 *     (verified in headless Chrome, see tests/e2e/dnr-probe.mjs) that needs the "Block content on any page" install warning;
 *     the warning-free variant (declarativeNetRequestWithHostAccess) does not cover sites we have no access to, which is exactly
 *     the case that matters. Not following redirects means nothing is ever requested from an address we have not vetted.
 *   - Firefox only: deps.dnsCheck (core/dnsguard.js, browser.dns.resolve) refuses a name that resolves to a private/loopback/link-local/reserved
 *     address before any request; Chrome has no such API and keeps the static checks only
 *   - IP-literal hosts (https://203.0.113.9/...) are refused as well as private ranges: legal documents live on named sites
 *   - before each document, https://<site>/robots.txt is read the same guarded way (core/robots.js); a disallow skips the document
 *   - the response is parsed with an injected parser that builds an inert tree (the page's scripts, images and styles
 *     are never run or loaded); all resulting text is treated as untrusted
 * Nothing here stores anything. Dependencies (fetch, parser, guards) are injected so Node tests can drive it.
 */
(function (root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./robots') : root.TCRobots);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCDocFetch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Robots) {
  'use strict';

  var MAX_DOCS = 6;
  var TIMEOUT_MS = 12000;
  var MAX_BYTES = 2 * 1024 * 1024;
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

  function readBody(res, deps, signal, limit) {
    var declared = parseInt(res.headers && res.headers.get && res.headers.get('content-length') || '', 10);
    if (declared > limit) return Promise.reject(new Error('too_large'));
    if (!res.body || typeof res.body.getReader !== 'function') {
      return res.arrayBuffer().then(function (b) { if (b.byteLength > limit) throw new Error('too_large'); return new Uint8Array(b); });
    }
    var reader = res.body.getReader(), chunks = [], total = 0;
    function pump() {
      if (signal && signal.aborted) { try { reader.cancel(); } catch (e) { /* ignore */ } return Promise.reject(new Error('timeout')); }
      return reader.read().then(function (r) {
        if (r.done) return null;
        total += r.value.byteLength;
        if (total > limit) { try { reader.cancel(); } catch (e) { /* ignore */ } throw new Error('too_large'); }
        chunks.push(r.value);
        return pump();
      });
    }
    return pump().then(function () {
      var out = new Uint8Array(total), o = 0;
      chunks.forEach(function (c) { out.set(c, o); o += c.byteLength; });
      return out;
    });
  }

  function decode(bytes, contentType) {
    var m = /charset=([\w\-]+)/i.exec(contentType || '');
    var cs = m ? m[1] : 'utf-8';
    try { return new TextDecoder(cs).decode(bytes); } catch (e) { return new TextDecoder('utf-8').decode(bytes); }
  }

  /*
   * fetchDoc(doc, deps) -> Promise<{label, doc_type, url, ok, text?, title?, lang?, reason?, sections?}>
   * Never rejects. deps: { fetch, parseHtml, guard, detect, extract, untrusted, timeoutMs?, maxBytes?, AbortController?,
   *   dnsCheck? (Firefox only, see above), robotsCheck? (a checker shared by one analysis; fetchAll makes it), robots? (false = skip the robots.txt check; tests only) }
   */
  function isRedirect(res) {
    return res.type === 'opaqueredirect' || res.redirected === true || (res.status >= 300 && res.status < 400);
  }

  /*
   * A redirect is never followed. It is reported plainly, with the place it leads to when the browser lets us know it (usually
   * it does not: a manual redirect is "opaque" so the target stays unknown), and only if that place passes the same URL guard.
   * { redirect: true, target?: href } -> the window says "This link sends you to another page. Open it and run Term Sherpa there."
   */
  function redirectTarget(res, finalUrl, doc, deps) {
    var cand = '';
    try { cand = (res.headers && res.headers.get && res.headers.get('location')) || ''; } catch (e) { cand = ''; }
    if (!cand && finalUrl && finalUrl !== doc.url) cand = finalUrl;
    if (!cand) return '';
    try {
      var u = new URL(cand, doc.url);
      if (u.protocol !== 'https:' || deps.guard.urlProblem(u) || deps.guard.isIpLiteral(u.hostname)) return '';
      return u.href;
    } catch (e) { return ''; }
  }
  function redirectFail(res, finalUrl, doc, fail, deps) {
    var target = redirectTarget(res, finalUrl, doc, deps);
    var out = Object.assign(fail('this link sends you to another page'), { redirect: true });
    if (target) out.target = target;
    return out;
  }

  function fetchDoc(doc, deps) {
    var AC = deps.AbortController || globalThis.AbortController;
    var ctl = new AC(), timedOut = false, timer = null;
    var limit = deps.maxBytes || MAX_BYTES;
    var robotsCheck = deps.robots === false ? null : (deps.robotsCheck || Robots.createChecker(deps));
    var base = { label: doc.label, doc_type: doc.doc_type, url: doc.url, variants: doc.variants };
    function fail(reason) { return Object.assign({ ok: false, reason: reason }, base); }

    return Promise.resolve().then(function () {
      // Firefox only (deps.dnsCheck exists only there): a name that resolves to a private/internal address is never requested, not even robots.txt
      return deps.dnsCheck ? deps.dnsCheck(new URL(doc.url).hostname) : null;
    }).then(function (dnsProblem) {
      if (dnsProblem) return { skipped: fail('not opened: ' + dnsProblem) };
      return robotsCheck ? robotsCheck(doc.url) : { allowed: true };
    }).then(function (rb) {
      if (rb.skipped) return rb;
      if (!rb.allowed) return { skipped: fail(rb.reason) };
      timer = setTimeout(function () { timedOut = true; ctl.abort(); }, deps.timeoutMs || TIMEOUT_MS); // starts after the robots.txt check
      return deps.fetch(doc.url, {
        method: 'GET', credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer', cache: 'no-store',
        signal: ctl.signal, headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' }
      });
    }).then(function (res) {
      if (res.skipped) return res.skipped;
      var finalUrl = res.url || doc.url;
      var bad = deps.guard.urlProblem(finalUrl);
      if (bad) return Object.assign(fail('this link sends you to an address that is not allowed'), { redirect: true });
      if (!/^https:/i.test(finalUrl)) return Object.assign(fail('this link sends you to a page that is not https'), { redirect: true });
      if (isRedirect(res) || finalUrl !== doc.url) return redirectFail(res, finalUrl, doc, fail, deps);
      if (!res.ok) return fail('the site answered with an error (' + res.status + ')');
      var ct = (res.headers && res.headers.get && res.headers.get('content-type') || '').toLowerCase();
      var kind = /^(text\/html|application\/xhtml\+xml)/.test(ct) ? 'html' : /^text\/plain/.test(ct) ? 'text' : '';
      if (!kind) return fail(/pdf/.test(ct) ? 'a PDF (open the link)' : 'not a web page (' + (ct.split(';')[0] || 'unknown type') + ')');
      return readBody(res, deps, ctl.signal, limit).then(function (bytes) {
        var body = decode(bytes, ct), text, title = '', lang = '';
        if (kind === 'text') text = body;
        else {
          var tree = deps.parseHtml(body);
          var ex = deps.extract.extractMainText(tree);
          var links = deps.detect.findLegalLinks(deps.extract.collectLinks(tree), finalUrl);
          var cls = deps.detect.classifyPage({ url: finalUrl, title: ex.title, h1: ex.h1, textLength: ex.text.length, links: links });
          if (cls.isHub) return fail('a list of links to other documents, not a document itself');
          text = ex.text; title = ex.title; lang = ex.lang || '';
        }
        text = deps.untrusted.sanitizeText(text);
        if (text.length < MIN_TEXT) return Object.assign(fail('needs JavaScript to show its text, so it cannot be read from here'), { needs_js: true });
        return Object.assign({ ok: true, text: text, title: deps.untrusted.sanitizeText(title || ''), lang: lang }, base);
      });
    }).catch(function (e) {
      var m = String(e && e.message || e);
      if (timedOut || m === 'timeout' || (e && e.name === 'AbortError')) return fail('the site took too long to answer');
      if (m === 'too_large') return fail('too large to read here');
      return fail('could not be reached (blocked, offline, or access not allowed)');
    }).then(function (r) { if (timer) clearTimeout(timer); return r; });
  }

  // Sequential, so a click makes at most MAX_DOCS requests, one at a time.
  // One robots.txt checker per call = robots.txt is cached per site for this analysis only and dropped afterwards.
  function fetchAll(docs, deps, onProgress) {
    var out = [];
    if (deps.robots !== false && !deps.robotsCheck) deps = Object.assign({}, deps, { robotsCheck: Robots.createChecker(deps) });
    return docs.reduce(function (p, d, i) {
      return p.then(function () {
        if (onProgress) onProgress(i, docs.length, d);
        return fetchDoc(d, deps).then(function (r) { out.push(r); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  return { prepare: prepare, originsFor: originsFor, fetchDoc: fetchDoc, fetchAll: fetchAll, MAX_DOCS: MAX_DOCS, TIMEOUT_MS: TIMEOUT_MS, MAX_BYTES: MAX_BYTES, MIN_TEXT: MIN_TEXT };
});
