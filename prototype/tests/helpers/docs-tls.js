'use strict';
// Local https "docs.newsco.test" server shared by the browser e2e tests (Chrome-family and Firefox).
// The extension only fetches https documents, so the fixture legal documents are served over TLS with a throw-away
// self-signed certificate (SAN docs.newsco.test). Each test browser maps the name to this server and trusts the certificate
// for its own throw-away profile only; nothing in the extension is relaxed, it sees a normal https URL.
// Routes: the newsco documents, a robots.txt that disallows /blocked-by-robots, two redirects (same-site and off-site)
// and a CORS "*" trap page (so a followed redirect would even be readable). Every request is recorded in `hits`.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const SITES_DIR = path.join(__dirname, '..', 'fixtures', 'sites');
const ROUTES = { '/terms': 'newsco/terms.html', '/privacy': 'newsco/privacy.html', '/cookies': 'newsco/cookies.html', '/community-guidelines': 'newsco/community-guidelines.html', '/subscriber-agreement': 'newsco/subscriber-agreement.html' };

function writeExt(file) { fs.writeFileSync(file, 'subjectAltName=DNS:docs.newsco.test\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n'); }

// Resolves to null when openssl is missing (callers skip the https part).
async function startDocsTls() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tls-'));
  // A throw-away CA that signs the server certificate: Firefox will not trust a bare self-signed server certificate even when it is
  // imported (MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT); it does trust an imported CA. Chrome-family browsers just ignore cert errors.
  const f = (n) => path.join(dir, n);
  const sh = (args, input) => spawnSync('openssl', args, { stdio: input ? ['pipe', 'ignore', 'ignore'] : 'ignore', input }).status === 0;
  writeExt(f('ext.cnf'));
  const made = sh(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.pem'), '-days', '2', '-subj', '/CN=Terms Guide test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
    && sh(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('k.pem'), '-out', f('s.csr'), '-subj', '/CN=docs.newsco.test'])
    && sh(['x509', '-req', '-in', f('s.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('c.pem'), '-days', '2', '-extfile', f('ext.cnf')]);
  if (!made) return null;
  const hits = [];
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    hits.push({ url: req.url, headers: req.headers });
    const u = req.url.split('?')[0];
    if (u === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /blocked-by-robots\n'); }
    if (u === '/moved-terms') { res.writeHead(302, { location: '/terms' }); return res.end(); }
    if (u === '/moved-offsite') { res.writeHead(302, { location: `https://127.0.0.1:${server.address().port}/redirect-trap` }); return res.end(); }
    if (u === '/redirect-trap') { res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' }); return res.end('<html><body>trap</body></html>'); }
    const f = u === '/blocked-by-robots' ? 'newsco/terms.html' : ROUTES[u];
    if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(path.join(SITES_DIR, f)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server, hits, port: server.address().port,
    certPem: fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8'), // the CA to trust (named certPem for the callers)
    close() { server.closeAllConnections(); server.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } },
  };
}
module.exports = { startDocsTls };
