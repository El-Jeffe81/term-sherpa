/*
 * versioning.js - normalization, SHA-256, line diff, and "new version only if
 * the hash changed" logic. Pure functions, shared by the extension and the CLI.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCVersioning = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function normalizeText(t) {
    return String(t || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\u00a0]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalizeUrl(u) {
    var x = new URL(u);
    x.hash = '';
    return x.href;
  }

  async function sha256Hex(str) {
    var bytes = new TextEncoder().encode(str);
    var buf = await root.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  // Line diff (LCS). Returns {added, removed, text}; text is a compact unified-style diff.
  function lineDiff(a, b, context) {
    context = context === undefined ? 2 : context;
    var A = a ? a.split('\n') : [], B = b ? b.split('\n') : [];
    var s = 0;
    while (s < A.length && s < B.length && A[s] === B[s]) s++;
    var ea = A.length, eb = B.length;
    while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
    var midA = A.slice(s, ea), midB = B.slice(s, eb);
    var ops = []; // {op:' '|'-'|'+', line}
    for (var i = 0; i < s; i++) ops.push({ op: ' ', line: A[i] });
    if (midA.length * midB.length > 25000000) {
      midA.forEach(function (l) { ops.push({ op: '-', line: l }); });
      midB.forEach(function (l) { ops.push({ op: '+', line: l }); });
    } else {
      var n = midA.length, m = midB.length;
      var dp = [];
      for (var x = 0; x <= n; x++) dp.push(new Uint32Array(m + 1));
      for (x = n - 1; x >= 0; x--) for (var y = m - 1; y >= 0; y--)
        dp[x][y] = midA[x] === midB[y] ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
      x = 0; var yy = 0;
      while (x < n && yy < m) {
        if (midA[x] === midB[yy]) { ops.push({ op: ' ', line: midA[x] }); x++; yy++; }
        else if (dp[x + 1][yy] >= dp[x][yy + 1]) { ops.push({ op: '-', line: midA[x++] }); }
        else { ops.push({ op: '+', line: midB[yy++] }); }
      }
      while (x < n) ops.push({ op: '-', line: midA[x++] });
      while (yy < m) ops.push({ op: '+', line: midB[yy++] });
    }
    for (i = ea; i < A.length; i++) ops.push({ op: ' ', line: A[i] });

    var added = 0, removed = 0;
    ops.forEach(function (o) { if (o.op === '+') added++; else if (o.op === '-') removed++; });
    // keep only changed lines plus `context` lines around them
    var keep = new Array(ops.length).fill(false);
    ops.forEach(function (o, idx) {
      if (o.op !== ' ') for (var k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
    });
    var out = [], gap = false;
    ops.forEach(function (o, idx) {
      if (keep[idx]) { if (gap) out.push('@@'); out.push(o.op + ' ' + o.line); gap = false; } else gap = true;
    });
    return { added: added, removed: removed, text: out.join('\n') };
  }

  /*
   * Decide what to do with a new snapshot.
   *  prev: latest stored version info or null: {sha256, text}
   *  next: {sha256, text}
   * Returns {status:'new'|'unchanged'|'changed', diff_from_prev, added, removed}
   */
  function decide(prev, next) {
    if (!prev) return { status: 'new', diff_from_prev: null, added: 0, removed: 0 };
    if (prev.sha256 === next.sha256) return { status: 'unchanged', diff_from_prev: null, added: 0, removed: 0 };
    var d = lineDiff(prev.text, next.text);
    return { status: 'changed', diff_from_prev: d.text, added: d.added, removed: d.removed };
  }

  return { normalizeText: normalizeText, normalizeUrl: normalizeUrl, sha256Hex: sha256Hex, lineDiff: lineDiff, decide: decide };
});
