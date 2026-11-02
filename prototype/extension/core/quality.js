/*
 * quality.js - dataset quality checks (pure functions; no I/O). Used by `tc-collect quality`.
 * These are heuristics to help a human decide what to re-collect or clean up. They do not judge legal content.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCQuality = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Tiny stopword lists; enough to tell the six supported languages apart on legal prose.
  var STOP = {
    en: 'the and of to in is that for you may will your any this with by or be are as not on we our shall us from',
    es: 'el la los las de que y en un una se por con para su sus del al como no es lo usted nuestro nuestra podr\u00e1 ser o',
    fr: 'le la les des de du et en un une que qui pour par sur vous votre vos nous notre ne pas est sont ou au aux ce',
    de: 'der die das und den dem des ein eine einer zu von mit f\u00fcr auf ist sie wir ihre nicht werden oder im als bei',
    pt: 'o a os as de do da dos das e em um uma que para por com seu sua n\u00e3o \u00e9 voc\u00ea nosso ou ao como se',
    it: 'il lo la i gli le di del della dei delle e in un una che per con su suo sua non \u00e8 voi nostro o al come si'
  };
  var STOPSET = {};
  Object.keys(STOP).forEach(function (l) { STOPSET[l] = {}; STOP[l].split(' ').forEach(function (w) { STOPSET[l][w] = 1; }); });

  // Returns {lang, confidence} for en/es/fr/de/pt/it, or {lang:'unknown'}.
  function guessLanguage(text) {
    var words = String(text || '').toLowerCase().match(/[a-z\u00e0-\u00ff]+/g) || [];
    if (words.length < 30) return { lang: 'unknown', confidence: 0 };
    var sample = words.length > 4000 ? words.slice(0, 4000) : words;
    var scores = {}, total = 0;
    Object.keys(STOPSET).forEach(function (l) {
      var c = 0;
      for (var i = 0; i < sample.length; i++) if (STOPSET[l][sample[i]]) c++;
      scores[l] = c; total += c;
    });
    var best = 'unknown', bestN = 0;
    Object.keys(scores).forEach(function (l) { if (scores[l] > bestN) { best = l; bestN = scores[l]; } });
    if (!total || bestN / sample.length < 0.08) return { lang: 'unknown', confidence: 0 };
    return { lang: best, confidence: Math.round((bestN / total) * 100) / 100 };
  }

  var CHROME_LINE = /^(#+\s*)?(skip to (main )?content|accept (all )?cookies?|reject all|cookie settings|manage (cookie )?preferences|select (a )?language|choose (a )?language|sign in|log in|log out|sign up|subscribe to our newsletter|back to top|all rights reserved\.?|\u00a9\s*\d{4}.*)\s*$/i;

  /*
   * doc: {url, doc_type, needs_partner, last_checked_at, text (latest version clean text) | null, sections: [{heading,text}],
   *       rawBytes, lang, removedChars, injectionHints}
   * Returns {issues: [{code, severity:'info'|'warn'|'bad', detail}], grade:'ok'|'review'|'poor'|'pending'}
   */
  function assessDocument(doc, opts) {
    opts = opts || {};
    var now = opts.now ? new Date(opts.now).getTime() : Date.now();
    var issues = [];
    function add(code, severity, detail) { issues.push({ code: code, severity: severity, detail: detail || '' }); }
    if (doc.needs_partner) {
      add('needs-' + doc.needs_partner, 'info', 'Not collected yet: needs the ' + doc.needs_partner + ' partner (pending owner approval).');
      return { issues: issues, grade: 'pending' };
    }
    var text = doc.text || '';
    var len = text.length;
    if (!len) { add('no-text', 'bad', 'No stored text.'); return { issues: issues, grade: 'poor' }; }
    var min = doc.doc_type === 'cookies' || doc.doc_type === 'other' ? 300 : 800;
    if (len < min) add('too-short', 'warn', len + ' chars (expected at least ' + min + ' for ' + doc.doc_type + ').');

    var sections = doc.sections || [];
    var headed = sections.filter(function (s) { return s.heading; });
    if (!sections.length) add('no-sections', 'warn', 'No sections stored (collected before sectioning, or no text structure). Re-collect to refresh.');
    else if (len > 3000 && headed.length < 2) add('few-headings', 'warn', 'Long document with ' + headed.length + ' heading(s); structure may have been lost.');
    if (sections.length) {
      var biggest = sections.reduce(function (m, s) { return Math.max(m, (s.text || '').length); }, 0);
      if (sections.length > 1 && len > 3000 && biggest > 0.8 * len) add('one-giant-section', 'info', 'One section holds ' + Math.round(biggest / len * 100) + '% of the text.');
    }

    var lines = text.split('\n'), chrome = 0;
    for (var i = 0; i < lines.length; i++) if (CHROME_LINE.test(lines[i].trim())) chrome++;
    if (chrome) add('chrome-leftover', 'warn', chrome + ' line(s) look like page chrome (cookie banner, nav, footer).');

    var paras = text.split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(function (p) { return p.length > 40; });
    if (paras.length >= 6) {
      var seen = {}, dup = 0;
      paras.forEach(function (p) { if (seen[p]) dup++; else seen[p] = 1; });
      if (dup / paras.length > 0.2) add('repeated-text', 'warn', dup + ' of ' + paras.length + ' paragraphs are repeats.');
    }

    var lang = doc.lang && doc.lang !== 'unknown' ? doc.lang : guessLanguage(text).lang;
    if (lang && lang !== 'en' && lang !== 'unknown') add('non-english', 'info', 'Looks like ' + lang + '.');
    if (lang === 'unknown') add('language-unknown', 'info', 'Could not tell the language.');

    if (doc.rawBytes && doc.rawBytes > 20000 && len / doc.rawBytes < 0.02) add('low-text-ratio', 'warn', 'Only ' + (len / doc.rawBytes * 100).toFixed(1) + '% of the page was kept as text (JavaScript-heavy page?).');
    if (doc.removedChars) add('sanitized-chars', 'info', doc.removedChars + ' invisible/control character(s) were removed from the text.');
    if (doc.injectionHints) add('injection-hint', 'warn', 'Text contains ' + doc.injectionHints + ' phrase(s) that address an AI model. It is stored as data only; never feed it to a model as instructions.');
    if (doc.last_checked_at) {
      var age = (now - new Date(doc.last_checked_at).getTime()) / 86400000;
      if (age > 90) add('stale', 'info', 'Last checked ' + Math.floor(age) + ' days ago.');
    }
    var bad = issues.filter(function (x) { return x.severity === 'bad'; }).length;
    var warn = issues.filter(function (x) { return x.severity === 'warn'; }).length;
    return { issues: issues, grade: bad ? 'poor' : warn >= 3 ? 'poor' : warn ? 'review' : 'ok', lang: lang };
  }

  function buildReport(docs, opts) {
    var rows = docs.map(function (d) { var a = assessDocument(d, opts); return { url: d.url, doc_type: d.doc_type, grade: a.grade, lang: a.lang || d.lang || '', chars: d.text ? d.text.length : 0, sections: (d.sections || []).length, versions: d.versions || 0, issues: a.issues }; });
    var byGrade = {}, byIssue = {}, byLang = {}, byType = {};
    rows.forEach(function (r) {
      byGrade[r.grade] = (byGrade[r.grade] || 0) + 1;
      byType[r.doc_type] = (byType[r.doc_type] || 0) + 1;
      if (r.lang) byLang[r.lang] = (byLang[r.lang] || 0) + 1;
      r.issues.forEach(function (x) { byIssue[x.code] = (byIssue[x.code] || 0) + 1; });
    });
    return { total: rows.length, by_grade: byGrade, by_issue: byIssue, by_language: byLang, by_type: byType, documents: rows };
  }

  return { guessLanguage: guessLanguage, assessDocument: assessDocument, buildReport: buildReport };
});
