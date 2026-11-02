/*
 * consent.js - finds the "I agree" moment on a page and the legal documents it asks you to agree to.
 * Works on the page tree used by core/extract.js ({t:'el',tag,attrs,kids} / {t:'tx',s}); pure, no DOM, no network.
 * It only READS. It never clicks Agree, never ticks a box and never touches the dialog: it returns plain data.
 *
 *   find(tree, baseUrl) -> { found, kind, buttons, links }
 *     found   true when an agree/consent dialog, banner, checkbox or "By clicking ... you agree to" sentence was found
 *             AND it links to at least one legal document
 *     kind    'dialog' | 'banner' | 'inline'
 *     buttons the labels of its agree-style buttons (text only, shortened), e.g. ['Agree']
 *     links   [{url, text, doc_type, language, non_english, is_pdf, score, confidence}] the documents it links to
 *             (terms, privacy, cookies, EULA, and other things being agreed to: guidelines, arbitration, subscription...)
 * Everything on the page is untrusted data. It is matched with fixed patterns and returned as plain strings.
 */
(function (root, factory) {
  var api;
  if (typeof module === 'object' && module.exports) api = factory(require('./detect.js'));
  else api = root.TCConsent = factory(root.TCDetect);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TCDetect) {
  'use strict';

  var MAX_CONTAINERS = 5, MAX_LINKS = 60, MAX_BUTTON = 40;

  // Agree-style button labels (English + the common European ones). Matched against the WHOLE label, so "Agree" and
  // "I agree" count but "Disagree" and "Agreement details" do not.
  var AGREE_BTN = /^(?:(?:yes|ok|okay)[,!. ]*)?(?:i\s+)?(?:agree|accept|consent|allow|continue|got it|understand|i understand|proceed|acepto|aceptar|accepter|j'accepte|akzeptieren|zustimmen|ich stimme zu|aceitar|aceito|accetto|accetta|einverstanden)(?:\s+(?:all|and\s+(?:continue|close|proceed)|&\s*(?:continue|close|proceed)|all cookies|cookies|and enter|to all))?\s*[.!>\u2192]*$/i;
  var NOT_AGREE = /\b(disagree|decline|reject|refuse|deny|no thanks|manage|settings|preferences|customi[sz]e|learn more|more options|do not)\b/i;
  var BY_AGREE = /\b(?:by|when you|if you|once you)\s+(?:clicking|continuing|using|tapping|selecting|pressing|signing|sign(?:ing)? up|creating|registering|submitting|checking|proceeding|accessing|logging|entering|visiting|browsing|subscribing|joining)\b[^]{0,260}?\b(?:you\s+)?(?:agree|accept|consent|acknowledge|are agreeing|are accepting|confirm|understand)/i;
  var HAVE_READ = /\bi\s+(?:have\s+read|agree|accept|acknowledge|consent|understand)\b[^]{0,120}\b(?:terms|privacy|policy|policies|agreement|conditions)\b/i;
  var LEGAL_PROMPT = /\b(?:legal terms(?: and| &)? privacy|terms (?:and|&) (?:privacy|conditions)|terms of (?:use|service)|privacy (?:policy|notice)|we use cookies|uses cookies|your privacy choices|cookie (?:policy|consent|preferences)|consent to|your consent)\b/i;
  var CONTAINER_HINT = /(?:consent|cookie|gdpr|ccpa|privacy[-_ ]?(?:banner|notice|popup|modal|dialog)|legal|terms|agree|agreement|onetrust|ot-sdk|cc[-_]window|cookiebanner|truste|didomi|usercentrics|sp[-_]message|modal|overlay|popup|banner|interstitial|\bgate\b|\bwall\b)/i;
  var EXTRA_DOC = /\b(terms|policy|policies|agreement|guidelines|conditions|notice|rules|licen[cs]e|code of conduct)\b/i;
  var COOKIE_WORDS = /cookie|consent|gdpr|tracking|personali[sz]/i;

  function attr(n, k) { return n.attrs ? (n.attrs[k] || '') : ''; }
  function hidden(n) {
    if (!n || n.t !== 'el') return false;
    if (n.attrs.hidden !== undefined) return true;
    if (/^true$/i.test(attr(n, 'aria-hidden'))) return true;
    var st = attr(n, 'style');
    return !!st && (/display\s*:\s*none/i.test(st) || /visibility\s*:\s*hidden/i.test(st));
  }
  function text(n) {
    if (n.t === 'tx') return n.s;
    if (hidden(n) || n.tag === 'script' || n.tag === 'style' || n.tag === 'noscript' || n.tag === 'template') return '';
    var out = '';
    for (var i = 0; i < n.kids.length; i++) out += text(n.kids[i]) + (n.kids[i].t === 'el' && /^(p|div|li|h[1-6]|br|section|label|button|tr)$/.test(n.kids[i].tag) ? ' ' : '');
    return out;
  }
  function collapse(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function walk(n, fn) { if (!n || n.t !== 'el') return; if (fn(n) === false) return; for (var i = 0; i < n.kids.length; i++) walk(n.kids[i], fn); }

  function fixedPos(n) { return /^(fixed|sticky)$/.test(attr(n, 'data-tc-pos')) || /position\s*:\s*(fixed|sticky)/i.test(attr(n, 'style')); }

  function isCandidate(n) {
    if (n.tag === 'body' || n.tag === 'html' || n.tag === 'head' || n.tag === 'main' || n.tag === 'a' || n.tag === 'button') return false;
    if (hidden(n)) return false;
    if (n.tag === 'dialog' || /^(alert)?dialog$/i.test(attr(n, 'role')) || /^true$/i.test(attr(n, 'aria-modal'))) return true;
    if (fixedPos(n)) return true;
    return CONTAINER_HINT.test(attr(n, 'id') + ' ' + attr(n, 'class')) && /^(div|section|aside|form|dialog|aside|footer|header|span)$/.test(n.tag);
  }

  function buttonLabel(n) {
    if (n.tag === 'input') return collapse(attr(n, 'value') || attr(n, 'aria-label'));
    return collapse(text(n)) || collapse(attr(n, 'aria-label')) || collapse(attr(n, 'title'));
  }

  function agreeButtons(root) {
    var out = [];
    walk(root, function (n) {
      if (hidden(n)) return false;
      var isBtn = n.tag === 'button' || (n.tag === 'input' && /^(submit|button)$/i.test(attr(n, 'type'))) || /^button$/i.test(attr(n, 'role')) ||
        (n.tag === 'a' && /\b(btn|button)\b/i.test(attr(n, 'class')));
      if (!isBtn) return;
      var label = buttonLabel(n);
      if (label && label.length <= MAX_BUTTON && !NOT_AGREE.test(label) && AGREE_BTN.test(label)) out.push(label);
      return false;
    });
    return out;
  }

  // checkbox whose label says "I have read / I agree ... terms"
  function agreeCheckbox(root) {
    var found = false;
    function labelText(label) { return collapse(text(label)); }
    walk(root, function (n) {
      if (found) return false;
      if (n.tag === 'label') {
        var hasBox = false;
        walk(n, function (m) { if (m.tag === 'input' && /^checkbox$/i.test(attr(m, 'type'))) hasBox = true; });
        if (hasBox && HAVE_READ.test(labelText(n))) found = true;
      }
    });
    if (found) return true;
    // <input type=checkbox id=x> <label for=x>
    var ids = {};
    walk(root, function (n) { if (n.tag === 'input' && /^checkbox$/i.test(attr(n, 'type')) && attr(n, 'id')) ids[attr(n, 'id')] = 1; });
    walk(root, function (n) { if (!found && n.tag === 'label' && ids[attr(n, 'for')] && HAVE_READ.test(labelText(n))) found = true; });
    return found;
  }

  function docLinks(root, baseUrl) {
    var self = ''; try { self = new URL(baseUrl).href.split('#')[0]; } catch (e) {}
    var out = [];
    walk(root, function (n) {
      if (hidden(n) || out.length >= MAX_LINKS) return false;
      if (n.tag !== 'a' || !attr(n, 'href')) return;
      var l = { text: collapse(text(n)) || collapse(attr(n, 'aria-label')) || collapse(attr(n, 'title')), href: attr(n, 'href'), hreflang: attr(n, 'hreflang') || attr(n, 'lang'), region: 'dialog' };
      var c = TCDetect.classifyLink(l, baseUrl);
      if (!c && l.text && l.text.length <= 80 && EXTRA_DOC.test(l.text) && !NOT_AGREE.test(l.text)) {
        try {
          var abs = new URL(l.href, baseUrl);
          if (/^https?:$/.test(abs.protocol)) {
            c = { url: abs.href.split('#')[0], text: l.text, doc_type: 'other', score: 2, confidence: 'medium', region: 'dialog', language: 'en', non_english: false, is_pdf: /\.pdf$/i.test(abs.pathname), reasons: ['linked from the agree dialog'] };
          }
        } catch (e) { /* skip */ }
      }
      if (c && c.url !== self) { c.region = 'dialog'; out.push(c); }
      return false;
    });
    return out;
  }

  function analyzeContainer(n, baseUrl) {
    var t = collapse(text(n));
    if (!t || t.length > 6000) return null;
    var buttons = agreeButtons(n), box = agreeCheckbox(n);
    var phrase = BY_AGREE.test(t) || HAVE_READ.test(t);   // a plain list of footer links is NOT an agree prompt
    var links = docLinks(n, baseUrl);
    if (!links.length) return null;
    if (!buttons.length && !box && !phrase) return null;
    var score = (buttons.length ? 3 : 0) + (box ? 2 : 0) + (BY_AGREE.test(t) || HAVE_READ.test(t) ? 2 : 0) + (LEGAL_PROMPT.test(t) ? 1 : 0) + Math.min(links.length, 4);
    var hasTerms = links.some(function (l) { return l.doc_type === 'tos' || l.doc_type === 'eula'; });
    var modal = n.tag === 'dialog' || /dialog/i.test(attr(n, 'role')) || /^true$/i.test(attr(n, 'aria-modal')) || fixedPos(n);
    var kind = !hasTerms && COOKIE_WORDS.test(t + ' ' + attr(n, 'id') + ' ' + attr(n, 'class')) ? 'banner' : modal ? 'dialog' : 'banner';
    return { node: n, links: links, buttons: buttons, score: score, kind: kind, len: t.length };
  }

  function contains(a, b) { // a is an ancestor of b
    var yes = false;
    walk(a, function (n) { if (n === b && a !== b) yes = true; return !yes; });
    return yes;
  }

  function find(tree, baseUrl) {
    var res = { found: false, kind: null, buttons: [], links: [] };
    if (!tree || tree.t !== 'el') return res;
    var cands = [];
    walk(tree, function (n) {
      if (hidden(n)) return false;
      if (isCandidate(n)) { var c = analyzeContainer(n, baseUrl); if (c) cands.push(c); }
    });
    // inline "By signing up you agree to our Terms and Privacy Policy" lines, only when no dialog/banner explains it
    if (!cands.length) {
      walk(tree, function (n) {
        if (hidden(n)) return false;
        if (!/^(p|label|small|span|div|li|form|section)$/.test(n.tag)) return;
        var t = collapse(text(n));
        if (!t || t.length > 420 || !(BY_AGREE.test(t) || HAVE_READ.test(t))) return;
        var c = analyzeContainer(n, baseUrl);
        if (c) { c.kind = 'inline'; cands.push(c); }
      });
    }
    // A banner with no id/class hint and no fixed position (typical when the banner is a page of its own inside an iframe, as on
    // dropbox.com): accept a SHORT block that says it uses cookies / names the terms, has an agree-style button, and links to a document.
    if (!cands.length) {
      walk(tree, function (n) {
        if (hidden(n)) return false;
        if (!/^(div|section|aside|form|footer|main|article)$/.test(n.tag)) return;
        var t = collapse(text(n));
        if (!t || t.length > 1200 || !LEGAL_PROMPT.test(t)) return;
        var c = analyzeContainer(n, baseUrl);
        if (c && c.buttons.length) { c.kind = COOKIE_WORDS.test(t) ? 'banner' : c.kind; cands.push(c); }
      });
    }
    if (!cands.length) return res;
    // keep the innermost qualifying containers (an outer wrapper that merely holds an inner one is dropped)
    var inner = cands.filter(function (c) { return !cands.some(function (o) { return o !== c && contains(c.node, o.node); }); });
    inner.sort(function (a, b) { return b.score - a.score || a.len - b.len; });
    inner = inner.slice(0, MAX_CONTAINERS);
    var seen = {}, links = [], buttons = [];
    inner.forEach(function (c) {
      c.links.forEach(function (l) { if (!seen[l.url]) { seen[l.url] = 1; links.push(l); } });
      c.buttons.forEach(function (b) { if (buttons.indexOf(b) < 0) buttons.push(b); });
    });
    res.found = true; res.kind = inner[0].kind; res.buttons = buttons.slice(0, 4); res.links = links;
    return res;
  }

  return { find: find, AGREE_BTN: AGREE_BTN, BY_AGREE: BY_AGREE };
});
