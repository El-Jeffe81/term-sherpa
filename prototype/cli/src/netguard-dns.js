'use strict';
/*
 * netguard-dns.js - CLI side of the SSRF guard: static URL checks (extension/core/netguard.js) + DNS resolution
 * + a transport that re-validates the address at CONNECT time (so DNS rebinding between check and connect cannot
 * slip through). Used for every hop: robots.txt, the page, and each redirect.
 */
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');
const Guard = require('../../extension/core/netguard');

class UnsafeTarget extends Error {
  constructor(message) { super(message); this.name = 'UnsafeTarget'; }
}

const defaultResolve = (host) => new Promise((resolve, reject) => {
  dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs.map((a) => a.address))));
});

/*
 * Throws UnsafeTarget unless the URL is http(s), has no credentials, and its host (literal, or every address it
 * resolves to) is a public address. opts.resolve(host) -> Promise<string[]> is injectable for tests.
 */
async function assertPublicUrl(urlLike, opts = {}) {
  const url = typeof urlLike === 'string' ? new URL(urlLike) : urlLike;
  if (opts.allowOrigins && opts.allowOrigins.includes(url.host)) return; // offline test harness only
  const problem = Guard.urlProblem(url);
  if (problem) throw new UnsafeTarget(`Refusing ${url.protocol}//${url.host}${url.pathname}: ${problem}.`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (Guard.isIpLiteral(host)) return;
  let addrs;
  try { addrs = await (opts.resolve || defaultResolve)(host); }
  catch (e) { throw new UnsafeTarget(`Could not resolve ${host} (${e.code || e.message}); not fetching.`); }
  if (!addrs.length) throw new UnsafeTarget(`${host} did not resolve to any address; not fetching.`);
  const bad = addrs.filter((a) => Guard.isBlockedIp(a));
  if (bad.length) throw new UnsafeTarget(`Refusing ${host}: it resolves to ${bad[0]}, which is a loopback, private, link-local or otherwise non-public address.`);
}

// dns.lookup replacement for http(s).request({lookup}) that refuses non-public answers at connect time.
function guardedLookup(opts = {}) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    const resolve = opts.resolve
      ? opts.resolve(hostname).then((a) => a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })))
      : new Promise((res, rej) => dns.lookup(hostname, { all: true, verbatim: true }, (e, a) => (e ? rej(e) : res(a))));
    resolve.then((addrs) => {
      const bad = addrs.find((a) => Guard.isBlockedIp(a.address));
      if (bad) return cb(new UnsafeTarget(`Refusing ${hostname}: connect-time address ${bad.address} is not public.`));
      if (options && options.all) return cb(null, addrs);
      return cb(null, addrs[0].address, addrs[0].family);
    }, (e) => cb(e));
  };
}

/*
 * One GET, no automatic redirects, no cookies, returns a WHATWG Response (so callers use status/headers/body).
 * Validates the URL (scheme, host, DNS) first and again at connect time. `allowOrigins` (exact host:port list)
 * exists only for the offline test harness (tests/helpers) and is NOT reachable from the CLI.
 */
async function guardedGet(urlStr, { headers, signal, allowOrigins, resolve } = {}) {
  const url = new URL(urlStr);
  await assertPublicUrl(url, { allowOrigins, resolve });
  const allowed = !!(allowOrigins && allowOrigins.includes(url.host));
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((res, rej) => {
    const req = mod.request(url, {
      method: 'GET', headers, signal, agent: false,
      lookup: allowed ? undefined : guardedLookup({ resolve })
    }, (r) => {
      const h = new Headers();
      for (let i = 0; i < r.rawHeaders.length; i += 2) { try { h.append(r.rawHeaders[i], r.rawHeaders[i + 1]); } catch { /* skip invalid header */ } }
      const noBody = [204, 205, 304].includes(r.statusCode) || r.statusCode < 200;
      if (noBody) r.resume();
      res(new Response(noBody ? null : Readable.toWeb(r), { status: r.statusCode, headers: h }));
    });
    req.on('error', (e) => rej(e.cause instanceof UnsafeTarget ? e.cause : e));
    req.end();
  });
}

module.exports = { assertPublicUrl, guardedGet, guardedLookup, UnsafeTarget };
