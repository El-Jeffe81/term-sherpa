'use strict';
// Tiny local HTTP server that serves the fake fixture sites. Offline: binds 127.0.0.1 only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const activeOrigins = new Set(); // host:port of every fixture server currently running (tests pass these to the harness entry)
const SITES = path.join(__dirname, '..', 'fixtures', 'sites');

/*
 * routes: { '/terms': {file:'acme/terms.html'} | {status, headers, body} | fn(req)->same }
 * robots: string or null (404) or {status}
 */
function startSite({ routes, robots = '' }) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, headers: req.headers, at: Date.now() });
    const p = req.url.split('?')[0];
    let r;
    if (p === '/robots.txt') {
      if (robots === null) r = { status: 404, body: 'not found' };
      else if (typeof robots === 'object') r = robots;
      else r = { status: 200, headers: { 'content-type': 'text/plain' }, body: robots };
    } else r = routes[p];
    if (typeof r === 'function') r = r(req);
    if (!r) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    const status = r.status || 200;
    const headers = Object.assign({ 'content-type': 'text/html; charset=utf-8' }, r.headers || {});
    const body = r.file ? fs.readFileSync(path.join(SITES, r.file)) : (r.body || '');
    res.writeHead(status, headers);
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const origin = `127.0.0.1:${server.address().port}`;
    activeOrigins.add(origin);
    resolve({ base, origin, hits, pageHits: () => hits.filter((h) => h.url !== '/robots.txt'), close: () => new Promise((r) => { activeOrigins.delete(origin); server.closeAllConnections(); server.close(r); }) });
  }));
}
const read = (f) => fs.readFileSync(path.join(SITES, f), 'utf8');
module.exports = { startSite, read, SITES, activeOrigins };
