/*
 * domparse.js - turns the HTML of a fetched legal document into the same inert tree the extractor already reads.
 *
 * DOMParser('text/html') builds a DETACHED document: its scripts never run, its images/styles/frames never load,
 * event-handler attributes never fire, and nothing is ever attached to this page. Only a few whitelisted attributes
 * are copied into the plain-object tree; the extractor then reads strings out of it. Everything in the result is
 * untrusted text. This file is extension-only (the Node tests use cli/src/htmltree.js for the same job).
 */
(function (root) {
  'use strict';
  var KEEP = ['id', 'class', 'role', 'href', 'title', 'aria-label', 'aria-hidden', 'aria-expanded', 'aria-controls', 'hreflang', 'lang', 'name', 'style', 'type', 'aria-modal', 'open', 'for', 'value'];

  function toTree(node, depth, budget) {
    if (node.nodeType === 3) return { t: 'tx', s: node.nodeValue || '' };
    if (node.nodeType !== 1 || depth > 200 || budget.n-- <= 0) return null;
    var tag = node.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return { t: 'el', tag: tag, attrs: { hidden: '1' }, kids: [] };
    var attrs = {};
    KEEP.forEach(function (k) {
      var v = node.getAttribute(k);
      if (v !== null && v !== undefined) attrs[k] = v;
    });
    if (node.hasAttribute('hidden')) attrs.hidden = '1';
    var kids = [];
    if (attrs.hidden === undefined) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        var k2 = toTree(c, depth + 1, budget);
        if (k2) kids.push(k2);
      }
    }
    return { t: 'el', tag: tag, attrs: attrs, kids: kids };
  }

  function parseHtml(html) {
    var doc = new DOMParser().parseFromString(String(html), 'text/html');
    return toTree(doc.documentElement, 0, { n: 200000 }) || { t: 'el', tag: 'html', attrs: {}, kids: [] };
  }

  root.TCDomParse = { parseHtml: parseHtml };
})(typeof globalThis !== 'undefined' ? globalThis : this);
