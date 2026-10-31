'use strict';
/*
 * fetcher.js - polite, logged-out, robots-respecting fetcher.
 *  - honest User-Agent; no cookies, no Authorization, no stored sessions
 *  - robots.txt checked for every origin we touch (including redirect targets)
 *  - per-host rate limit (also across runs, via the dataset's throttle table)
 *  - refuses (never works around) robots disallow, 401/403/429/451, captcha/challenge pages
 *  - single page per call; no crawling
 *  - SSRF guard: only public http(s) targets. Scheme, host and DNS answers are checked before EVERY request (robots.txt,
 *    the page, every redirect hop), and the connect-time address is checked again (see netguard-dns.js)
 */
const { parseRobots, isAllowed, crawlDelayFor } = require('./robots');
const { assertPublicUrl, guardedGet, UnsafeTarget } = require('./netguard-dns');

const VERSION = '0.1.0';
const PRODUCT_TOKEN = 'tc-collect';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

class Refusal extends Error {
  constructor(kind, message, exitCode) { super(message); this.kind = kind; this.exitCode = exitCode; }
}
const EXIT = { ok: 0, notFound: 1, usage: 2, robots: 3, blocked: 4, captcha: 5, notTerms: 6, error: 7, unsafeTarget: 8, pdfPending: 9 };

function buildUserAgent(contact) {
  return `${PRODUCT_TOKEN}/${VERSION} (user-initiated personal tool; fetches one page, logged out; honors robots.txt` + (contact ? `; contact: ${contact}` : '') + ')';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-memory + optional persistent throttle (persistent object: {get(host)->ms|null, set(host, ms)})
function makeThrottle(delayMs, persist) {
  const last = new Map();
  return async function throttle(host, extraDelayMs) {
    const gap = Math.max(delayMs, extraDelayMs || 0);
    const prev = Math.max(last.get(host) || 0, (persist && persist.get(host)) || 0);
    const wait = prev + gap - Date.now();
    if (wait > 0) await sleep(wait);
    const t = Date.now();
    last.set(host, t);
    if (persist) persist.set(host, t);
  };
}

const CHALLENGE_STRONG = /cf-challenge|challenges\.cloudflare\.com|cf-turnstile|g-recaptcha|h-captcha|hcaptcha\.com|px-captcha|_Incapsula_Resource|Attention Required! \| Cloudflare|<title>\s*Just a moment\.\.\.|verify (that )?you are (a )?human|are you a robot|unusual traffic from your computer/i;

function looksLikeChallenge(headers, body, textLength) {
  if (/challenge/i.test(headers.get('cf-mitigated') || '')) return true;
  if (CHALLENGE_STRONG.test(body)) {
    // a real legal page may embed a recaptcha on a contact form; a challenge page has little text
    if (/<title>\s*Just a moment\.\.\.|Attention Required! \| Cloudflare|cf-challenge/i.test(body)) return true;
    return textLength < 2000;
  }
  return false;
}

function decodeBody(buf, contentType) {
  let charset = (/charset=([\w-]+)/i.exec(contentType || '') || [])[1];
  if (!charset) charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('latin1')) || [])[1];
  try { return new TextDecoder(charset || 'utf-8').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

function createFetcher(opts = {}) {
  const ua = opts.userAgent || buildUserAgent(opts.contact);
  const throttle = makeThrottle(opts.delayMs === undefined ? 5000 : opts.delayMs, opts.persistThrottle);
  const timeoutMs = opts.timeoutMs || 20000;
  const robotsCache = new Map(); // origin -> {parsed|null, status, checkedAt}
  // allowOrigins (exact host:port list) / resolve exist ONLY for the offline test harness (fixture server on 127.0.0.1, fake DNS). The CLI never sets them.
  const guardOpts = { allowOrigins: opts.allowOrigins, resolve: opts.resolve };
  const fetchImpl = opts.fetch || ((url, init) => guardedGet(url, { headers: init.headers, signal: init.signal, ...guardOpts }));

  async function ensurePublic(url, what) {
    try { await assertPublicUrl(url, guardOpts); }
    catch (e) {
      if (e instanceof UnsafeTarget) throw new Refusal('unsafe-target', (what ? what + ': ' : '') + e.message, EXIT.unsafeTarget);
      throw e;
    }
  }

  async function rawGet(url, accept, extraDelay) {
    const u = new URL(url);
    await ensurePublic(u);
    await throttle(u.host, extraDelay);
    try {
      return await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: { 'User-Agent': ua, Accept: accept },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      const bad = e instanceof UnsafeTarget ? e : (e && e.cause instanceof UnsafeTarget ? e.cause : null);
      if (bad) throw new Refusal('unsafe-target', bad.message, EXIT.unsafeTarget);
      throw e;
    }
  }

  async function getRobots(origin) {
    if (robotsCache.has(origin)) return robotsCache.get(origin);
    let url = origin + '/robots.txt', res;
    for (let hop = 0; ; hop++) {
      res = await rawGet(url, 'text/plain,*/*;q=0.1');
      if (res.status >= 300 && res.status < 400 && res.headers.get('location') && hop < MAX_REDIRECTS) {
        await res.arrayBuffer().catch(() => {});
        const nextUrl = new URL(res.headers.get('location'), url);
        await ensurePublic(nextUrl, 'robots.txt redirect');
        url = nextUrl.href;
        continue;
      }
      break;
    }
    const entry = { checkedAt: new Date().toISOString(), status: res.status, parsed: null, crawlDelay: null };
    if (res.status >= 200 && res.status < 300) {
      const text = (await res.text()).slice(0, 512 * 1024);
      entry.parsed = parseRobots(text);
      entry.crawlDelay = crawlDelayFor(entry.parsed, PRODUCT_TOKEN);
    } else {
      await res.arrayBuffer().catch(() => {});
      if (res.status === 404 || res.status === 410) entry.parsed = parseRobots(''); // no robots.txt = no restrictions
      else if (res.status === 401 || res.status === 403) entry.refuse = `robots.txt returned HTTP ${res.status} (access blocked); not going further`;
      else if (res.status >= 400 && res.status < 500) entry.parsed = parseRobots('');
      else entry.refuse = `robots.txt unavailable (HTTP ${res.status}); assuming disallowed`;
    }
    robotsCache.set(origin, entry);
    return entry;
  }

  async function checkRobots(url) {
    const u = new URL(url);
    const entry = await getRobots(u.origin);
    if (entry.refuse) throw new Refusal('robots', `${u.origin}: ${entry.refuse}.`, EXIT.robots);
    const allowed = isAllowed(entry.parsed, PRODUCT_TOKEN, u.pathname + u.search);
    if (!allowed) throw new Refusal('robots', `robots.txt of ${u.origin} disallows ${u.pathname}${u.search} for ${PRODUCT_TOKEN}. Not fetching.`, EXIT.robots);
    return { checkedAt: entry.checkedAt, allowed: true, crawlDelay: entry.crawlDelay };
  }

  /* Fetch one page. Returns {finalUrl, status, contentType, body(string), buffer, userAgent, robotsCheckedAt, redirects[]} or throws Refusal/Error. */
  async function fetchPage(url) {
    let current = new URL(url);
    if (!/^https?:$/.test(current.protocol)) throw new Refusal('usage', `Only http and https URLs are supported (refusing ${current.protocol.replace(':', '')}:).`, EXIT.usage);
    if (current.username || current.password) throw new Refusal('usage', 'URLs with embedded credentials are not accepted (logged-out fetches only).', EXIT.usage);
    await ensurePublic(current);
    const redirects = [];
    let robotsInfo = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      robotsInfo = await checkRobots(current.href);
      const res = await rawGet(current.href, 'text/html,application/xhtml+xml,text/plain;q=0.9', robotsInfo.crawlDelay ? Math.min(robotsInfo.crawlDelay, 60) * 1000 : 0);
      const st = res.status;
      if (st >= 300 && st < 400 && res.headers.get('location')) {
        await res.arrayBuffer().catch(() => {});
        const next = new URL(res.headers.get('location'), current);
        // checked at EVERY hop, before anything is requested from the target: scheme, literal address, DNS answers
        await ensurePublic(next, 'redirect refused');
        redirects.push(next.href);
        current = next;
        continue;
      }
      if (st === 401 || st === 403) { await res.arrayBuffer().catch(() => {}); throw new Refusal('blocked', `HTTP ${st}: the site blocks logged-out access to this page. I will not try to get around it. If you can read it in your browser, use the extension or paste the text instead.`, EXIT.blocked); }
      if (st === 429) { await res.arrayBuffer().catch(() => {}); throw new Refusal('blocked', 'HTTP 429: the site asked me to slow down. Stopping; try again later (longer --delay).', EXIT.blocked); }
      if (st === 451) { await res.arrayBuffer().catch(() => {}); throw new Refusal('blocked', 'HTTP 451: unavailable for legal reasons. Stopping.', EXIT.blocked); }
      const ctype = res.headers.get('content-type') || '';
      if (/application\/pdf/i.test(ctype) || (/application\/octet-stream/i.test(ctype) && /\.pdf$/i.test(current.pathname))) {
        if (res.body) await res.body.cancel().catch(() => {}); // do not download the PDF; only its type matters here
        const err = new Refusal('pdf', 'This is a PDF. PDF text extraction needs the pdftotext partner, which is pending owner approval (see PARTNERS.md). Marked as "needs pdftotext"; no text stored.', EXIT.pdfPending);
        err.pdf = { url: current.href, finalUrl: current.href, status: st, mime: 'application/pdf', userAgent: ua, robotsCheckedAt: robotsInfo.checkedAt };
        throw err;
      }
      const chunks = []; let size = 0;
      for await (const c of res.body) { size += c.length; if (size > MAX_BYTES) throw new Refusal('error', 'Response larger than 5 MB; refusing.', EXIT.error); chunks.push(c); }
      const buffer = Buffer.concat(chunks);
      const body = decodeBody(buffer, ctype);
      if (st === 503 || st === 202) {
        if (looksLikeChallenge(res.headers, body, 0)) throw new Refusal('captcha', `HTTP ${st} with a bot-check/challenge page. Not going around it.`, EXIT.captcha);
      }
      if (st < 200 || st >= 300) throw new Refusal('error', `HTTP ${st} for ${current.href}`, EXIT.error);
      if (!/text\/html|application\/xhtml|text\/plain/i.test(ctype)) {
        throw new Refusal('error', `Unsupported content type "${ctype || 'unknown'}" (this prototype reads HTML and plain text only; PDFs are marked as needing the pdftotext partner).`, EXIT.error);
      }
      return { finalUrl: current.href, status: st, contentType: ctype, buffer, body, userAgent: ua, robotsCheckedAt: robotsInfo.checkedAt, redirects, headers: res.headers };
    }
    throw new Refusal('error', `Too many redirects (more than ${MAX_REDIRECTS}).`, EXIT.error);
  }

  return { fetchPage, userAgent: ua, checkRobots };
}

module.exports = { createFetcher, UnsafeTarget, buildUserAgent, looksLikeChallenge, Refusal, EXIT, PRODUCT_TOKEN, VERSION };
