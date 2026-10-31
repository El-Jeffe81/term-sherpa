'use strict';
const { parseHtml } = require('./htmltree');
const { createFetcher, looksLikeChallenge, Refusal, EXIT } = require('./fetcher');
const Extract = require('../../extension/core/extract');
const Detect = require('../../extension/core/detect');
const U = require('../../extension/core/untrusted');
const Q = require('../../extension/core/quality');

/*
 * Collect ONE url the user named. Never follows links on its own.
 * Returns {outcome:'stored', ...} or throws Refusal.
 * Only the terms document itself is stored. A legal hub (a page that just lists legal documents) is reported, not stored.
 * A page that looks like an account/checkout/etc. page is never stored, even with --type.
 */
async function collectUrl(url, { store, fetcher, docType, now = () => new Date() }) {
  let page;
  try {
    page = await fetcher.fetchPage(url);
  } catch (e) {
    if (e instanceof Refusal && e.kind === 'pdf' && e.pdf) {
      // A PDF terms document: remember that it exists and what is needed to read it. No bytes, no text stored.
      const guess = Detect.classifyLink({ href: e.pdf.finalUrl, text: '' }, e.pdf.finalUrl);
      const type = docType || (guess && guess.doc_type) || 'other';
      store.markNeedsPartner({ url, finalUrl: e.pdf.finalUrl, docType: type, partner: 'pdftotext', fetchedAt: now().toISOString(), robotsCheckedAt: e.pdf.robotsCheckedAt, mime: e.pdf.mime });
      e.marked = { partner: 'pdftotext', docType: type };
    }
    throw e;
  }
  const isPlain = /text\/plain/i.test(page.contentType);
  let text, title = '', h1 = '', links = [], sections, lang = '';
  let extractor, removedChars = 0;
  if (isPlain) {
    removedChars = U.countSuspicious(page.body); text = U.sanitizeText(page.body); extractor = 'plain-text'; sections = null;
  } else {
    const tree = parseHtml(page.body);
    const ex = Extract.extractMainText(tree);
    removedChars = U.countSuspicious(ex.text);
    text = U.sanitizeText(ex.text); title = U.sanitizeText(ex.title); h1 = U.sanitizeText(ex.h1); extractor = ex.extractor;
    sections = ex.sections; lang = ex.lang || '';
    links = Detect.findLegalLinks(Extract.collectLinks(tree), page.finalUrl);
  }
  if (looksLikeChallenge(page.headers, page.body, text.length)) {
    throw new Refusal('captcha', 'The page looks like a captcha / bot-check page. Not going around it.', EXIT.captcha);
  }
  const cls = Detect.classifyPage({ url: page.finalUrl, title, h1, textLength: text.length, links });
  if (cls.sensitive && !cls.isTerms && docType) {
    const err = new Refusal('sensitive-page', 'This URL looks like an account, checkout, payment or similar page. Those are never stored, even with --type. (Only the detected legal links are shown.)', EXIT.notTerms);
    err.links = links;
    throw err;
  }
  let type = docType;
  const discoveredVia = 'user_pasted';
  if (!type || cls.isHub) {
    if (cls.isHub && !docType) {
      const err = new Refusal('legal-hub', 'This is a legal hub page (it lists other legal documents). I stored nothing from it. Pick the documents you want and run tc-collect on each URL.', EXIT.notTerms);
      err.links = links; err.hub = true;
      throw err;
    }
    if (!type) {
      if (!cls.isTerms) {
        const err = new Refusal('not-terms', 'This page does not look like a terms / privacy / EULA / cookie document, so I did not store it. Use --type <tos|privacy|eula|cookies|other> to store it anyway.', EXIT.notTerms);
        err.links = links;
        throw err;
      }
      type = cls.doc_type;
    }
  }
  if (text.length < 50) throw new Refusal('error', 'Extracted almost no text (the page may need JavaScript or a login). Nothing stored. Try the extension on the open page.', EXIT.error);
  const language = lang && Detect.LANGS.includes(lang.split('-')[0]) ? lang.split('-')[0] : Q.guessLanguage(text).lang;
  const fetchedAt = now().toISOString();
  const res = await store.saveVersion({
    url, finalUrl: page.finalUrl, docType: type, discoveredVia,
    robotsCheckedAt: page.robotsCheckedAt, robotsAllowed: true, fetchedAt,
    status: page.status, mime: page.contentType.split(';')[0].trim(), userAgent: page.userAgent,
    rawBuffer: page.buffer, cleanText: text, extractor, title: title || h1, sections, lang: language, removedChars
  });
  return { outcome: 'stored', docType: type, finalUrl: page.finalUrl, chars: text.length, sections: sections ? sections.length : 1, language, links, ...res, redirects: page.redirects };
}

// For --links: fetch the page the user named and just list candidate legal links (stores nothing).
async function listLinks(url, { fetcher }) {
  const page = await fetcher.fetchPage(url);
  const tree = parseHtml(page.body);
  const links = Detect.findLegalLinks(Extract.collectLinks(tree), page.finalUrl);
  const ex = Extract.extractMainText(tree);
  const cls = Detect.classifyPage({ url: page.finalUrl, title: ex.title, h1: ex.h1, textLength: ex.text.length, links });
  return { finalUrl: page.finalUrl, links, isHub: !!cls.isHub };
}

module.exports = { collectUrl, listLinks };
