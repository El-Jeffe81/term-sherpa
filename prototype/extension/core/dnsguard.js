/*
 * dnsguard.js - Firefox only: refuse a site whose name resolves to a private, loopback, link-local or otherwise
 * non-public address, BEFORE any request is made to it (a public-looking name pointing at 192.168.x.x or 127.0.0.1
 * is the classic way to aim a page at someone's home network).
 *
 * Firefox lets extensions ask the browser to resolve a name (browser.dns.resolve, permission "dns"; the permission shows
 * no install warning). Chrome and Edge have no such API, so there the check is simply absent and only the static
 * check in netguard.js applies (names that look local, IP literals, https only, no redirects followed).
 * Known limit: the answer is looked up just before the request, and the browser looks it up again for the request, so a
 * DNS server that changes its answer in between (rebinding) is not covered. It is a safety net, not a guarantee.
 *
 * Pure: the resolver is injected, so Node tests drive it with a mock. No storage, no network of its own.
 *
 * createCheck(resolve, guard) -> function (hostname) -> Promise<null | reason>
 *   resolve(hostname) -> Promise<{addresses: [...]}> (the shape of browser.dns.resolve)
 *   null = fine to fetch; a string = do not fetch, the reason (shown to the person in plain words).
 * Answers are cached per check object (one check object per analysis), so each site is looked up once per click.
 * fromBrowser(root, guard) -> a check using root.browser.dns.resolve, or null when the browser has no such API.
 */
(function (root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./netguard') : root.TCNetGuard);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCDnsGuard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (DefaultGuard) {
  'use strict';

  function createCheck(resolve, guard) {
    guard = guard || DefaultGuard;
    var cache = {};
    return function check(hostname) {
      var h = String(hostname || '').toLowerCase().replace(/\.$/, '');
      if (cache[h]) return cache[h];
      cache[h] = Promise.resolve().then(function () { return resolve(h); }).then(function (res) {
        var addrs = res && res.addresses;
        if (!addrs || !addrs.length) return 'its address could not be looked up';
        for (var i = 0; i < addrs.length; i++) {
          if (guard.isBlockedIp(addrs[i])) return 'its name points to a private or internal address, so it was not opened';
        }
        return null;
      }, function () { return 'its address could not be looked up'; });
      return cache[h];
    };
  }

  function fromBrowser(root, guard) {
    var b = root && root.browser;
    if (!b || !b.dns || typeof b.dns.resolve !== 'function') return null;
    return createCheck(function (host) { return b.dns.resolve(host); }, guard);
  }

  return { createCheck: createCheck, fromBrowser: fromBrowser };
});
