/*
 * context.js - guesses what KIND of service a terms page belongs to, so the Explain window can judge a clause in context
 * (limited liability on a news site is routine; the same clause at a bank or a shop matters much more).
 * ON-DEVICE and deterministic: a fixed list of domain hints and wording cues, scored. No AI, no network, nothing stored.
 * The same input always gives the same answer. It is a guess: it says so, shows its reasons, and falls back to "other"
 * (no adjustments) when the signals are weak or tied. Page text is only matched against regular expressions here.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function r(src) { return new RegExp(src, 'ig'); }

  // Order matters only as a tie-break (earlier wins a tie, but a tie of the top two is reported as "other").
  var TYPES = {
    news_media: {
      label: 'news / media',
      host: [/(^|\.)(cnn|bbc|nytimes|washingtonpost|reuters|apnews|theguardian|foxnews|nbcnews|cbsnews|abcnews|npr|wsj|bloomberg|usatoday|latimes|economist|politico|huffpost|axios)\.[a-z.]+$/i, /(^|[.-])(news|times|herald|tribune|gazette|journal|chronicle)[a-z-]*\.[a-z.]+$/i],
      text: [[r('\\b(news|newsroom|newsletters?)\\b'), 1], [r('\\b(journalis\\w+|editorial|reporters?|broadcast\\w*|headlines?)\\b'), 2], [r('\\b(articles?|stories|video clips?|podcasts?)\\b'), 1], [r('\\b(news|media) (organi[sz]ation|company|service|site|website)\\b'), 3]]
    },
    shopping: {
      label: 'shopping / retail',
      host: [/(^|\.)(amazon|ebay|walmart|target|etsy|bestbuy|aliexpress|shopify|wayfair|costco|ikea|homedepot|lowes)\.[a-z.]+$/i, /(^|[.-])(shop|store|mart|buy|outlet)[a-z-]*\.[a-z.]+$/i],
      text: [[r('\\b(orders?|ordering|checkout|shopping cart|cart)\\b'), 1], [r('\\b(shipping|delivery|deliveries|returns?|refunds?|exchanges?)\\b'), 1], [r('\\b(products?|merchandise|goods|inventory|sellers?|merchants?)\\b'), 1], [r('\\b(online store|marketplace|retailer|retail)\\b'), 3]]
    },
    social: {
      label: 'social / user-content platform',
      host: [/(^|\.)(facebook|instagram|twitter|x|tiktok|reddit|snapchat|linkedin|pinterest|discord|tumblr|threads|mastodon|bsky|medium|substack|quora|twitch)\.[a-z.]+$/i],
      text: [[r('\\b(user[- ]generated|user content|content (that )?you (post|submit|upload|share|create)|your posts?)\\b'), 3], [r('\\b(followers?|following|profiles?|communit(y|ies)|other users|friends|messages?|comments?)\\b'), 1], [r('\\b(post|posts|posting|upload|uploads|share|shares|sharing)\\b'), 1], [r('\\b(social (network|media|platform)|online communit\\w+)\\b'), 3]]
    },
    finance: {
      label: 'finance / banking / payments',
      host: [/(^|\.)(paypal|venmo|stripe|chase|wellsfargo|bankofamerica|citi|capitalone|schwab|fidelity|vanguard|coinbase|robinhood|kraken|binance|wise|revolut|squareup|cash)\.[a-z.]+$/i, /(^|[.-])(bank|credit|loan|pay|finance|capital|invest|trading|crypto)[a-z-]*\.[a-z.]+$/i],
      text: [[r('\\b(bank|banking|credit union|financial (institution|services?|accounts?|products?))\\b'), 2], [r('\\b(credit|debit) cards?\\b'), 1], [r('\\b(loans?|mortgages?|interest rates?|overdraft|apr)\\b'), 2], [r('\\b(invest\\w*|securities|brokerage|trading|cryptocurrenc\\w+|digital assets?)\\b'), 2], [r('\\b(payment (service|processor|processing)|money transmi\\w+|fund transfers?|transfer (of )?funds|wire transfers?|fdic)\\b'), 3]]
    },
    software: {
      label: 'app / software / subscription',
      host: [/(^|\.)(adobe|spotify|netflix|dropbox|github|slack|zoom|notion|figma|canva|atlassian|openai|apple|microsoft|google)\.[a-z.]+$/i],
      text: [[r('\\b(software|applications?|apps?|plug-?ins?|downloads?|install\\w*)\\b'), 1], [r('\\b(subscriptions?|subscribers?|plans?|billing|free trial|auto[- ]?renew\\w*)\\b'), 1], [r('\\b(licen[cs]e (to )?(use|install)|end[- ]user licen[cs]e|source code|api|saas)\\b'), 2], [r('\\b(streaming|cloud (service|storage)|software as a service)\\b'), 2]]
    }
  };

  var ORDER = ['news_media', 'shopping', 'social', 'finance', 'software'];
  var HOST_POINTS = 5;       // a domain hint outweighs a few wording cues
  var CAP_PER_CUE = 3;       // one repeated word cannot dominate
  var MIN_SCORE = 4;         // below this the guess is too weak -> "other"
  var MIN_LEAD = 2;          // the best must beat the second by this much, otherwise "other"

  function hostOnly(h) {
    h = String(h || '').toLowerCase().replace(/^https?:\/\//, '').replace(/[\/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
    return /^[a-z0-9.-]+$/.test(h) ? h : '';
  }

  function detect(host, text) {
    var h = hostOnly(host);
    var sample = String(text || '').slice(0, 200000);
    var scores = {}, reasons = {};
    ORDER.forEach(function (t) {
      var s = 0, why = [], def = TYPES[t];
      if (h) for (var i = 0; i < def.host.length; i++) if (def.host[i].test(h)) { s += HOST_POINTS; why.push('site name'); break; }
      var cueScore = 0;
      def.text.forEach(function (c) {
        c[0].lastIndex = 0;
        var m = sample.match(c[0]);
        if (m) cueScore += Math.min(m.length, CAP_PER_CUE) * c[1];
      });
      if (cueScore) { s += cueScore; why.push('wording'); }
      scores[t] = s; reasons[t] = why;
    });
    var ranked = ORDER.slice().sort(function (a, b) { return scores[b] - scores[a] || ORDER.indexOf(a) - ORDER.indexOf(b); });
    var best = ranked[0], second = ranked[1];
    if (scores[best] < MIN_SCORE || scores[best] - scores[second] < MIN_LEAD) {
      return { type: 'other', label: 'not clear', confident: false, reasons: [], scores: scores, line: 'Type of service: not clear, so rules are applied without adjusting for the kind of service.' };
    }
    return { type: best, label: TYPES[best].label, confident: true, reasons: reasons[best], scores: scores, line: 'Type of service: ' + TYPES[best].label + ' (guessed from the ' + reasons[best].join(' and ') + ').' };
  }

  var LABELS = { other: 'not clear' };
  ORDER.forEach(function (t) { LABELS[t] = TYPES[t].label; });

  return { detect: detect, TYPES: ORDER.concat(['other']), LABELS: LABELS, hostOnly: hostOnly };
});
