/*
 * netguard.js - decides whether a network target is safe for the CLI to fetch (SSRF guard).
 * Pure functions: no DNS and no network here. The CLI adds DNS resolution on top (cli/src/netguard-dns.js).
 *
 * Blocked: non-http(s) schemes (file:, ftp:, data:, ...), embedded credentials, loopback, private (RFC 1918 / ULA),
 * link-local, CGNAT, unspecified, multicast, reserved and documentation ranges, for IPv4 and IPv6, including IPv6
 * forms that embed an IPv4 address (::ffff:a.b.c.d, 64:ff9b::/96, 2002::/16, ::a.b.c.d), plus "localhost" style names.
 * The WHATWG URL parser already turns 2130706433, 0x7f.1 and 127.1 into 127.0.0.1 before we look at the host.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCNetGuard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // [network, prefixLength]
  var V4_BLOCKED = [
    [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8], [[169, 254, 0, 0], 16],
    [[172, 16, 0, 0], 12], [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24], [[192, 88, 99, 0], 24], [[192, 168, 0, 0], 16],
    [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24], [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4]
  ];

  function parseIPv4(s) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (!m) return null;
    var out = [];
    for (var i = 1; i <= 4; i++) { var n = parseInt(m[i], 10); if (n > 255) return null; out.push(n); }
    return out;
  }

  function v4InRange(b, net, bits) {
    var full = bits >> 3, rem = bits & 7, i;
    for (i = 0; i < full; i++) if (b[i] !== net[i]) return false;
    if (rem) { var mask = (0xff << (8 - rem)) & 0xff; if ((b[full] & mask) !== (net[full] & mask)) return false; }
    return true;
  }

  function isBlockedIPv4Bytes(b) {
    for (var i = 0; i < V4_BLOCKED.length; i++) if (v4InRange(b, V4_BLOCKED[i][0], V4_BLOCKED[i][1])) return true;
    return false;
  }

  // Returns an array of 16 bytes or null.
  function parseIPv6(s) {
    s = String(s).replace(/^\[|\]$/g, '');
    var pct = s.indexOf('%'); if (pct !== -1) s = s.slice(0, pct);
    if (!/^[0-9a-fA-F:.]+$/.test(s) || s.indexOf(':') === -1) return null;
    var tail = [];
    var lastColon = s.lastIndexOf(':');
    var maybeV4 = s.slice(lastColon + 1);
    if (maybeV4.indexOf('.') !== -1) {
      var v4 = parseIPv4(maybeV4);
      if (!v4) return null;
      s = s.slice(0, lastColon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
    }
    var dbl = s.indexOf('::');
    if (dbl !== -1 && s.indexOf('::', dbl + 1) !== -1) return null;
    var head, rest;
    if (dbl !== -1) { head = s.slice(0, dbl); rest = s.slice(dbl + 2); } else { head = s; rest = null; }
    var hg = head === '' ? [] : head.split(':');
    var rg = rest === null || rest === '' ? [] : rest.split(':');
    var groups;
    if (rest === null) { if (hg.length !== 8) return null; groups = hg; }
    else {
      if (hg.length + rg.length > 7) return null;
      groups = hg.concat(new Array(8 - hg.length - rg.length).fill('0'), rg);
    }
    var bytes = [];
    for (var i = 0; i < 8; i++) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
      var v = parseInt(groups[i], 16);
      bytes.push(v >> 8, v & 255);
    }
    tail = bytes;
    return tail;
  }

  function isBlockedIPv6Bytes(b) {
    var i, allZero = true;
    for (i = 0; i < 16; i++) if (b[i]) { allZero = false; break; }
    if (allZero) return true; // ::
    var first12Zero = true;
    for (i = 0; i < 12; i++) if (b[i]) { first12Zero = false; break; }
    if (first12Zero) return true; // ::1 (loopback) and deprecated IPv4-compatible ::a.b.c.d
    var embedded = [b[12], b[13], b[14], b[15]];
    var mapped = true;
    for (i = 0; i < 10; i++) if (b[i]) { mapped = false; break; }
    if (mapped && b[10] === 0xff && b[11] === 0xff) return isBlockedIPv4Bytes(embedded); // ::ffff:a.b.c.d
    // 64:ff9b::/96 NAT64 well-known prefix -> embedded IPv4
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
      var z = true; for (i = 4; i < 12; i++) if (b[i]) { z = false; break; }
      if (z) return isBlockedIPv4Bytes(embedded);
      if (b[4] === 0x00 && b[5] === 0x01) return true; // 64:ff9b:1::/48 local-use NAT64
    }
    if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIPv4Bytes([b[2], b[3], b[4], b[5]]); // 6to4
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // Teredo 2001::/32
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation 2001:db8::/32
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && (b[3] & 0xfe) === 0x00) return true; // 2001::/23 protocol assignments
    if (b[0] === 0x01 && b[1] === 0x00 && b.slice(2, 8).every(function (x) { return x === 0; })) return true; // 100::/64 discard
    if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
    if (b[0] === 0xff) return true; // multicast
    return false;
  }

  // Returns true when the textual IP address (v4 or v6) must not be fetched. Unparseable input counts as blocked.
  function isBlockedIp(ip) {
    var s = String(ip).trim();
    var v4 = parseIPv4(s);
    if (v4) return isBlockedIPv4Bytes(v4);
    var v6 = parseIPv6(s);
    if (v6) return isBlockedIPv6Bytes(v6);
    return true;
  }

  function isIpLiteral(host) {
    var h = String(host).replace(/^\[|\]$/g, '');
    return !!(parseIPv4(h) || parseIPv6(h));
  }

  var BAD_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.intranet', '.lan', '.corp'];

  // Static host check (no DNS). Returns null when acceptable, else a reason string.
  function hostProblem(hostname) {
    var h = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (!h) return 'empty host name';
    var bare = h.replace(/^\[|\]$/g, '');
    if (isIpLiteral(bare)) return isBlockedIp(bare) ? 'address ' + bare + ' is loopback, private, link-local or otherwise not a public internet address' : null;
    if (h === 'localhost') return 'host name "localhost" is a loopback name';
    for (var i = 0; i < BAD_SUFFIXES.length; i++) if (h.endsWith(BAD_SUFFIXES[i])) return 'host name "' + h + '" is a local-network name';
    if (h.indexOf('.') === -1) return 'single-label host name "' + h + '" resolves on the local network, not the public internet';
    return null;
  }

  // Static URL check: scheme, credentials, host. Takes a URL object or string. Returns null if OK, else a reason string.
  function urlProblem(u) {
    var url;
    try { url = typeof u === 'string' ? new URL(u) : u; } catch (e) { return 'not a valid URL'; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'scheme "' + url.protocol.replace(':', '') + '" is not allowed (only http and https)';
    if (url.username || url.password) return 'URLs with embedded credentials are not accepted';
    return hostProblem(url.hostname);
  }

  return { isBlockedIp: isBlockedIp, isIpLiteral: isIpLiteral, hostProblem: hostProblem, urlProblem: urlProblem, parseIPv6: parseIPv6, parseIPv4: parseIPv4 };
});
