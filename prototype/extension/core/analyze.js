/*
 * analyze.js - the on-device "Explain" engine. Pure functions: text in, plain object out.
 * NOT AI: no model, no network, nothing stored. It splits the terms into sentences, tests each sentence against the
 * fixed rules in rules.js, merges findings that make the same point, judges each one in the context of the kind of
 * service (core/context.js), and ranks the result High / Medium / Low. Each finding is ONE fixed plain-English sentence
 * written in rules.js (page text is never pasted into it). The exact quotes behind it are kept for a collapsed
 * "Show exact wording" view; every quote is checked with the existing exact-quote verifier (core/quote.js) against the
 * original text, and a quote that fails the check is dropped, never shown.
 * The terms text is untrusted data: it is sanitised (core/untrusted.js), only matched against regular expressions,
 * and the result is plain strings meant to be shown with textContent (never as HTML).
 */
(function (root, factory) {
  var api;
  if (typeof module === 'object' && module.exports) api = factory(require('./rules.js'), require('./quote.js'), require('./untrusted.js'), require('./context.js'));
  else api = root.TCAnalyze = factory(root.TCRules, root.TCQuote, root.TCUntrusted, root.TCContext);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TCRules, TCQuote, TCUntrusted, TCContext) {
  'use strict';

  var MAX_TEXT = 1000000;      // characters analysed (a longer text is cut and the result says so)
  var MAX_SENTENCE = 1800;     // longer runs are split further so pattern matching stays fast
  var MAX_QUOTE = 600;         // longest quote shown; a longer sentence is cut to a contiguous piece of itself
  var MAX_EVIDENCE = 3;        // quotes shown per rule
  var PLACEHOLDER = '\u0001';

  var ABBREV = /\b(Inc|Ltd|Co|Corp|LLC|L\.L\.C|No|Nos|Mr|Mrs|Ms|Dr|vs|etc|e\.g|i\.e|U\.S|U\.K|U\.S\.A|Sec|Secs|Art|approx|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|St|Mt|Fig|cf|al)\./g;
  var ENUM = /(^|\s)((?:\d{1,2}\.)+)(?=\s)/g;

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
      if (!best || TCRules.SEVERITY_RANK[sev] < TCRules.SEVERITY_RANK[best.severity]) best = { severity: sev, at: firstIndex(pat, s), line: pat.line || rule.line };
    }
    if (!best) return null;
    for (var x = 0; x < (rule.escalate || []).length; x++) {
      var es = rule.escalate[x];
      if (es.re.test(s) && TCRules.SEVERITY_RANK[es.severity] < TCRules.SEVERITY_RANK[best.severity]) { best.severity = es.severity; if (es.line) best.line = es.line; }
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
      hits.push({ quote: ex.text, truncated: ex.truncated, severity: m.severity, index: i, line: m.line });
    });
    hits = hits.filter(function (h) { return verified(text, h.quote); }); // exact-quote check: unverifiable quotes are dropped
    if (!hits.length) return null;
    hits.sort(function (a, b) { return TCRules.SEVERITY_RANK[a.severity] - TCRules.SEVERITY_RANK[b.severity] || a.index - b.index; });
    var finding = {
      id: rule.id, title: rule.title, severity: hits[0].severity, priority: rule.priority,
      line: hits[0].line, explain: rule.explain,
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

  /* ---------- merging, context ---------- */
  function mergeGroups(hits) {
    var used = {}, out = [];
    TCRules.GROUPS.forEach(function (g) {
      var members = hits.filter(function (f) { return g.members.indexOf(f.id) > -1; });
      if (!members.length) return;
      members.forEach(function (f) { used[f.id] = true; });
      var has = {}; members.forEach(function (f) { has[f.id] = f; });
      var sevOf = function (f) { return TCRules.SEVERITY_RANK[f.severity]; };
      var severity = members.slice().sort(function (a, b) { return sevOf(a) - sevOf(b); })[0].severity;
      var seen = {}, evidence = [], unseenExtra = 0;
      members.slice().sort(function (a, b) { return sevOf(a) - sevOf(b) || a.priority - b.priority; }).forEach(function (f) {
        unseenExtra += Math.max(0, f.totalMatches - f.evidence.length); // matches beyond each rule's own shown quotes
        f.evidence.forEach(function (e) { var k = TCQuote.normalizeWhitespace(e.quote); if (!seen[k]) { seen[k] = true; evidence.push(e); } });
      });
      var mitig = has.arbitration && has.arbitration.mitigation ? has.arbitration.mitigation : null;
      out.push({
        id: g.id, rules: members.map(function (f) { return f.id; }), title: g.title, severity: severity, baseSeverity: severity,
        priority: Math.min.apply(null, members.map(function (f) { return f.priority; })),
        line: g.line(has, !!mitig), explain: members.map(function (f) { return f.explain; }).join(' '),
        totalMatches: evidence.length + unseenExtra,
        evidence: evidence.slice(0, MAX_EVIDENCE), mitigation: mitig, contextNote: ''
      });
    });
    hits.forEach(function (f) {
      if (used[f.id]) return;
      out.push({ id: f.id, rules: [f.id], title: f.title, severity: f.severity, baseSeverity: f.severity, priority: f.priority, line: f.line, explain: f.explain, totalMatches: f.totalMatches, evidence: f.evidence, mitigation: f.mitigation, contextNote: '' });
    });
    return out;
  }

  function shiftSeverity(sev, delta) {
    var i = TCRules.SEVERITIES.indexOf(sev) - delta; // +1 = more serious = lower index
    return TCRules.SEVERITIES[Math.max(0, Math.min(TCRules.SEVERITIES.length - 1, i))];
  }

  function applyContext(items, type) {
    items.forEach(function (f) {
      var cell = (TCRules.CONTEXT_MATRIX[f.id] || {})[type];
      if (!cell) return;
      var next = shiftSeverity(f.severity, cell.shift);
      next = floored(f, next);
      if (next !== f.severity) { f.severity = next; f.contextNote = cell.note; }
    });
  }

  // CSO floor (rules.js SEVERITY_FLOOR): context never pushes these under Medium. A finding that was already below the
  // floor on its own pattern (base Low, e.g. "service providers") is left as it is.
  function floored(f, next) {
    var floorSev = null;
    (f.rules || [f.id]).forEach(function (id) {
      var fl = TCRules.SEVERITY_FLOOR[id];
      if (fl && (!floorSev || TCRules.SEVERITY_RANK[fl] < TCRules.SEVERITY_RANK[floorSev])) floorSev = fl;
    });
    // for a merged group the floor of its most serious member applies
    if (!floorSev) return next;
    var rank = TCRules.SEVERITY_RANK;
    if (rank[next] > rank[floorSev] && rank[f.baseSeverity] <= rank[floorSev]) return floorSev;
    return next;
  }

  function headline(items) {
    if (!items.length) return 'None of the common risk topics were found. That does not prove they are absent, so skim the terms.';
    var top = items[0].severity;
    if (top === 'High') return 'Some of these terms limit your rights. See the High items below.';
    if (top === 'Medium') return 'Mostly standard terms, with a few points worth knowing below.';
    return 'Nothing unusual found. These look like routine terms.';
  }

  var TYPE_LABEL = { tos: 'terms of service', privacy: 'privacy policy', eula: 'end-user licence agreement', cookies: 'cookie policy', other: 'legal document' };
  var CONTEXT_TYPES = TCContext.TYPES;

  /*
   * analyze(text, meta?) -> result object.  meta: { doc_type, title, host, context }
   * meta.context (one of TCContext.TYPES) forces the service type; it is for tests and callers, never read from the page.
   */
  function analyze(rawText, meta) {
    meta = meta || {};
    var text = TCUntrusted.sanitizeText(String(rawText === undefined || rawText === null ? '' : rawText));
    var truncated = false;
    if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); truncated = true; }
    var sentences = splitSentences(text);

    var ruleHits = [], notFound = [];
    TCRules.RULES.forEach(function (rule) {
      var f = scanRule(rule, sentences, text);
      if (f) ruleHits.push(f); else notFound.push({ id: rule.id, title: rule.title });
    });
    sortFindings(ruleHits);

    var ctx = CONTEXT_TYPES.indexOf(meta.context) > -1 && meta.context !== 'other'
      ? { type: meta.context, label: TCContext.LABELS[meta.context], confident: true, reasons: ['caller'], line: 'Type of service: ' + TCContext.LABELS[meta.context] + '.' }
      : TCContext.detect(meta.host, text);

    var findings = mergeGroups(ruleHits);
    applyContext(findings, ctx.type);
    sortFindings(findings);
    findings.forEach(function (f) { f.section = f.severity === 'Low' ? 'also' : 'risk'; });

    var counts = { High: 0, Medium: 0, Low: 0 };
    findings.forEach(function (f) { counts[f.severity]++; });

    var label = TYPE_LABEL[meta.doc_type] || 'legal document';
    var host = TCContext.hostOnly(meta.host);
    var summary = [
      (host || 'This page') + ': ' + label + '.',
      ctx.line,
      headline(findings)
    ];

    return {
      ok: true,
      meta: { doc_type: meta.doc_type || '', title: TCUntrusted.sanitizeText(meta.title || ''), host: host },
      stats: { sentences: sentences.length, truncated: truncated },
      overview: { summary: summary, notes: truncated ? ['The text was very long, so only the first ' + MAX_TEXT.toLocaleString('en-US') + ' characters were scanned.'] : [] },
      context: { type: ctx.type, label: ctx.label, confident: !!ctx.confident, reasons: ctx.reasons || [] },
      counts: counts,
      findings: findings,
      ruleHits: ruleHits,
      notFound: notFound,
      injectionHints: TCUntrusted.injectionHints(text),
      notice: TCRules.NOTICE
    };
  }

  return { analyze: analyze, splitSentences: splitSentences, excerpt: excerpt, MAX_QUOTE: MAX_QUOTE };
});
