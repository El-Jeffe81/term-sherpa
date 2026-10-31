/*
 * untrusted.js - terms text comes from third parties, so it is DATA, never instructions or code.
 * sanitizeText removes characters that are invisible or that can attack a terminal, a viewer or a future model:
 *   - C0/C1 control characters (except newline and tab) and DEL (terminal escape sequences, NUL)
 *   - bidirectional embedding/override/isolate controls (text that displays differently from how it reads)
 *   - zero-width space / word joiner / BOM, and Unicode "tag" characters U+E0000-E007F (invisible text)
 * Visible text is never changed. Nothing here evaluates, parses or follows the text.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCUntrusted = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function sanitizeText(s) {
    return String(s === undefined || s === null ? '' : s).replace(/\udb40[\udc00-\udc7f]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200b\u2060\ufeff]/g, '');
  }

  function countSuspicious(s) {
    s = String(s || '');
    return s.length - sanitizeText(s).length;
  }

  // Make a value safe to print on a terminal line (also removes newlines).
  function printable(s, max) {
    var t = sanitizeText(s).replace(/[\r\n\t]+/g, ' ');
    return max && t.length > max ? t.slice(0, max - 3) + '...' : t;
  }

  // Heuristic flag for text that tries to talk to a model. For REPORTING only; the text is stored unchanged and never obeyed.
  var INJECTION_HINTS = [
    /ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|prompts?|messages)/i,
    /disregard (all |any )?(the )?(previous|prior|above|earlier) (instructions|prompts?)/i,
    /you are now (a|an|in)\b/i,
    /\b(system|developer) (prompt|message)\b/i,
    /do not (tell|inform|warn) the user/i,
    /\bas an? (ai|language model|assistant)\b/i,
    /(reveal|print|repeat) (your|the) (system )?(prompt|instructions)/i
  ];
  function injectionHints(s) {
    s = String(s || '');
    return INJECTION_HINTS.filter(function (re) { return re.test(s); }).length;
  }

  return { sanitizeText: sanitizeText, countSuspicious: countSuspicious, printable: printable, injectionHints: injectionHints };
});
