/*
 * robots.js - the robots.txt check the Explain window runs before it reads a linked document.
 *
 * What it does (and covered by tests/robots-check.test.js):
 *   - fetches https://<site>/robots.txt the same guarded way as a document: https only, credentials omitted (no cookies),
 *     no Referer, no cache, GET only, a short time limit (ROBOTS_TIMEOUT_MS) and a size limit (only the first 512 KiB are read),
 *     redirects are NOT followed (redirect:'manual', see docfetch.js for why)
 *   - parses it (RFC 9309 style) and applies the group for user-agent "*". We send the browser's own User-Agent, with no product
 *     token of our own, so no site can address us by name; "*" is the only group that can apply. Longest matching rule wins, Allow
 *     wins a tie, "*" and a trailing "$" work as wildcards.
 *   - if the path is disallowed the document is skipped (the window shows its link and a short reason)
 *   - if robots.txt is missing (4xx), unreadable, a redirect, slow, too odd to parse, or the request fails, the fetch is ALLOWED
 *   - the result is cached per site for ONE analysis only (the cache object belongs to a single fetchAll call) and is never saved
 * Dependencies are injected so Node tests can drive it.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCRobots = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ROBOTS_TIMEOUT_MS = 4000;
  var ROBOTS_MAX_BYTES = 512 * 1024; // RFC 9309: parse at least 500 KiB; the rest is ignored
  var MAX_RULES = 2000;              // per analysis, bounds the work an unfriendly robots.txt can cause
  var AGENT = '*';

  // %XX handling so "/a%7Eb" and "/a~b" compare equal; non-ASCII is compared as UTF-8 percent-escapes.
  function normalize(s) {
    s = String(s).replace(/[^\x00-\x7f]/g, function (c) { try { return encodeURIComponent(c); } catch (e) { return c; } });
    return s.replace(/%([0-9a-fA-F]{2})/g, function (m, h) {
      var ch = String.fromCharCode(parseInt(h, 16));
      return /[A-Za-z0-9\-._~]/.test(ch) ? ch : '%' + h.toUpperCase();
    });
  }

  // parse(text) -> { rules: [{allow, pattern}] } holding only the rules of the group(s) for user-agent "*"
  function parse(text) {
    var s = String(text || '').replace(/^\uFEFF/, '');
    var groups = [], cur = null, lastWasAgent = false;
    s.split(/\r\n|\n|\r/).forEach(function (raw) {
      var line = raw.replace(/#.*$/, '').trim();
      var i = line.indexOf(':');
      if (!line || i < 0) return;
      var key = line.slice(0, i).trim().toLowerCase(), val = line.slice(i + 1).trim();
      if (key === 'user-agent') {
        if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
        cur.agents.push(val.toLowerCase());
        lastWasAgent = true;
        return;
      }
      lastWasAgent = false;
      if (!cur) return;
      if (key === 'allow' || key === 'disallow') cur.rules.push({ allow: key === 'allow', pattern: normalize(val) });
    });
    var rules = [];
    groups.forEach(function (g) { if (g.agents.indexOf(AGENT) >= 0) rules = rules.concat(g.rules); });
    return { rules: rules.slice(0, MAX_RULES) };
  }

  // robots.txt pattern match without regular expressions (a hostile file cannot make this backtrack): "*" = anything, trailing "$" = end.
  function matches(pattern, path) {
    var anchored = false;
    if (pattern.charAt(pattern.length - 1) === '$') { anchored = true; pattern = pattern.slice(0, -1); }
    var parts = pattern.split('*');
    if (parts.length === 1) return anchored ? path === pattern : path.indexOf(pattern) === 0;
    if (path.indexOf(parts[0]) !== 0) return false;
    var pos = parts[0].length, i;
    for (i = 1; i < parts.length - 1; i++) {
      var at = path.indexOf(parts[i], pos);
      if (at < 0) return false;
      pos = at + parts[i].length;
    }
    var last = parts[parts.length - 1];
    if (anchored) return path.length - last.length >= pos && path.slice(path.length - last.length) === last;
    return path.indexOf(last, pos) >= 0;
  }

  // isAllowed(parsed, pathAndQuery) -> boolean. No rule matches = allowed.
  function isAllowed(parsed, pathAndQuery) {
    var path = normalize(pathAndQuery || '/'), best = null;
    parsed.rules.forEach(function (r) {
      if (r.pattern === '') return; // an empty Disallow means "everything allowed"; an empty Allow does nothing
      if (!matches(r.pattern, path)) return;
      if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
    });
    return best ? best.allow : true;
  }

  function robotsUrl(docUrl) { return new URL(docUrl).origin + '/robots.txt'; }

  function readCapped(res, limit) {
    if (!res.body || typeof res.body.getReader !== 'function') return res.arrayBuffer().then(function (b) { return new Uint8Array(b).slice(0, limit); });
    var reader = res.body.getReader(), chunks = [], total = 0;
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return null;
        var v = r.value;
        if (total + v.byteLength > limit) { chunks.push(v.slice(0, limit - total)); total = limit; try { reader.cancel(); } catch (e) { /* ignore */ } return null; }
        chunks.push(v); total += v.byteLength;
        return pump();
      });
    }
    return pump().then(function () {
      var out = new Uint8Array(total), o = 0;
      chunks.forEach(function (c) { out.set(c, o); o += c.byteLength; });
      return out;
    });
  }

  /*
   * fetchRules(origin, deps) -> Promise<{ rules } | null>   null = missing / unreadable / slow / redirected (all mean "allow").
   * Never rejects. deps: { fetch, guard, timeoutMs?, AbortController? }
   */
  function fetchRules(origin, deps) {
    var AC = deps.AbortController || globalThis.AbortController;
    var ctl = new AC();
    var timer = setTimeout(function () { ctl.abort(); }, deps.robotsTimeoutMs || ROBOTS_TIMEOUT_MS);
    var url = origin + '/robots.txt';
    return Promise.resolve().then(function () {
      if (deps.guard && deps.guard.urlProblem(url)) return null;
      if (!/^https:/i.test(url)) return null;
      return deps.fetch(url, {
        method: 'GET', credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer', cache: 'no-store',
        signal: ctl.signal, headers: { Accept: 'text/plain,*/*;q=0.1' }
      }).then(function (res) {
        if (res.type === 'opaqueredirect' || res.redirected || !res.ok || res.status < 200 || res.status > 299) return null;
        if (res.url && res.url !== url) return null;
        return readCapped(res, ROBOTS_MAX_BYTES).then(function (bytes) { return parse(new TextDecoder('utf-8').decode(bytes)); });
      });
    }).catch(function () { return null; }).then(function (r) { clearTimeout(timer); return r; });
  }

  /*
   * createChecker(deps) -> check(docUrl) -> Promise<{ allowed: boolean, reason?: string, robots: 'none'|'read' }>
   * One checker = one analysis: it keeps robots.txt per site in memory (promises, so two documents on one site share one request)
   * and nothing else. Throw it away when the analysis is done.
   */
  function createChecker(deps) {
    var cache = {};
    return function check(docUrl) {
      var u;
      try { u = new URL(docUrl); } catch (e) { return Promise.resolve({ allowed: true, robots: 'none' }); }
      var key = u.origin;
      if (!cache[key]) cache[key] = fetchRules(key, deps);
      return cache[key].then(function (parsed) {
        if (!parsed) return { allowed: true, robots: 'none' };
        if (isAllowed(parsed, u.pathname + u.search)) return { allowed: true, robots: 'read' };
        return { allowed: false, robots: 'read', reason: 'the site\'s robots.txt asks automated tools not to fetch this page' };
      });
    };
  }

  return { parse: parse, isAllowed: isAllowed, matches: matches, robotsUrl: robotsUrl, fetchRules: fetchRules, createChecker: createChecker,
    ROBOTS_TIMEOUT_MS: ROBOTS_TIMEOUT_MS, ROBOTS_MAX_BYTES: ROBOTS_MAX_BYTES, AGENT: AGENT };
});
