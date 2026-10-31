/*
 * linkgroup.js - labels legal documents and collapses regional / language duplicates into ONE entry per document.
 * Pure functions, no network. Input is a list of classified links ({url, text, doc_type, language, score, ...}, from
 * detect.js classifyLink or consent.js). Many privacy centres list the same policy 15+ times (en-us, fr-fr, de-de ...).
 *
 *   dedupe(links, {lang}) -> { docs, collapsed }
 *     1. a link in another language is dropped when the same document type is also available in the user's language;
 *     2. links that differ only in a locale token (path /en-us/ vs /fr-fr/, suffix -de, host prefix de., TLD .de vs .com,
 *        ?lang=) are variants of one document;
 *     3. of each set of variants, the one closest to the user's language/region is kept (exact en-US, then en, then the
 *        site default, then another English region, then everything else).
 *   labelFor(link) -> short label ("Terms", "Privacy", "Cookies", "EULA", "Arbitration", ...)
 *   userLocale(navigatorLanguage) -> { lang, region }
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCLinkGroup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ORDER = { tos: 0, privacy: 1, eula: 2, cookies: 3, other: 4 };
  var TYPE_LABEL = { tos: 'Terms', privacy: 'Privacy', eula: 'EULA', cookies: 'Cookies', other: 'Other' };
  var SPECIFIC = [
    [/arbitration/i, 'Arbitration'],
    [/subscri|membership|auto[- ]?renew/i, 'Subscription terms'],
    [/community|guidelines|house rules|code of conduct/i, 'Community rules'],
    [/acceptable use|content policy|user agreement|visitor agreement/i, null], // handled by type (Terms)
    [/terms of sale|conditions of sale|purchase terms/i, 'Terms of sale'],
    [/\bdo not sell\b|your privacy choices|privacy rights|ccpa|california/i, 'Privacy choices'],
    [/advertis|interest[- ]based|ad choices/i, 'Advertising']
  ];

  function labelFor(link) {
    var text = String((link && link.text) || '');
    for (var i = 0; i < SPECIFIC.length; i++) if (SPECIFIC[i][1] && SPECIFIC[i][0].test(text)) return SPECIFIC[i][1];
    return TYPE_LABEL[link && link.doc_type] || TYPE_LABEL.other;
  }

  // Make the labels in one result unique: when two documents share a label, use the link text instead.
  function uniqueLabels(docs) {
    var count = {};
    docs.forEach(function (d) { count[d.label] = (count[d.label] || 0) + 1; });
    var used = {};
    docs.forEach(function (d) {
      if (count[d.label] > 1) {
        var t = String(d.text || '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 28) d.label = t;
      }
      if (used[d.label]) d.label = d.label + ' (' + (used[d.label] + 1) + ')';
      used[d.label] = (used[d.label] || 0) + 1;
    });
    return docs;
  }

  function userLocale(tag) {
    var m = /^([a-z]{2,3})(?:[-_]([a-z]{2}|\d{3}))?/i.exec(String(tag || 'en-US'));
    return m ? { lang: m[1].toLowerCase(), region: (m[2] || '').toLowerCase() } : { lang: 'en', region: 'us' };
  }

  var SEG_LOCALE = /^([a-z]{2})(?:[-_]([a-z]{2}|[a-z]{4}|\d{3}))?$/i;                // en, en-us, pt_BR, zh-hans
  var SUFFIX_LOCALE = /^(.{3,}?)[-_.]([a-z]{2})(?:[-_]([a-z]{2}))?$/i;               // privacy-policy-fr, privacy_en-us
  var QUERY_DROP = /^(lang|language|locale|hl|region|country|cc|ul|l|gl|utm_.*|fbclid|gclid|ref)$/i;
  var SLD2 = /^(co|com|org|net|gov|ac|edu)$/i;

  function splitLocale(tok) {
    var m = SEG_LOCALE.exec(tok);
    if (!m) return null;
    var a = m[1].toLowerCase(), b = (m[2] || '').toLowerCase();
    return { lang: a, region: b };
  }

  // -> { key, locale: {lang, region} | null }
  function describe(link) {
    var u;
    try { u = new URL(link.url); } catch (e) { return { key: String(link.url), locale: null }; }
    var loc = null;
    var host = u.hostname.toLowerCase().replace(/^www\./, '');
    var labels = host.split('.');
    if (labels.length >= 3 && SEG_LOCALE.test(labels[0]) && labels[0].length <= 5) { loc = splitLocale(labels[0]); labels.shift(); }
    // country TLD (example.de / example.co.uk): the site name is the label before the public suffix
    var n = labels.length, sld;
    if (n >= 3 && labels[n - 1].length === 2 && SLD2.test(labels[n - 2])) sld = labels[n - 3];
    else if (n >= 2) sld = labels[n - 2];
    else sld = labels[0];
    var tld = labels[n - 1];
    if (!loc && labels.length >= 2 && tld.length === 2 && tld !== 'com' && !/^(io|tv|me|ai|co|us)$/i.test(tld)) loc = { lang: '', region: tld.toLowerCase() };
    var segs = u.pathname.split('/').filter(Boolean).map(function (seg) {
      var s = seg.toLowerCase().replace(/\.(html?|php|aspx?|jsp)$/, '');
      var l = splitLocale(s);
      if (l) { loc = loc || l; return '*'; }
      var m = SUFFIX_LOCALE.exec(s);
      if (m && splitLocale(m[2] + (m[3] ? '-' + m[3] : ''))) { loc = loc || splitLocale(m[2] + (m[3] ? '-' + m[3] : '')); return m[1] + '-*'; }
      return s;
    });
    var q = [];
    u.searchParams.forEach(function (v, k) {
      if (/^(lang|language|locale|hl)$/i.test(k) && !loc) loc = splitLocale(String(v).toLowerCase());
      if (!QUERY_DROP.test(k)) q.push(k.toLowerCase() + '=' + v);
    });
    q.sort();
    var linkLang = String(link.language || '').toLowerCase();
    if (!loc && linkLang && linkLang !== 'en') loc = { lang: linkLang, region: '' };
    return { key: [link.doc_type || '', sld, '/' + segs.join('/'), q.join('&')].join('|'), locale: loc };
  }

  var EN_US = { lang: 'en', region: 'us' };
  function rank(locale, pref) {
    var r = rank1(locale, pref);
    // nothing in the user's language: fall back to US English, then the other English versions
    return r >= 4 && pref !== EN_US ? 4 + rank1(locale, EN_US) : r;
  }
  function rank1(locale, pref) {
    if (!locale) return 2; // the site's default version
    var lang = locale.lang, region = locale.region;
    if (lang && lang === pref.lang && region && region === pref.region) return 0;
    if (!lang && region && region === pref.region) return 0;
    if (lang === pref.lang && !region) return 1;
    if (lang === pref.lang) return 3;
    if (!lang) return 4;
    return 5;
  }

  function dedupe(links, opts) {
    opts = opts || {};
    var pref = userLocale(opts.lang);
    var list = (links || []).filter(function (l) { return l && l.url; });
    // identical URL (fragment, tracking params ignored) is one document
    var seenUrl = {}, uniq = [];
    list.forEach(function (l, i) {
      var c = { link: l, i: i, d: describe(l) };
      var k = l.url.split('#')[0];
      if (seenUrl[k]) { if ((l.score || 0) > (seenUrl[k].link.score || 0)) { uniq[uniq.indexOf(seenUrl[k])] = c; seenUrl[k] = c; } return; }
      seenUrl[k] = c; uniq.push(c);
    });
    var collapsed = list.length - uniq.length;

    // 1. a link in a foreign language is dropped when the same type exists in the user's language
    var haveUserLang = {};
    uniq.forEach(function (c) { if (!c.link.non_english || (c.d.locale && c.d.locale.lang === pref.lang)) haveUserLang[c.link.doc_type] = true; });
    var kept = [];
    uniq.forEach(function (c) {
      var foreign = c.link.non_english && !(c.d.locale && c.d.locale.lang === pref.lang) && String(c.link.language || '') !== pref.lang;
      if (foreign && haveUserLang[c.link.doc_type]) { collapsed++; return; }
      kept.push(c);
    });

    // 2 + 3. variants of one document -> the one closest to the user
    var groups = {}, order = [];
    kept.forEach(function (c) {
      var k = c.d.key;
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(c);
    });
    var docs = [];
    order.forEach(function (k) {
      var g = groups[k];
      g.sort(function (a, b) { return rank(a.d.locale, pref) - rank(b.d.locale, pref) || (b.link.score || 0) - (a.link.score || 0) || a.i - b.i; });
      var pick = Object.assign({}, g[0].link, { variants: g.length - 1, locale: g[0].d.locale ? [g[0].d.locale.lang, g[0].d.locale.region].filter(Boolean).join('-') : '', _i: g[0].i });
      collapsed += g.length - 1;
      docs.push(pick);
    });
    docs.sort(function (a, b) {
      return ((ORDER[a.doc_type] === undefined ? 9 : ORDER[a.doc_type]) - (ORDER[b.doc_type] === undefined ? 9 : ORDER[b.doc_type])) || a._i - b._i;
    });
    docs.forEach(function (d) { delete d._i; d.label = labelFor(d); });
    uniqueLabels(docs);
    return { docs: docs, collapsed: collapsed };
  }

  return { dedupe: dedupe, labelFor: labelFor, uniqueLabels: uniqueLabels, userLocale: userLocale, describe: describe, TYPE_LABEL: TYPE_LABEL };
});
