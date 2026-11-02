/*
 * detect.js - find terms / privacy / EULA / cookie links, and decide whether
 * the current page IS such a document. Heuristics only (not a standard);
 * the user always confirms. English plus es/fr/de/pt/it link patterns (a language tag is returned with every link).
 * Nothing here fetches anything: "common paths" are only matched against
 * links that already exist on the page. We never guess-crawl.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCDetect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DOC_TYPES = ['tos', 'privacy', 'eula', 'cookies', 'other'];

  // Link text patterns (checked against the visible link text).
  var TEXT_PATTERNS = [
    ['eula', /\beula\b|end[-\s]?user licen[sc]e|software licen[sc]e agreement|licen[sc]e agreement/i],
    ['cookies', /\bcookies?\b/i],
    ['privacy', /\bprivacy\b|data protection|\bGDPR\b|personal (data|information)/i],
    ['tos', /\bterms\b|\bT&C(s)?\b|\bTOS\b|\bT&amp;C\b|user agreement|service agreement|conditions of (use|sale|service)|acceptable use/i],
    ['other', /^\s*legal(\s+(notice|information|terms|center|centre))?\s*$|legal notice|imprint/i]
  ];

  // Href patterns (path segments, not substrings of arbitrary words).
  var HREF_PATTERNS = [
    ['eula', /\/(eula|end-user-licen[sc]e[a-z-]*|licen[sc]e-agreement)(\/|\.html?|\.pdf|$)/i],
    ['cookies', /\/cookies?([-_](policy|notice|statement|settings))?(\/|\.html?|\.pdf|$)/i],
    ['privacy', /\/(privacy([-_](policy|notice|statement|center|centre))?|privacypolicy|data-protection|datenschutz)(\/|\.html?|\.pdf|$)/i],
    ['tos', /\/(terms([-_](of[-_](service|use|sale)|and[-_]conditions|conditions))?|tos|tnc|t-and-c|conditions(-of-use)?|user-agreement|terms_of_service|termsofservice|termsofuse|services?-?agreement)(\/|\.html?|\.pdf|$)/i],
    ['other', /\/(legal|imprint|legal-notice)(\/|\.html?|\.pdf|$)/i]
  ];

  // Exact, very common paths (higher confidence when a link points at exactly one).
  var COMMON_PATHS = {
    '/terms': 'tos', '/tos': 'tos', '/terms-of-service': 'tos', '/terms-of-use': 'tos',
    '/terms-and-conditions': 'tos', '/legal/terms': 'tos', '/legal/terms-of-service': 'tos',
    '/privacy': 'privacy', '/privacy-policy': 'privacy', '/legal/privacy': 'privacy',
    '/privacy-notice': 'privacy',
    '/cookies': 'cookies', '/cookie-policy': 'cookies', '/legal/cookies': 'cookies',
    '/eula': 'eula', '/legal': 'other'
  };

  // ---- non-English patterns (Spanish, French, German, Portuguese, Italian) --------------------------------
  // [lang, type, regex on link text]. No \b around accented letters (JS \b is ASCII only).
  var TEXT_I18N = [
    ['es', 'eula', /acuerdo de licencia|licencia de usuario final|contrato de licencia/i],
    ['es', 'cookies', /pol[i\u00ed]tica de cookies|aviso de cookies|uso de cookies|\bcookies\b/i],
    ['es', 'privacy', /privacidad\b|protecci[o\u00f3]n de datos|datos personales/i],
    ['es', 'tos', /t[e\u00e9]rminos y condiciones|t[e\u00e9]rminos de (uso|servicio)|condiciones (de uso|generales|del servicio)|t[e\u00e9]rminos legales|\bt[e\u00e9]rminos\b/i],
    ['es', 'other', /aviso legal|informaci[o\u00f3]n legal|^\s*legal\s*$/i],
    ['fr', 'eula', /contrat de licence|licence utilisateur final|accord de licence/i],
    ['fr', 'cookies', /politique (relative aux|de|des) cookies|gestion des cookies|\bcookies\b/i],
    ['fr', 'privacy', /confidentialit[e\u00e9]|vie priv[e\u00e9]e|protection des donn[e\u00e9]es|donn[e\u00e9]es personnelles/i],
    ['fr', 'tos', /conditions g[e\u00e9]n[e\u00e9]rales|conditions d['\u2019 ]utilisation|\bCGU\b|\bCGV\b|conditions de (vente|service)|termes et conditions|termes d['\u2019 ]utilisation/i],
    ['fr', 'other', /mentions l[e\u00e9]gales|informations l[e\u00e9]gales|^\s*l[e\u00e9]gal\s*$/i],
    ['de', 'eula', /endbenutzer-?lizenz|lizenzvereinbarung|lizenzbedingungen/i],
    ['de', 'cookies', /cookie-?(richtlinie|hinweis|einstellungen|policy)|cookies?\b/i],
    ['de', 'privacy', /datenschutz|privatsph[a\u00e4]re/i],
    ['de', 'tos', /nutzungsbedingungen|allgemeine gesch[a\u00e4]ftsbedingungen|\bAGB\b|gesch[a\u00e4]ftsbedingungen|nutzerbedingungen|verkaufsbedingungen/i],
    ['de', 'other', /impressum|rechtliche hinweise|rechtliches/i],
    ['pt', 'eula', /contrato de licen[c\u00e7]a|licen[c\u00e7]a de usu[a\u00e1]rio final|acordo de licen[c\u00e7]a/i],
    ['pt', 'cookies', /pol[i\u00ed]tica de cookies|aviso de cookies|\bcookies\b/i],
    ['pt', 'privacy', /privacidade|prote[c\u00e7][a\u00e3]o de dados|dados pessoais/i],
    ['pt', 'tos', /termos e condi[c\u00e7][o\u00f5]es|termos de (uso|servi[c\u00e7]o)|condi[c\u00e7][o\u00f5]es (gerais|de uso)|\btermos\b/i],
    ['pt', 'other', /aviso legal|informa[c\u00e7][o\u00f5]es legais|^\s*legal\s*$/i],
    ['it', 'eula', /contratto di licenza|licenza per l['\u2019 ]utente finale|accordo di licenza/i],
    ['it', 'cookies', /(politica|informativa) (sui|sulla|dei|sull['\u2019 ]uso dei) cookie|\bcookie\b/i],
    ['it', 'privacy', /informativa (sulla )?privacy|riservatezza|protezione dei dati|dati personali/i],
    ['it', 'tos', /termini e condizioni|termini di (servizio|utilizzo|uso)|condizioni (generali|d['\u2019 ]uso|di (vendita|servizio))|\btermini\b/i],
    ['it', 'other', /note legali|avvertenze legali|informazioni legali|^\s*legale\s*$/i]
  ];

  // [lang, type, regex on the URL path].
  var HREF_I18N = [
    ['es', 'tos', /\/(terminos([-_](y[-_]condiciones|de[-_](uso|servicio)|legales))?|condiciones([-_](de[-_]uso|generales))?)(\/|\.html?|\.pdf|$)/i],
    ['es', 'privacy', /\/(privacidad|politica[-_]de[-_]privacidad|aviso[-_]de[-_]privacidad|proteccion[-_]de[-_]datos)(\/|\.html?|\.pdf|$)/i],
    ['es', 'cookies', /\/(politica[-_]de[-_]cookies|cookies)(\/|\.html?|\.pdf|$)/i],
    ['es', 'other', /\/aviso[-_]legal(\/|\.html?|\.pdf|$)/i],
    ['fr', 'tos', /\/(cgu|cgv|conditions[-_]generales([-_]d[-_]?(utilisation|vente))?|conditions[-_]d[-_]utilisation|termes[-_]et[-_]conditions)(\/|\.html?|\.pdf|$)/i],
    ['fr', 'privacy', /\/(confidentialite|politique[-_]de[-_]confidentialite|vie[-_]privee|protection[-_]des[-_]donnees)(\/|\.html?|\.pdf|$)/i],
    ['fr', 'cookies', /\/(politique[-_](relative[-_]aux|de)[-_]cookies|gestion[-_]des[-_]cookies)(\/|\.html?|\.pdf|$)/i],
    ['fr', 'other', /\/mentions[-_]legales(\/|\.html?|\.pdf|$)/i],
    ['de', 'tos', /\/(nutzungsbedingungen|agb|allgemeine[-_]geschaeftsbedingungen|geschaeftsbedingungen|nutzerbedingungen)(\/|\.html?|\.pdf|$)/i],
    ['de', 'privacy', /\/(datenschutz(erklaerung|richtlinie|bestimmungen)?|privatsphaere)(\/|\.html?|\.pdf|$)/i],
    ['de', 'cookies', /\/cookie[-_](richtlinie|hinweis|einstellungen)(\/|\.html?|\.pdf|$)/i],
    ['de', 'other', /\/(impressum|rechtliches|rechtliche[-_]hinweise)(\/|\.html?|\.pdf|$)/i],
    ['pt', 'tos', /\/(termos([-_](e[-_]condicoes|de[-_](uso|servico)))?|condicoes[-_]gerais)(\/|\.html?|\.pdf|$)/i],
    ['pt', 'privacy', /\/(privacidade|politica[-_]de[-_]privacidade|protecao[-_]de[-_]dados)(\/|\.html?|\.pdf|$)/i],
    ['pt', 'cookies', /\/politica[-_]de[-_]cookies(\/|\.html?|\.pdf|$)/i],
    ['it', 'tos', /\/(termini([-_](e[-_]condizioni|di[-_](servizio|utilizzo|uso)))?|condizioni[-_](generali|d[-_]uso|di[-_]vendita))(\/|\.html?|\.pdf|$)/i],
    ['it', 'privacy', /\/(informativa[-_](sulla[-_])?privacy|privacy|protezione[-_]dei[-_]dati)(\/|\.html?|\.pdf|$)/i],
    ['it', 'cookies', /\/(cookie[-_]policy|politica[-_](sui|dei)[-_]cookie|informativa[-_]cookie)(\/|\.html?|\.pdf|$)/i],
    ['it', 'other', /\/note[-_]legali(\/|\.html?|\.pdf|$)/i]
  ];

  var LANG_PATH_PREFIX = /^\/(en|es|fr|de|pt|it)([-_][a-z]{2})?(\/|$)/i;
  var LANGS = ['en', 'es', 'fr', 'de', 'pt', 'it'];
  var SENSITIVE_PATH = /(^|\/)(account|accounts|my-account|myaccount|checkout|cart|basket|payment|payments|billing|login|log-in|signin|sign-in|signup|password|reset|inbox|mail|messages?|profile|settings|orders?|admin|dashboard|portal|banking|wallet|patient|claims?|invoices?|subscriptions?|statements?)(\/|$)/i;

  // Stricter patterns for page title / h1 (so "Sign up - terms apply" does not count).
  var TITLE_PATTERNS = [
    ['eula', /\beula\b|end[-\s]?user licen[sc]e|licen[sc]e agreement/i],
    ['cookies', /cookie (policy|notice|statement)|use of cookies/i],
    ['privacy', /privacy (policy|notice|statement)|data protection (policy|notice)|privacy and cookie/i],
    ['tos', /terms (of (service|use|sale)|and conditions|& conditions)|terms ?& ?conditions|conditions of use|user agreement|(services?|customer|subscriber|master) agreement|\bterms$/i]
  ];

  // Links into news/blog-style sections are articles ABOUT privacy/terms, not the documents.
  var NEGATIVE_PATH = /\/(news|blog|blogs|article|articles|press|posts?|stories|story|events?|careers?|jobs)\//i;

  // The page itself (not a link) sits in an encyclopedia/news/blog-style place, or has a headline instead of a document title:
  // an ARTICLE ABOUT terms ("Instagram changes its Terms of Service", Wikipedia's "Terms of service"), not the terms.
  var ARTICLE_PATH = /(^|\/)(wiki|news|blog|blogs|press|posts?|stories|story|magazine)(\/|$)|\/(19|20)\d\d\/\d{1,2}(\/|$)/i;
  // ...unless the address ends in a plain legal page name ("/news/terms", "/press/privacy-policy"): that is the site's own terms page.
  // (Never for wiki or dated addresses, where the same words name an article.)
  var ARTICLE_STRICT = /(^|\/)wiki(\/|$)|\/(19|20)\d\d\/\d{1,2}(\/|$)/i;
  var LEGAL_LEAF = /\/(terms|terms-(of|and)-(service|use|conditions?)|terms-conditions|tos|privacy|privacy-(policy|notice|statement)|cookies?|cookie-(policy|notice)|legal)\/?$/i;
  function articlePath(p) { return ARTICLE_PATH.test(p) && (ARTICLE_STRICT.test(p) || !LEGAL_LEAF.test(p)); }
  var MAX_TITLE_WORDS = 9;
  function headlineLike(s) {
    var first = String(s || '').split(/\s[-\u2013\u2014|:\u00b7]\s/)[0].trim();
    return first.split(/\s+/).filter(Boolean).length > MAX_TITLE_WORDS;
  }

  var MIN_TEXT_FOR_PATH_MATCH = 500;
  var MIN_TEXT_FOR_TITLE_MATCH = 1500;
  var THIN_TITLE_TEXT = 300;

  function pathOf(u) { try { return new URL(u).pathname.replace(/\/+$/, '').toLowerCase() || '/'; } catch (e) { return ''; } }

  var DISTINCT_NON_EN = /informativa|\bsulla\b|politique|confidentialit|vie priv|datenschutz|privacidad|privacidade|t[e\u00e9]rminos|condiciones|nutzungsbedingungen|\btermos\b|\btermini\b|riservatezza|mentions l[e\u00e9]gales|\bdatos\b|\bdados\b/i;

  function firstMatch(table, s) {
    for (var i = 0; i < table.length; i++) if (table[i][1].test(s)) return table[i][0];
    return null;
  }

  // Classify one link. Returns null if it does not look like a legal document link.
  function classifyLink(link, baseUrl) {
    var abs;
    try { abs = new URL(link.href, baseUrl); } catch (e) { return null; }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
    var text = (link.text || '').replace(/\s+/g, ' ').trim();
    if (text.length > 80) return null; // article headlines etc.

    var reasons = [], score = 0, types = {};
    var tText = text ? firstMatch(TEXT_PATTERNS, text) : null;
    // An Italian/French/Spanish/... phrase can contain an English word ("Informativa sulla privacy"): when the text has a
    // distinctly non-English word and a translated pattern matches, classify it as translated instead of English.
    if (tText && DISTINCT_NON_EN.test(text) && TEXT_I18N.some(function (t) { return t[1] !== 'other' && t[2].test(text); })) tText = null;
    if (tText) {
      // "Terms & Privacy" style combined links: ambiguous
      var both = /\bterms\b|\bT&C/i.test(text) && /\bprivacy\b/i.test(text);
      types[both ? 'other' : tText] = (types[both ? 'other' : tText] || 0) + 2;
      score += 2; reasons.push('link text');
    }
    var pathname = abs.pathname.toLowerCase();
    if (NEGATIVE_PATH.test(pathname)) return null;
    var tHref = firstMatch(HREF_PATTERNS, pathname);
    if (tHref) { types[tHref] = (types[tHref] || 0) + 1; score += 1; reasons.push('href pattern'); }
    var norm = pathname.replace(/\/+$/, '') || '/';
    if (COMMON_PATHS[norm]) { types[COMMON_PATHS[norm]] = (types[COMMON_PATHS[norm]] || 0) + 1; score += 1; reasons.push('common path'); }
    // non-English patterns (a link can match English and a translated pattern; English wins ties)
    var lang = '';
    if (!score || !tText) {
      // Several languages can match one text (pt "privacidade" vs es "privacidad"): prefer the declared hreflang, then the
      // URL's /xx/ prefix, then the first match in table order.
      var hits = [];
      for (var ti = 0; ti < TEXT_I18N.length && text; ti++) if (TEXT_I18N[ti][2].test(text)) hits.push(TEXT_I18N[ti]);
      if (hits.length) {
        var decl0 = String(link.hreflang || '').toLowerCase().split(/[-_]/)[0];
        var pre0 = LANG_PATH_PREFIX.exec(pathname);
        var pick = hits[0];
        var pref = [decl0, pre0 ? pre0[1].toLowerCase() : ''];
        for (var pi = 0; pi < pref.length; pi++) {
          var m = hits.filter(function (h) { return h[0] === pref[pi]; })[0];
          if (m) { pick = m; break; }
        }
        lang = pick[0]; types[pick[1]] = (types[pick[1]] || 0) + 2; score += 2; reasons.push('link text (' + lang + ')');
      }
      for (var hi = 0; !tHref && hi < HREF_I18N.length; hi++) {
        if (HREF_I18N[hi][2].test(pathname)) {
          if (!lang) lang = HREF_I18N[hi][0];
          if (HREF_I18N[hi][0] === lang) { types[HREF_I18N[hi][1]] = (types[HREF_I18N[hi][1]] || 0) + 1; score += 1; reasons.push('href pattern (' + lang + ')'); break; }
        }
      }
    }
    if (!score) return null;
    var declared = String(link.hreflang || '').toLowerCase().split(/[-_]/)[0];
    var prefix = LANG_PATH_PREFIX.exec(pathname);
    var language = lang || (declared && LANGS.indexOf(declared) !== -1 ? declared : (prefix ? prefix[1].toLowerCase() : 'en'));
    if (lang && declared && LANGS.indexOf(declared) !== -1) language = declared;
    var isPdf = /\.pdf$/i.test(pathname) || /\(pdf\)|\bpdf\b/i.test(text);

    var best = null, bestN = -1;
    Object.keys(types).forEach(function (k) { if (types[k] > bestN) { best = k; bestN = types[k]; } });
    if (link.region === 'footer') { score += 1; reasons.push('footer'); }
    return {
      url: abs.href.split('#')[0],
      text: text,
      doc_type: best,
      score: score,
      confidence: score >= 4 ? 'high' : score >= 3 ? 'medium' : 'low',
      region: link.region || 'body',
      language: language,
      non_english: language !== 'en',
      is_pdf: isPdf,
      reasons: reasons
    };
  }

  // Classify + de-duplicate a list of {text, href, region}. Skips links to the page itself.
  function findLegalLinks(rawLinks, baseUrl) {
    var self = '';
    try { self = new URL(baseUrl).href.split('#')[0]; } catch (e) {}
    var byUrl = new Map();
    rawLinks.forEach(function (l) {
      var c = classifyLink(l, baseUrl);
      if (!c || c.url === self) return;
      var prev = byUrl.get(c.url);
      if (!prev || c.score > prev.score) byUrl.set(c.url, c);
    });
    var order = { tos: 0, privacy: 1, eula: 2, cookies: 3, other: 4 };
    return Array.from(byUrl.values()).sort(function (a, b) {
      return (order[a.doc_type] - order[b.doc_type]) || ((a.non_english ? 1 : 0) - (b.non_english ? 1 : 0)) || (b.score - a.score);
    });
  }

  function isSensitivePage(url) {
    var p = pathOf(url);
    return !!p && SENSITIVE_PATH.test(p);
  }

  // Legal hub (a "legal center" that mostly lists other legal documents). links: output of findLegalLinks for that page.
  function isLegalHub(info, links) {
    var url = info.url || '';
    var p = pathOf(url);
    var hint = /\/(legal|legal-center|legal-centre|policies|policy|trust|terms-and-policies|terms-policies|legal-hub|rechtliches|juridique|legal-information)$/i.test(p) ||
      /^\s*(legal|legal (center|centre|hub|information|terms)|policies|terms (and|&) policies|terms, privacy)/i.test(info.h1 || info.title || '');
    var cands = (links || []).filter(function (l) { return l.region !== 'footer' && l.url.split('#')[0] !== url.split('#')[0]; });
    var types = {};
    cands.forEach(function (l) { types[l.doc_type] = 1; });
    var nTypes = Object.keys(types).length, len = info.textLength || 0;
    if (hint) return cands.length >= 2 && len < 6000;
    var bodyOnly = cands.filter(function (l) { return l.region === 'body'; });
    return bodyOnly.length >= 3 && nTypes >= 2 && len < 3000;
  }

  // Is this page itself a legal document? info: {url, title, h1, textLength, links?}
  // Returns {isTerms, doc_type, reasons, isHub, sensitive}. A hub or a sensitive-looking page is never "the document".
  function classifyPage(info) {
    var reasons = [];
    var byPath = null;
    var p = pathOf(info.url);
    if (p) byPath = COMMON_PATHS[p] || firstMatch(HREF_PATTERNS, p);
    if (!byPath && p) { for (var hi = 0; hi < HREF_I18N.length; hi++) if (HREF_I18N[hi][2].test(p)) { byPath = HREF_I18N[hi][1]; break; } }
    var byTitle = firstMatch(TITLE_PATTERNS, info.h1 || '') || firstMatch(TITLE_PATTERNS, info.title || '');
    if (!byTitle) {
      for (var ti = 0; ti < TEXT_I18N.length; ti++) {
        if (TEXT_I18N[ti][1] !== 'other' && TEXT_I18N[ti][2].test(info.h1 || '') && /(^|\s)(pol[i\u00ed]tica|aviso|t[e\u00e9]rminos|condiciones|conditions|politique|nutzungsbedingungen|datenschutz|termos|termini|informativa|privacidade|confidentialit)/i.test(info.h1 || '')) { byTitle = TEXT_I18N[ti][1]; break; }
      }
    }
    if (articlePath(p)) { byPath = null; byTitle = null; }
    else if (byTitle && headlineLike(info.h1 || '') && headlineLike(info.title || '')) byTitle = null;
    var len = info.textLength || 0;
    var sensitive = isSensitivePage(info.url);
    if (sensitive) return { isTerms: false, isHub: false, thin: false, sensitive: true, doc_type: null, reasons: ['sensitive-looking page (account, checkout, payment...): never read as a document'] };
    if (info.links && isLegalHub(info, info.links)) return { isTerms: false, isHub: true, thin: false, sensitive: sensitive, doc_type: null, reasons: ['legal hub: lists ' + info.links.length + ' legal documents'] };
    if (byPath && len >= MIN_TEXT_FOR_PATH_MATCH) {
      reasons.push('url path');
      return { isTerms: true, isHub: false, thin: false, sensitive: sensitive, doc_type: byTitle && byTitle !== byPath && byPath === 'other' ? byTitle : byPath, reasons: reasons.concat(byTitle ? ['title'] : []) };
    }
    if (byTitle && len >= MIN_TEXT_FOR_TITLE_MATCH) {
      return { isTerms: true, isHub: false, thin: false, sensitive: sensitive, doc_type: byTitle, reasons: ['title/heading'] };
    }
    // The address or title says "terms"/"privacy" but there is hardly any text: the page probably builds its text with JavaScript
    // (or it is still loading, or the text is behind a button). Not read as terms, but the window can say so plainly.
    var thin = !!((byPath && len < MIN_TEXT_FOR_PATH_MATCH) || (byTitle && len < THIN_TITLE_TEXT));
    return { isTerms: false, isHub: false, sensitive: sensitive, thin: thin, doc_type: null, reasons: thin ? ['looks like a legal page but has very little text'] : [] };
  }

  return {
    DOC_TYPES: DOC_TYPES, COMMON_PATHS: COMMON_PATHS,
    classifyLink: classifyLink, findLegalLinks: findLegalLinks, classifyPage: classifyPage,
    isLegalHub: isLegalHub, isSensitivePage: isSensitivePage, LANGS: LANGS
  };
});
