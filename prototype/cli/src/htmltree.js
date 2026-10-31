'use strict';
/*
 * htmltree.js - tiny forgiving HTML parser -> the tree format used by extract.js.
 * Not a spec-complete HTML5 parser; good enough for static legal pages and fixtures.
 */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const BLOCK_CLOSES_P = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'blockquote', 'pre', 'form', 'dl', 'hr']);

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c',
  rdquo: '\u201d', bull: '\u2022', middot: '\u00b7', trade: '\u2122', laquo: '\u00ab', raquo: '\u00bb', sect: '\u00a7', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', para: '\u00b6', times: '\u00d7', deg: '\u00b0', plusmn: '\u00b1'
};
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    const name = m[1].toLowerCase();
    const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    if (!(name in attrs)) attrs[name] = decodeEntities(val);
  }
  return attrs;
}

function parseHtml(html) {
  const root = { t: 'el', tag: 'html', attrs: {}, kids: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const popTo = (tag, stops) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tag === tag) { stack.length = i; return true; }
      if (stops && stops.has(stack[i].tag)) return false;
    }
    return false;
  };
  let i = 0;
  const n = html.length;
  const addText = (s) => { if (s) top().kids.push({ t: 'tx', s: decodeEntities(s) }); };
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { addText(html.slice(i)); break; }
    if (lt > i) addText(html.slice(i, lt));
    i = lt;
    if (html.startsWith('<!--', i)) { const e = html.indexOf('-->', i + 4); i = e === -1 ? n : e + 3; continue; }
    if (html[i + 1] === '!' || html[i + 1] === '?') { const e = html.indexOf('>', i); i = e === -1 ? n : e + 1; continue; }
    const close = /^<\/([a-zA-Z][^\s>\/]*)[^>]*>/.exec(html.slice(i, i + 200));
    if (close) {
      const tag = close[1].toLowerCase();
      popTo(tag, new Set(['table', 'html', 'body']));
      i += close[0].length; continue;
    }
    // open tag; find end respecting quotes
    const m = /^<([a-zA-Z][^\s>\/]*)/.exec(html.slice(i, i + 64));
    if (!m) { addText('<'); i++; continue; }
    let j = i + m[0].length, q = null;
    while (j < n) {
      const c = html[j];
      if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break;
      j++;
    }
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(html.slice(i + m[0].length, j).replace(/\/\s*$/, ''));
    const selfClose = /\/\s*$/.test(html.slice(i + m[0].length, j));
    i = j + 1;

    // implicit closes
    if (BLOCK_CLOSES_P.has(tag) && top().tag === 'p') stack.pop();
    if (tag === 'li') popTo('li', new Set(['ul', 'ol']));
    if (tag === 'td' || tag === 'th') { if (top().tag === 'td' || top().tag === 'th') stack.pop(); }
    if (tag === 'tr') { if (top().tag === 'td' || top().tag === 'th') stack.pop(); if (top().tag === 'tr') stack.pop(); }
    if (tag === 'dt' || tag === 'dd') { if (top().tag === 'dt' || top().tag === 'dd') stack.pop(); }

    const node = { t: 'el', tag, attrs, kids: [] };
    top().kids.push(node);
    if (VOID.has(tag) || selfClose) continue;
    if (RAW.has(tag)) {
      const re = new RegExp('</' + tag + '\\s*>', 'i');
      const rest = html.slice(i);
      const mm = re.exec(rest);
      const body = mm ? rest.slice(0, mm.index) : rest;
      if (body) node.kids.push({ t: 'tx', s: tag === 'script' || tag === 'style' ? body : decodeEntities(body) });
      i += mm ? mm.index + mm[0].length : rest.length;
      continue;
    }
    stack.push(node);
  }
  return root;
}

module.exports = { parseHtml, decodeEntities };
