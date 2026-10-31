/*
 * extract.js - small built-in main-text extractor + link collector.
 * No third-party code. Works on a tiny tree so the same code runs in the
 * extension (tree built from the live DOM) and in Node (tree built by cli/src/htmltree.js).
 *
 * Quality features: language-picker lists are stripped, <main>/<article> are preferred, text is split into sections
 * (heading, anchor, text), and collapsed/accordion text is read straight from the DOM (details/summary, and panels
 * controlled by aria-expanded buttons) without clicking anything.
 *
 * Tree format:  element -> { t:'el', tag:'div', attrs:{id,class,role,href,...}, kids:[...] }
 *               text    -> { t:'tx', s:'some text' }
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCExtract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var EXTRACTOR_ID = 'tc-builtin-extractor@0.2';

  // Never part of a legal document's body text.
  var DROP_ALWAYS = {
    script: 1, style: 1, noscript: 1, template: 1, svg: 1, iframe: 1, canvas: 1, object: 1,
    embed: 1, input: 1, button: 1, select: 1, textarea: 1, option: 1, dialog: 1, audio: 1,
    video: 1, img: 1, picture: 1, map: 1, head: 1, meta: 1, link: 1, title: 1, datalist: 1
  };
  // Page chrome: dropped on the strict pass (and retried leniently if that leaves almost nothing).
  var DROP_CHROME = { nav: 1, aside: 1 };
  var CHROME_ROLES = /^(navigation|banner|contentinfo|search|dialog|alertdialog|alert|complementary)$/i;
  var NOISE_ATTR = /(^|[\s_-])(cookie[-_ ]?(banner|consent|notice|bar|popup|wall|modal)|consent[-_ ]?(banner|manager|modal|popup)|gdpr[-_ ]?(banner|popup)|onetrust|cc-window|cookiebot|breadcrumbs?|skip-link|social-share|share-buttons)/i;

  var BLOCK = {
    p: 1, div: 1, section: 1, article: 1, main: 1, header: 1, footer: 1, h1: 1, h2: 1, h3: 1,
    h4: 1, h5: 1, h6: 1, ul: 1, ol: 1, li: 1, table: 1, tr: 1, blockquote: 1, pre: 1, hr: 1,
    dl: 1, dt: 1, dd: 1, address: 1, figure: 1, figcaption: 1, fieldset: 1, form: 1,
    details: 1, summary: 1, body: 1, html: 1, thead: 1, tbody: 1, tfoot: 1, caption: 1
  };

  function attr(n, k) { return (n.attrs && n.attrs[k]) || ''; }

  function isHidden(n) {
    if (n.attrs) {
      if (n.attrs.hidden !== undefined && n.attrs.hidden !== null && n.attrs.hidden !== false) return true;
      if (/^true$/i.test(n.attrs['aria-hidden'] || '')) return true;
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(n.attrs.style || '')) return true;
    }
    return false;
  }

  function findFirst(n, pred) {
    if (n.t === 'el') {
      if (pred(n)) return n;
      for (var i = 0; i < n.kids.length; i++) {
        var r = findFirst(n.kids[i], pred);
        if (r) return r;
      }
    }
    return null;
  }

  function findAll(n, pred, out) {
    out = out || [];
    if (n.t === 'el') {
      if (pred(n)) out.push(n);
      for (var i = 0; i < n.kids.length; i++) findAll(n.kids[i], pred, out);
    }
    return out;
  }

  function plainText(n) {
    if (n.t === 'tx') return n.s;
    var s = '';
    for (var i = 0; i < n.kids.length; i++) s += plainText(n.kids[i]);
    return s;
  }

  function collapse(s) { return s.replace(/\s+/g, ' ').trim(); }

  // ---- language pickers ---------------------------------------------------
  var LANG_ATTR = /(^|[\s_-])(lang(uage)?s?[-_ ]?(select(or)?|switch(er)?|list|picker|menu|chooser|dropdown|nav|toggle|bar)|locale[-_ ]?(select(or)?|switch(er)?|picker)|gtranslate|goog-te|translate-widget)/i;
  var LANG_LABEL = /^(languages?|idiomas?|langues?|sprachen?|lingue|l[ií]nguas?|select (a )?language|choose (a )?language|change language|idioma|langue|sprache|lingua)\s*:?$/i;
  var LANG_NAMES = {};
  ('english|espa\u00f1ol|espanol|fran\u00e7ais|francais|deutsch|portugu\u00eas|portugues|italiano|nederlands|polski|t\u00fcrk\u00e7e|turkce|svenska|dansk|norsk|suomi|\u010de\u0161tina|magyar|rom\u00e2n\u0103|\u0440\u0443\u0441\u0441\u043a\u0438\u0439|\u0443\u043a\u0440\u0430\u0457\u043d\u0441\u044c\u043a\u0430|\u65e5\u672c\u8a9e|\u4e2d\u6587|\u7b80\u4f53\u4e2d\u6587|\u7e41\u9ad4\u4e2d\u6587|\ud55c\uad6d\uc5b4|\u0627\u0644\u0639\u0631\u0628\u064a\u0629|\u05e2\u05d1\u05e8\u05d9\u05ea|\u0939\u093f\u0928\u094d\u0926\u0940|\u0e44\u0e17\u0e22|ti\u1ebfng vi\u1ec7t|bahasa indonesia|bahasa melayu|\u03b5\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac|catal\u00e0|french|german|spanish|italian|portuguese|dutch|polish|russian|japanese|chinese|korean|arabic').split('|').forEach(function (x) { LANG_NAMES[x] = 1; });

  function anchorsOf(n) { return findAll(n, function (x) { return x.tag === 'a' && attr(x, 'href'); }); }

  function isLanguageList(n) {
    var t = n.tag;
    if (t !== 'ul' && t !== 'ol' && t !== 'div' && t !== 'nav' && t !== 'section' && t !== 'p' && t !== 'span') return false;
    if (LANG_ATTR.test(attr(n, 'id') + ' ' + attr(n, 'class'))) return true;
    var as = anchorsOf(n);
    if (as.length < 4 || as.length > 200) return false;
    var total = collapse(plainText(n)).length, inA = 0, langish = 0;
    for (var i = 0; i < as.length; i++) {
      var txt = collapse(plainText(as[i]));
      inA += txt.length;
      if (txt.length > 30) return false;
      var low = txt.toLowerCase();
      if (attr(as[i], 'hreflang') || attr(as[i], 'lang') || LANG_NAMES[low] || /^(en|es|fr|de|pt|it|nl|pl|ru|ja|zh|ko|ar|tr|sv|da|no|nb|fi|cs|hu|ro|uk|el|he|hi|th|vi|id|ms|ca)([-_][a-z]{2,4})?$/i.test(txt)) langish++;
    }
    return total > 0 && inA >= 0.8 * total && langish >= 0.75 * as.length;
  }

  // ---- accordions ---------------------------------------------------------
  // Buttons with aria-expanded/aria-controls (outside page chrome) head collapsed panels; the panel text is in the DOM
  // even when it is hidden, so we read it. Returns {buttons: Set(node), panels: {id:1}}.
  function findAccordions(tree) {
    var buttons = new Set(), panels = {};
    (function walk(n, inChrome) {
      if (n.t !== 'el') return;
      var chrome = inChrome || n.tag === 'nav' || n.tag === 'header' || n.tag === 'footer' || n.tag === 'aside' || n.tag === 'dialog' ||
        CHROME_ROLES.test(attr(n, 'role')) || NOISE_ATTR.test(attr(n, 'id') + ' ' + attr(n, 'class'));
      if (!chrome && (n.tag === 'button' || attr(n, 'role') === 'button') && (n.attrs['aria-expanded'] !== undefined || attr(n, 'aria-controls'))) {
        buttons.add(n);
        var ids = attr(n, 'aria-controls').split(/\s+/);
        for (var i = 0; i < ids.length; i++) if (ids[i]) panels[ids[i]] = 1;
      }
      for (var k = 0; k < n.kids.length; k++) walk(n.kids[k], chrome);
    })(tree, false);
    return { buttons: buttons, panels: panels };
  }

  // ---- cleaning -----------------------------------------------------------
  // strict=true drops page chrome (nav, aside, header/footer outside article/main, banners, ...).
  // acc = result of findAccordions (collapsed panels are kept, their buttons become headings).
  function clean(n, strict, insideMain, acc, parentTag) {
    if (n.t === 'tx') return n;
    var tag = n.tag;
    var isAccButton = acc && acc.buttons.has(n);
    var isPanel = acc && attr(n, 'id') && acc.panels[attr(n, 'id')] === 1;
    if (DROP_ALWAYS[tag] && !isAccButton) return null;
    if (isHidden(n) && !isPanel) return null;
    var inMain = insideMain || tag === 'main' || tag === 'article' || attr(n, 'role') === 'main';
    if (strict) {
      if (DROP_CHROME[tag]) return null;
      if ((tag === 'header' || tag === 'footer') && !inMain) return null;
      if (CHROME_ROLES.test(attr(n, 'role')) && !inMain) return null;
      if (NOISE_ATTR.test(attr(n, 'id') + ' ' + attr(n, 'class'))) return null;
    }
    if (isLanguageList(n)) return null;
    var outTag = tag, outAttrs = n.attrs;
    if (isAccButton) { outTag = /^h[1-6]$/.test(parentTag || '') ? 'span' : 'h3'; if (outTag === 'h3') outAttrs = { id: attr(n, 'id') }; }
    var kids = [];
    for (var i = 0; i < n.kids.length; i++) {
      var k = clean(n.kids[i], strict, inMain, acc, outTag);
      if (k) kids.push(k);
    }
    if (isPanel && n.attrs) { outAttrs = {}; for (var a in n.attrs) if (a !== 'hidden' && a !== 'style' && a !== 'aria-hidden') outAttrs[a] = n.attrs[a]; }
    if (/^h[1-6]$/.test(outTag) && LANG_LABEL.test(collapse(kids.map(plainText).join(' ')))) return null;
    return { t: 'el', tag: outTag, attrs: outAttrs, kids: kids };
  }

  // ---- container choice ---------------------------------------------------
  function pickRoot(body) {
    var lens = new Map();
    function len(n) {
      if (lens.has(n)) return lens.get(n);
      var l;
      if (n.t === 'tx') l = collapse(n.s).length;
      else { l = 0; for (var i = 0; i < n.kids.length; i++) l += len(n.kids[i]); }
      lens.set(n, l);
      return l;
    }
    var total = len(body);
    var cur = body;
    var mains = findAll(body, function (n) { return n.tag === 'main' || attr(n, 'role') === 'main'; });
    if (mains.length) {
      mains.sort(function (a, b) { return len(b) - len(a); });
      if (len(mains[0]) >= 0.4 * total) cur = mains[0];
    }
    if (cur === body) { // no usable <main>: prefer the largest <article> when it holds most of the text
      var arts = findAll(body, function (n) { return n.tag === 'article'; });
      if (arts.length) {
        arts.sort(function (a, b) { return len(b) - len(a); });
        if (len(arts[0]) >= 0.4 * total) cur = arts[0];
      }
    }
    // Descend while a single child holds most of the text, but never past a heading.
    for (var guard = 0; guard < 50; guard++) {
      var els = cur.kids.filter(function (k) { return k.t === 'el'; });
      var hasOwnHeading = els.some(function (k) { return /^h[1-6]$/.test(k.tag); });
      if (hasOwnHeading || !els.length) break;
      els.sort(function (a, b) { return len(b) - len(a); });
      if (len(els[0]) >= 0.7 * len(cur) && len(els[0]) > 0) cur = els[0]; else break;
    }
    return cur;
  }

  // ---- rendering ----------------------------------------------------------
  function slugify(s) {
    return collapse(s).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
  }
  function anchorOf(n) {
    var id = attr(n, 'id');
    if (id) return id;
    var inner = findFirst({ t: 'el', tag: 'x', attrs: {}, kids: n.kids }, function (x) { return x.tag !== 'x' && (attr(x, 'id') || (x.tag === 'a' && attr(x, 'name'))); });
    return inner ? (attr(inner, 'id') || attr(inner, 'name')) : '';
  }

  // Returns blocks: [{s, kind:'p'|'h'|'li'|'tr', level?, anchor?}]
  function renderBlocks(rootNode) {
    var out = []; // {s, kind}
    var curLevel = 0, curAnchor = '';
    var cur = '';
    var curKind = 'p';
    var inPre = 0;
    function flush() {
      var t;
      if (inPre) t = cur.replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
      else t = cur.replace(/[ \t\u00a0]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
      if (t && t !== '-' && t !== '|' && !/^#{1,6}$/.test(t)) {
        var b = { s: t, kind: curKind };
        if (curKind === 'h') { b.level = curLevel; b.anchor = curAnchor; }
        out.push(b);
      }
      cur = ''; curKind = 'p'; curLevel = 0; curAnchor = '';
    }
    function walk(n) {
      if (n.t === 'tx') { cur += inPre ? n.s : n.s.replace(/\s+/g, ' '); return; }
      var tag = n.tag;
      if (tag === 'br') { cur += '\n'; return; }
      if (tag === 'hr') { flush(); return; }
      var isBlock = BLOCK[tag] === 1;
      if (isBlock) flush();
      if (/^h[1-6]$/.test(tag)) { curKind = 'h'; curLevel = +tag[1]; curAnchor = anchorOf(n); cur = '######'.slice(0, +tag[1]) + ' '; }
      else if (tag === 'summary') { curKind = 'h'; curLevel = 3; curAnchor = anchorOf(n); cur = '### '; }
      else if (tag === 'li') { curKind = 'li'; cur = '- '; }
      else if (tag === 'tr') { curKind = 'tr'; }
      if (tag === 'pre') inPre++;
      for (var i = 0; i < n.kids.length; i++) {
        walk(n.kids[i]);
        if ((tag === 'tr') && n.kids[i].t === 'el' && (n.kids[i].tag === 'td' || n.kids[i].tag === 'th')) cur += ' | ';
      }
      if (tag === 'pre') inPre--;
      if (tag === 'tr') cur = cur.replace(/\s*\|\s*$/, '');
      if (isBlock) flush();
    }
    walk(rootNode);
    return out;
  }

  function joinBlocks(blocks) {
    var res = '';
    for (var i = 0; i < blocks.length; i++) {
      if (i > 0) {
        var joinTight = (blocks[i].kind === 'li' && blocks[i - 1].kind === 'li') || (blocks[i].kind === 'tr' && blocks[i - 1].kind === 'tr');
        res += joinTight ? '\n' : '\n\n';
      }
      res += blocks[i].s;
    }
    return res;
  }

  function render(rootNode) { return joinBlocks(renderBlocks(rootNode)); }

  // Split blocks into sections: [{heading, level, anchor, text}]. Text before the first heading has heading ''.
  // anchor = the element id (or <a name>) when the page has one, otherwise a slug of the heading (unique within the document).
  function buildSections(blocks) {
    var sections = [], cur = null, used = {};
    function open(heading, level, anchor) {
      var a = anchor || slugify(heading) || '';
      if (a) { var base = a, n = 2; while (used[a]) a = base + '-' + (n++); used[a] = 1; }
      cur = { heading: heading, level: level, anchor: a, anchor_from: anchor ? 'id' : 'heading', blocks: [] };
      sections.push(cur);
    }
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.kind === 'h') open(b.s.replace(/^#+\s*/, ''), b.level, b.anchor);
      else { if (!cur) open('', 0, ''); cur.blocks.push(b); }
    }
    return sections.map(function (s) {
      return { heading: s.heading, level: s.level, anchor: s.anchor, anchor_from: s.anchor_from, text: joinBlocks(s.blocks) };
    }).filter(function (s) { return s.heading || s.text; });
  }

  function htmlLang(tree) {
    var h = findFirst(tree, function (n) { return n.tag === 'html' && attr(n, 'lang'); });
    return h ? attr(h, 'lang').toLowerCase() : '';
  }

  // ---- public: extract ----------------------------------------------------
  // tree: the <html> (or any) element tree. Returns {text, title, h1, extractor, strict}
  function extractMainText(tree) {
    var titleEl = findFirst(tree, function (n) { return n.tag === 'title'; });
    var title = titleEl ? collapse(plainText(titleEl)) : '';
    var h1El = findFirst(tree, function (n) { return n.tag === 'h1' && !isHidden(n); });
    var h1 = h1El ? collapse(plainText(h1El)) : '';
    var bodyEl = findFirst(tree, function (n) { return n.tag === 'body'; }) || tree;

    var acc = findAccordions(bodyEl);
    var blocks = [], strictUsed = true;
    var cleaned = clean(bodyEl, true, false, acc, '');
    if (cleaned) blocks = renderBlocks(pickRoot(cleaned));
    var text = joinBlocks(blocks);
    if (text.length < 200) { // strict pass may have removed the document itself; retry leniently
      var lenient = clean(bodyEl, false, false, acc, '');
      var b2 = lenient ? renderBlocks(pickRoot(lenient)) : [];
      var t2 = joinBlocks(b2);
      if (t2.length > text.length) { text = t2; blocks = b2; strictUsed = false; }
    }
    return { text: text, title: title, h1: h1, extractor: EXTRACTOR_ID, strict: strictUsed, sections: buildSections(blocks), lang: htmlLang(tree) };
  }

  // ---- public: links ------------------------------------------------------
  // Returns [{text, href, region}] for every <a href> in the tree (not display:none).
  function collectLinks(tree) {
    var links = [];
    (function walk(n, region) {
      if (n.t !== 'el') return;
      if (isHidden(n)) return;
      var r = region;
      if (n.tag === 'footer' || attr(n, 'role') === 'contentinfo') r = 'footer';
      else if (n.tag === 'nav' && region !== 'footer') r = 'nav';
      else if (n.tag === 'header' && region === 'body') r = 'header';
      if (n.tag === 'a' && attr(n, 'href')) {
        var text = collapse(plainText(n)) || collapse(attr(n, 'aria-label')) || collapse(attr(n, 'title'));
        links.push({ text: text, href: attr(n, 'href'), region: r, hreflang: attr(n, 'hreflang') || attr(n, 'lang') || '' });
        return;
      }
      for (var i = 0; i < n.kids.length; i++) walk(n.kids[i], r);
    })(tree, 'body');
    return links;
  }

  return { extractMainText: extractMainText, collectLinks: collectLinks, EXTRACTOR_ID: EXTRACTOR_ID, isLanguageList: isLanguageList };
});
