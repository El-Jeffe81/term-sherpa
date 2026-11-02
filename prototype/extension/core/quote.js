/*
 * quote.js - quote verification. A future model phase may only show a quote to the user if it is found, exactly,
 * in the ORIGINAL text we stored. Only whitespace is normalised (runs of spaces, tabs, newlines and non-breaking
 * spaces count as one space; leading/trailing whitespace is ignored). Case, punctuation, quote marks and every
 * other character must match exactly. No fuzzy matching, no ellipsis handling, no stemming.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCQuote = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeWhitespace(s) {
    return String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /*
   * original: the stored text (string). quote: the claimed quote (string).
   * Returns {verified, reason, occurrences, offset}; offset is an index into the whitespace-normalised original.
   */
  function verifyQuote(original, quote) {
    if (typeof original !== 'string' || typeof quote !== 'string') return { verified: false, reason: 'not-a-string', occurrences: 0, offset: -1 };
    var q = normalizeWhitespace(quote);
    if (!q) return { verified: false, reason: 'empty-quote', occurrences: 0, offset: -1 };
    var o = normalizeWhitespace(original);
    var first = o.indexOf(q);
    if (first === -1) return { verified: false, reason: 'not-found', occurrences: 0, offset: -1 };
    var n = 0, at = first;
    while (at !== -1) { n++; at = o.indexOf(q, at + 1); }
    return { verified: true, reason: 'exact-match', occurrences: n, offset: first };
  }

  /*
   * Same check, but also says which section holds the quote. sections: [{heading, anchor, text}].
   * A quote that spans two sections is verified against the whole text and reported with section = null.
   */
  function verifyQuoteInSections(sections, fullText, quote) {
    var whole = verifyQuote(fullText, quote);
    if (!whole.verified) return { verified: false, reason: whole.reason, section: null, occurrences: 0 };
    for (var i = 0; i < (sections || []).length; i++) {
      var s = sections[i];
      if (verifyQuote(String(s.text || ''), quote).verified) return { verified: true, reason: 'exact-match', section: { index: i, heading: s.heading, anchor: s.anchor }, occurrences: whole.occurrences };
    }
    return { verified: true, reason: 'exact-match-spans-sections', section: null, occurrences: whole.occurrences };
  }

  return { normalizeWhitespace: normalizeWhitespace, verifyQuote: verifyQuote, verifyQuoteInSections: verifyQuoteInSections };
});
