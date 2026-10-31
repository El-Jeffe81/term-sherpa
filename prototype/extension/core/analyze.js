/*
 * analyze.js - the on-device "Explain" engine. Pure functions: text in, plain object out.
 * NOT AI: no model, no network, nothing stored. It splits the terms into sentences, tests each sentence against the
 * fixed rules in rules.js, ranks the findings High / Medium / Low, and builds a plain-English overview by EXTRACTING
 * sentences (never rewriting them). Every quote shown to the user is checked with the existing exact-quote verifier
 * (core/quote.js) against the original text; a quote that fails the check is dropped, never shown.
 * The terms text is untrusted data: it is sanitised (core/untrusted.js), only matched against regular expressions,
 * and the result is plain strings meant to be shown with textContent (never as HTML).
 */
(function (root, factory) {
  var api;
  if (typeof module === 'object' && module.exports) api = factory(require('./rules.js'), require('./quote.js'), require('./untrusted.js'));
  else api = root.TCAnalyze = factory(root.TCRules, root.TCQuote, root.TCUntrusted);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TCRules, TCQuote, TCUntrusted) {
  'use strict';

  var MAX_TEXT = 1000000;      // characters analysed (a longer text is cut and the result says so)
  var MAX_SENTENCE = 1800;     // longer runs are split further so pattern matching stays fast
  var MAX_QUOTE = 600;         // longest quote shown; a longer sentence is cut to a contiguous piece of itself
  var MAX_EVIDENCE = 3;        // quotes shown per rule
  var PLACEHOLDER = '\u0001';

  var ABBREV = /\b(Inc|Ltd|Co|Corp|LLC|L\.L\.C|No|Nos|Mr|Mrs|Ms|Dr|vs|etc|e\.g|i\.e|U\.S|U\.K|U\.S\.A|Sec|Secs|Art|approx|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|St|Mt|Fig|cf|al)\./g;
  var ENUM = /(^|\s)((?:\d{1,2}\.)+)(?=\s)/g;

  function words(s) { var m = s.match(/\S+/g); return m ? m.length : 0; }

  // Join lines that are only a hard wrap (previous line has no sentence end and the next starts in lower case).
  function paragraphs(text) {
    var lines = String(text).split(/\r?\n/), out = [], cur = '';
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim().replace(/^(#{1,6}\s+|[-*\u2022]\s+)/, '');
      if (!ln) { if (cur) { out.push(cur); cur = ''; } continue; }
      if (cur && !/[.!?:;"')\]\u201d\u2019]$/.test(cur) && /^[a-z]/.test(ln)) cur += ' ' + ln;
      else { if (cur) out.push(cur); cur = ln; }
    }
    if (cur) out.push(cur);
    return out;
  }

  function chunk(s) {
    if (s.length <= MAX_SENTENCE) return [s];
    var parts = s.split(/(?<=[;:])\s+/), out = [], cur = '';
    parts.forEach(function (p) {
      while (p.length > MAX_SENTENCE) {
        var cut = p.lastIndexOf(' ', MAX_SENTENCE); if (cut < MAX_SENTENCE / 2) cut = MAX_SENTENCE;
        if (cur) { out.push(cur); cur = ''; }
        out.push(p.slice(0, cut).trim()); p = p.slice(cut).trim();
      }
      if (cur && (cur.length + p.length + 1) > MAX_SENTENCE) { out.push(cur); cur = p; } else cur = cur ? cur + ' ' + p : p;
    });
    if (cur) out.push(cur);
    return out.filter(Boolean);
  }

  // Split into sentences. Each returned sentence is a contiguous piece of `text` (whitespace aside).
  function splitSentences(text) {
    var out = [];
    paragraphs(text).forEach(function (p) {
      var prot = p.replace(ABBREV, function (m) { return m.slice(0, -1) + PLACEHOLDER; }).replace(ENUM, function (m, a, b) { return a + b.replace(/\./g, PLACEHOLDER); });
      prot.split(/(?<=[.!?]["')\]\u201d\u2019]*)\s+(?=["'(\[\u201c\u2018]?[A-Z0-9])/).forEach(function (s) {
        s = s.split(PLACEHOLDER).join('.').trim();
        if (s) chunk(s).forEach(function (c) { out.push(c); });
      });
    });
    return out;
  }

  function firstIndex(pattern, s) {
    var m = pattern.all[0].exec(s);
    return m ? m.index : 0;
  }

  // Cut a long sentence to a contiguous piece around the match. Still a verbatim part of the sentence.
  function excerpt(sentence, at) {
    if (sentence.length <= MAX_QUOTE) return { text: sentence, truncated: false };
    var start = 0;
    if (at > 200) {
      var back = sentence.slice(Math.max(0, at - 250), at);
      var k = Math.max(back.lastIndexOf('; '), back.lastIndexOf(', '), back.lastIndexOf(': '));
      start = k >= 0 ? Math.max(0, at - 250) + k + 2 : Math.max(0, at - 120);
      if (k < 0) { var sp = sentence.indexOf(' ', start); if (sp > -1 && sp < at) start = sp + 1; }
    }
    var end = Math.min(sentence.length, start + MAX_QUOTE);
    if (end < sentence.length) { var sp2 = sentence.lastIndexOf(' ', end); if (sp2 > start + MAX_QUOTE / 2) end = sp2; }
    return { text: sentence.slice(start, end).trim(), truncated: true };
  }

  function matchSentence(rule, s) {
    for (var e = 0; e < (rule.exclude || []).length; e++) if (rule.exclude[e].test(s)) return null;
    var best = null;
    for (var p = 0; p < rule.patterns.length; p++) {
      var pat = rule.patterns[p], ok = true;
      for (var a = 0; a < pat.all.length; a++) if (!pat.all[a].test(s)) { ok = false; break; }
      if (!ok) continue;
      var sev = pat.severity || rule.severity;
      if (!best || TCRules.SEVERITY_RANK[sev] < TCRules.SEVERITY_RANK[best.severity]) best = { severity: sev, at: firstIndex(pat, s) };
    }
    if (!best) return null;
    for (var x = 0; x < (rule.escalate || []).length; x++) {
      var es = rule.escalate[x];
      if (es.re.test(s) && TCRules.SEVERITY_RANK[es.severity] < TCRules.SEVERITY_RANK[best.severity]) best.severity = es.severity;
    }
    return best;
  }

  function verified(text, quote) { return TCQuote.verifyQuote(text, quote).verified; }

  function scanRule(rule, sentences, text) {
    var seen = {}, hits = [];
    sentences.forEach(function (s, i) {
      var m = matchSentence(rule, s);
      if (!m) return;
      var key = TCQuote.normalizeWhitespace(s);
      if (seen[key]) return; // repeated sentences (accordion copies etc.) count once
      seen[key] = true;
      var ex = excerpt(s, m.at);
      hits.push({ quote: ex.text, truncated: ex.truncated, severity: m.severity, index: i });
    });
    hits = hits.filter(function (h) { return verified(text, h.quote); }); // exact-quote check: unverifiable quotes are dropped
    if (!hits.length) return null;
    hits.sort(function (a, b) { return TCRules.SEVERITY_RANK[a.severity] - TCRules.SEVERITY_RANK[b.severity] || a.index - b.index; });
    var finding = {
      id: rule.id, title: rule.title, severity: hits[0].severity, priority: rule.priority,
      explain: rule.explain, agreeing: rule.agreeing,
      totalMatches: hits.length,
      evidence: hits.slice(0, MAX_EVIDENCE).map(function (h) { return { quote: h.quote, severity: h.severity, truncated: h.truncated }; }),
      mitigation: null
    };
    (rule.mitigators || []).forEach(function (mt) {
      if (finding.mitigation) return;
      for (var i = 0; i < sentences.length; i++) {
        var ok = mt.all.every(function (re) { return re.test(sentences[i]); });
        if (ok) {
          var q = excerpt(sentences[i], 0).text;
          if (verified(text, q)) {
            finding.mitigation = { note: mt.note, quote: q };
            if (TCRules.SEVERITY_RANK[mt.severity] > TCRules.SEVERITY_RANK[finding.severity]) finding.severity = mt.severity;
          }
          break;
        }
      }
    });
    return finding;
  }

  function sortFindings(list) {
    return list.sort(function (a, b) {
      return TCRules.SEVERITY_RANK[a.severity] - TCRules.SEVERITY_RANK[b.severity] || a.priority - b.priority;
    });
  }

  /* ---------- overview (extractive) ---------- */
  var SERVICE_PATTERNS = [
    /\b(these|this|the following)\b.{0,60}\b(terms|agreement|conditions|policy)\b.{0,100}\b(govern|apply|applies|cover|covers|describe|describes|set out|sets out|constitute|constitutes|are a (legal )?agreement|is a (legal )?agreement)\b/i,
    /\bwelcome to\b/i,
    /\b(we|company)\b.{0,40}\b(provide|provides|offer|offers|operate|operates|make available)\b.{0,100}\b(service|services|platform|website|app|software|product|products)\b/i,
    /\b(is|are) an? (online |web |mobile )?(platform|service|marketplace|app|application|website|software|network)\b/i
  ];
  var OBLIGATION = /\b(you)\s+(must|shall|will|agree to|agree that you|are (responsible|required|obligated|liable)|may not|must not|shall not|will not|cannot|can not|are not (allowed|permitted)|promise|represent and warrant|acknowledge)\b|\b(you are prohibited|prohibited from|not permitted to|responsible for)\b/i;
  var OBLIGATION_KEYWORDS = /\b(pay|fees?|charges?|taxes|account|password|credentials|accurate|truthful|comply|laws?|unlawful|illegal|abuse|harass\w*|infring\w*|reverse engineer\w*|scrape\w*|security|content|age|years old)\b/gi;

  function pickService(sentences, text) {
    var found = [];
    for (var i = 0; i < Math.min(sentences.length, 60) && found.length < 2; i++) {
      var s = sentences[i];
      if (words(s) < 6) continue;
      if (SERVICE_PATTERNS.some(function (re) { return re.test(s); })) found.push(s);
    }
    var fallback = false;
    if (!found.length) {
      fallback = true;
      for (var j = 0; j < sentences.length && found.length < 2; j++) if (words(sentences[j]) >= 8) found.push(sentences[j]);
    }
    var quotes = found.map(function (s) { return excerpt(s, 0).text; }).filter(function (q) { return verified(text, q); });
    return { quotes: quotes, fallback: fallback };
  }

  function pickObligations(sentences, text) {
    var cands = [], seen = {};
    sentences.forEach(function (s, i) {
      if (words(s) < 5 || !OBLIGATION.test(s)) return;
      var key = TCQuote.normalizeWhitespace(s);
      if (seen[key]) return; seen[key] = true;
      var score = (s.match(OBLIGATION_KEYWORDS) || []).length;
      cands.push({ s: s, i: i, score: score });
    });
    cands.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    var top = cands.slice(0, 5).sort(function (a, b) { return a.i - b.i; });
    return top.map(function (c) { return excerpt(c.s, 0).text; }).filter(function (q) { return verified(text, q); });
  }

  var TYPE_LABEL = { tos: 'terms of service', privacy: 'privacy policy', eula: 'end-user licence agreement (EULA)', cookies: 'cookie policy', other: 'legal document' };

  /*
   * analyze(text, meta?) -> result object.  meta: { doc_type, title, host }
   */
  function analyze(rawText, meta) {
    meta = meta || {};
    var text = TCUntrusted.sanitizeText(String(rawText === undefined || rawText === null ? '' : rawText));
    var truncated = false;
    if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); truncated = true; }
    var sentences = splitSentences(text);
    var wc = words(text);

    var findings = [], notFound = [];
    TCRules.RULES.forEach(function (rule) {
      var f = scanRule(rule, sentences, text);
      if (f) findings.push(f); else notFound.push({ id: rule.id, title: rule.title });
    });
    sortFindings(findings);

    var counts = { High: 0, Medium: 0, Low: 0 };
    findings.forEach(function (f) { counts[f.severity]++; });

    var label = TYPE_LABEL[meta.doc_type] || 'legal document';
    var summary = [];
    summary.push('This looks like a ' + label + (meta.host ? ' from ' + meta.host : '') + '.');
    summary.push('It has about ' + wc.toLocaleString('en-US') + ' words (roughly ' + Math.max(1, Math.round(wc / 200)) + (Math.max(1, Math.round(wc / 200)) === 1 ? ' minute' : ' minutes') + ' to read).');
    if (findings.length) {
      summary.push('The scan found ' + findings.length + ' of the ' + TCRules.RULES.length + ' topics it checks for: ' + counts.High + ' High, ' + counts.Medium + ' Medium, ' + counts.Low + ' Low.');
    } else {
      summary.push('The scan found none of the ' + TCRules.RULES.length + ' topics it checks for. That does not prove they are absent: the scan only recognises common wording.');
    }
    if (truncated) summary.push('The text was very long, so only the first ' + MAX_TEXT.toLocaleString('en-US') + ' characters were scanned.');

    var service = pickService(sentences, text);
    var agreeing = findings.map(function (f) { return { severity: f.severity, text: f.agreeing, rule: f.id }; });

    return {
      ok: true,
      meta: { doc_type: meta.doc_type || '', title: TCUntrusted.sanitizeText(meta.title || ''), host: meta.host || '' },
      stats: { words: wc, sentences: sentences.length, minutes: Math.max(1, Math.round(wc / 200)), truncated: truncated },
      overview: { summary: summary, service: service.quotes, service_is_fallback: service.fallback, obligations: pickObligations(sentences, text) },
      counts: counts,
      findings: findings,
      notFound: notFound,
      agreeing: agreeing,
      injectionHints: TCUntrusted.injectionHints(text),
      notice: TCRules.NOTICE
    };
  }

  return { analyze: analyze, splitSentences: splitSentences, excerpt: excerpt, MAX_QUOTE: MAX_QUOTE };
});
