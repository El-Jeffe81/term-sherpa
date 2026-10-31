/*
 * frames.js - pure helpers for pages whose "I agree" box (or terms) lives inside an iframe.
 *
 * The Explain window injects the reader into the tab's frames (executeScript with allFrames). Which frames the browser lets it
 * into depends on the permission it has: same-origin frames always work; a frame from ANOTHER site only after the person has
 * allowed that site (the browser's normal one-time prompt, requested from a button here). Frames it could not enter are
 * reported plainly instead of silently ignored.
 *
 *   combine(frameResults) -> { res, fromFrame, unreadable }
 *     frameResults  [{ frameId, result }] as returned by chrome.scripting.executeScript (result = what content/run.js left behind)
 *     res           the result the Explain window shows: the top frame's, plus the consent box / terms text found in a frame when the
 *                   top frame had none, plus the frames' legal links
 *     fromFrame     null, or { host, url, what: 'consent' | 'terms' } when res came from a frame
 *     unreadable    [{ host, origin }] iframes that look like a consent box / overlay / policy but were not read (other sites not allowed yet)
 * Everything in the results is untrusted page data; this only picks and merges it. No DOM, no network, no storage.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCFrames = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_UNREADABLE = 3;

  function parse(u) { try { var x = new URL(u); return /^https?:$/.test(x.protocol) ? x : null; } catch (e) { return null; } }

  function mergeLinks(a, b) {
    var seen = {}, out = [];
    (a || []).concat(b || []).forEach(function (l) { if (l && l.url && !seen[l.url]) { seen[l.url] = 1; out.push(l); } });
    return out;
  }

  function combine(frameResults) {
    var list = (frameResults || []).filter(function (r) { return r && r.result; });
    var top = list.filter(function (r) { return r.frameId === 0; })[0] || list[0];
    if (!top) return { res: null, fromFrame: null, unreadable: [] };
    var res = top.result;
    if (!res.ok) return { res: res, fromFrame: null, unreadable: [] };
    var subs = list.filter(function (r) { return r !== top && r.result && r.result.ok; });
    var fromFrame = null;
    var out = Object.assign({}, res);

    var topHasConsent = !!(res.consent && res.consent.found && res.consent.links && res.consent.links.length);
    if (!res.extracted && !topHasConsent) {
      var withConsent = subs.filter(function (r) { var c = r.result.consent; return c && c.found && c.links && c.links.length; })[0];
      var withTerms = subs.filter(function (r) { return r.result.extracted; })[0];
      var pick = withConsent || withTerms;
      if (pick) {
        var p = parse(pick.result.page && pick.result.page.url);
        fromFrame = { host: p ? p.host : '', url: p ? p.href : '', what: withConsent ? 'consent' : 'terms' };
        if (withConsent) out.consent = pick.result.consent;
        else { out.extracted = pick.result.extracted; out.page = Object.assign({}, res.page, { url: pick.result.page.url, looks_like_terms: true, doc_type: pick.result.page.doc_type }); }
      }
    }
    subs.forEach(function (r) { out.links = mergeLinks(out.links, r.result.links); });

    // iframes in the top page that look like a consent box / overlay / policy, whose site we did not get into
    var entered = {};
    list.forEach(function (r) { var u = parse(r.result.page && r.result.page.url); if (u) entered[u.origin] = 1; });
    var unreadable = [], seenO = {};
    (res.frames || []).forEach(function (f) {
      var u = parse(f && f.src);
      if (!u || entered[u.origin] || seenO[u.origin] || !f.likely) return;
      seenO[u.origin] = 1;
      if (unreadable.length < MAX_UNREADABLE) unreadable.push({ host: u.host, origin: u.origin });
    });
    return { res: out, fromFrame: fromFrame, unreadable: unreadable };
  }

  // Chrome match patterns to ask the browser to allow (ports are not part of a match pattern).
  function originPatterns(unreadable) {
    var out = [];
    (unreadable || []).forEach(function (u) { var x = parse(u.origin); if (x && x.protocol === 'https:') { var p = 'https://' + x.hostname + '/*'; if (out.indexOf(p) < 0) out.push(p); } });
    return out;
  }

  return { combine: combine, originPatterns: originPatterns, MAX_UNREADABLE: MAX_UNREADABLE };
});
