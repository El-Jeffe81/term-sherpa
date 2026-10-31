/*
 * content/run.js - injected ONLY when the user clicks "Please help me"
 * (chrome.scripting.executeScript under activeTab). It is NOT declared in the
 * manifest. It reads the page the user is looking at, returns a result object
 * on globalThis.__tcResult for the popup to pick up, and sends nothing anywhere.
 *
 * Needs core/untrusted.js, core/extract.js and core/detect.js injected first.
 * Options come from globalThis.__tcOptions = { pickedType } (pickedType is set only when the user explicitly picked
 * this page's URL from the detected-links list).
 *
 * What it returns: the page's text ONLY when the page itself is a terms/privacy/EULA/cookie document (or the user
 * picked it) and is not an account/checkout-style page. Otherwise: just the detected legal links (text + URL).
 * Collapsed sections (details/summary, aria-expanded accordions) are read from the DOM without clicking anything.
 */
(function () {
  'use strict';
  var opts = globalThis.__tcOptions || {};
  delete globalThis.__tcOptions;

  // Panels controlled by aria-expanded/aria-controls buttons (accordions) are read even when collapsed/hidden.
  var panelIds = {};
  try {
    var ctrls = document.querySelectorAll('[aria-controls][aria-expanded]');
    for (var ci = 0; ci < ctrls.length; ci++) {
      if (ctrls[ci].closest('nav, header, footer, aside, dialog, [role=navigation], [role=banner], [role=contentinfo], [role=dialog], [role=alertdialog]')) continue;
      ctrls[ci].getAttribute('aria-controls').split(/\s+/).forEach(function (id) { if (id) panelIds[id] = 1; });
    }
  } catch (e) { /* ignore */ }

  function domToTree(el, depth, budget, inPanel) {
    if (el.nodeType === 3) return { t: 'tx', s: el.nodeValue || '' };
    if (el.nodeType !== 1 || depth > 200 || budget.n-- <= 0) return null;
    var tag = el.tagName.toLowerCase();
    var attrs = {};
    ['id', 'class', 'role', 'href', 'title', 'aria-label', 'aria-hidden', 'aria-expanded', 'aria-controls', 'hreflang', 'lang', 'name', 'style'].forEach(function (k) {
      var v = el.getAttribute && el.getAttribute(k);
      if (v !== null && v !== undefined) attrs[k] = v;
    });
    if (el.hidden) attrs.hidden = '1';
    var isPanel = !!(el.id && panelIds[el.id]);
    // Treat elements the browser is not displaying as hidden (e.g. closed menus, modals). Accordion panels are read anyway.
    if (tag !== 'html' && tag !== 'body' && tag !== 'head' && !inPanel) {
      try {
        var cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') attrs.hidden = '1';
      } catch (e) { /* ignore */ }
    }
    var kids = [];
    if (attrs.hidden === undefined || isPanel) {
      for (var c = el.firstChild; c; c = c.nextSibling) {
        var k = domToTree(c, depth + 1, budget, inPanel || isPanel);
        if (k) kids.push(k);
      }
    }
    return { t: 'el', tag: tag, attrs: attrs, kids: kids };
  }

  var S = TCUntrusted.sanitizeText;
  var isPdf = /^application\/pdf/i.test(document.contentType || '') || /\.pdf$/i.test(location.pathname);
  var result = { ok: true, page: { title: S(document.title || '') }, links: [], extracted: null };
  try {
    if (isPdf) {
      // Nothing is read from a PDF here; the popup records only that a PDF exists and needs the pdftotext partner.
      var g = TCDetect.classifyLink({ href: location.href, text: '' }, location.href);
      result.page.is_pdf = true;
      result.page.pdf_doc_type = g ? g.doc_type : null;
      result.page.url = location.href;
      globalThis.__tcResult = result;
      return;
    }
    var tree = domToTree(document.documentElement, 0, { n: 200000 }, false);
    var ex = TCExtract.extractMainText(tree);
    var links = TCDetect.findLegalLinks(TCExtract.collectLinks(tree), location.href);
    var cls = TCDetect.classifyPage({ url: location.href, title: ex.title, h1: ex.h1, textLength: ex.text.length, links: links });
    result.page.url = location.href;
    result.page.looks_like_terms = cls.isTerms;
    result.page.is_hub = !!cls.isHub;
    result.page.sensitive = !!cls.sensitive;
    result.page.doc_type = cls.doc_type;
    result.links = links.map(function (l) {
      return { url: l.url, text: S(l.text), doc_type: l.doc_type, confidence: l.confidence, language: l.language, is_pdf: l.is_pdf };
    });

    // Text leaves this function ONLY for a real terms page, or one whose URL the user picked from the link list.
    // Never for a legal hub, and never for an account/checkout/payment-style page.
    var picked = !!opts.pickedType && !cls.sensitive && !cls.isHub;
    var wantText = (cls.isTerms && !cls.isHub) || picked;
    if (wantText) {
      var sections = (ex.sections || []).map(function (x) {
        return { heading: S(x.heading), level: x.level, anchor: S(x.anchor), anchor_from: x.anchor_from, text: S(x.text) };
      });
      result.extracted = {
        url: location.href,
        title: S(ex.title),
        doc_type: cls.isTerms ? cls.doc_type : opts.pickedType,
        discovered_via: cls.isTerms ? 'user_page' : 'user_picked_link',
        text: S(ex.text),
        sections: sections,
        lang: ex.lang || '',
        extractor: ex.extractor
      };
    }
  } catch (e) {
    result = { ok: false, error: String(e && e.message || e) };
  }
  globalThis.__tcResult = result;
})();
