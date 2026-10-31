#!/usr/bin/env node
'use strict';
// Validates extension/manifest.json against the hard rules. Usage: node tests/validate-manifest.js
const fs = require('node:fs');
const path = require('node:path');
const EXT = path.join(__dirname, '..', 'extension');

function validate() {
  const errors = [];
  const ok = (c, m) => { if (!c) errors.push(m); };
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')); } catch (e) { return ['manifest.json is not valid JSON: ' + e.message]; }

  ok(m.manifest_version === 3, 'manifest_version must be 3');
  ok(typeof m.name === 'string' && m.name.length > 0 && m.name.length <= 75, 'name required (<= 75 chars)');
  ok(/^\d+(\.\d+){0,3}$/.test(m.version || ''), 'version must be 1-4 dot-separated integers');
  ok(typeof m.description === 'string' && m.description.length <= 132, 'description required (<= 132 chars)');

  // hard rules
  ok(!('content_scripts' in m), 'RULE: no manifest content_scripts (inject only on click)');
  ok(!('host_permissions' in m), 'RULE: no host_permissions');
  ok(!('optional_host_permissions' in m), 'RULE: no optional_host_permissions (extension makes no network requests)');
  ok(!('background' in m), 'no background/service worker needed');
  ok(!('web_accessible_resources' in m), 'no web_accessible_resources');
  ok(!('externally_connectable' in m), 'no externally_connectable');
  ok(!('permissions' in m) || JSON.stringify([...m.permissions].sort()) === JSON.stringify(['activeTab', 'scripting']), 'permissions must be exactly activeTab + scripting');
  ok(!('optional_permissions' in m), 'no optional_permissions');
  ok(Array.isArray(m.permissions) && m.permissions.includes('activeTab') && m.permissions.includes('scripting'), 'activeTab and scripting required');
  ok(m.action && m.action.default_popup, 'action.default_popup required');
  const csp = (m.content_security_policy || {}).extension_pages || '';
  ok(/script-src 'self'/.test(csp) && !/unsafe-eval|unsafe-inline|https?:/.test(csp), "CSP must be script-src 'self' with no unsafe-* or remote sources");

  // referenced files exist
  const refs = [m.action && m.action.default_popup].filter(Boolean);
  Object.values(m.icons || {}).forEach((f) => refs.push(f));
  for (const f of refs) ok(fs.existsSync(path.join(EXT, f)), 'missing file: ' + f);

  // every extension html page (popup launcher, explain window, legacy collection popup): scripts/links are local and exist; no inline scripts
  const pages = (function walkHtml(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walkHtml(path.join(dir, d.name)) : /\.html$/.test(d.name) ? [path.join(dir, d.name)] : []); })(EXT);
  ok(pages.length >= 1, 'no html pages found');
  for (const page of pages) {
    const html = fs.readFileSync(page, 'utf8');
    const rel = path.relative(EXT, page);
    for (const mm of html.matchAll(/<script\b([^>]*)>/gi)) {
      const src = (/src="([^"]+)"/.exec(mm[1]) || [])[1];
      ok(!!src, rel + ': inline <script> not allowed under MV3 CSP');
      if (src) { ok(!/^[a-z]+:|^\/\//i.test(src), rel + ': remote script: ' + src); ok(fs.existsSync(path.join(path.dirname(page), src)), rel + ': missing script: ' + src); }
    }
    for (const mm of html.matchAll(/<link\b[^>]*href="([^"]+)"/gi)) ok(!/^[a-z]+:|^\/\//i.test(mm[1]) && fs.existsSync(path.join(path.dirname(page), mm[1])), rel + ': bad stylesheet: ' + mm[1]);
    ok(!/\son\w+\s*=/i.test(html), rel + ': inline event handlers not allowed');
  }
  // files injected on click must exist
  for (const js of ['popup/popup.js', 'explain/explain.js']) {
    const src = fs.readFileSync(path.join(EXT, js), 'utf8');
    const inj = /INJECT_FILES\s*=\s*\[([^\]]+)\]/.exec(src);
    ok(!!inj, js + ' must list INJECT_FILES');
    if (inj) for (const f of inj[1].match(/'([^']+)'/g).map((x) => x.slice(1, -1))) ok(fs.existsSync(path.join(EXT, f)), js + ': missing injected file: ' + f);
  }
  return errors;
}

module.exports = { validate };
if (require.main === module) {
  const errs = validate();
  if (errs.length) { console.error('MANIFEST INVALID:\n- ' + errs.join('\n- ')); process.exit(1); }
  console.log('manifest OK (MV3; permissions: activeTab, scripting; no content_scripts; no host permissions)');
}
