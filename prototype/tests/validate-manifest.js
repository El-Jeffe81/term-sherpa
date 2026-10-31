#!/usr/bin/env node
'use strict';
// Validates the manifest against the hard rules.
//   node tests/validate-manifest.js          -> extension/ (source) AND the built dist/chrome and dist/firefox packages (builds them first)
//   node tests/validate-manifest.js source   -> extension/ only
// The Firefox package gets the same hard rules plus Firefox-only checks (gecko id, min version, data consent, no service worker).
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'extension');

function validate(EXT, target) {
  EXT = EXT || SRC; target = target || 'source';
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
  // The ONLY host access is optional, https-only, and requested at click time for just the needed site (chrome.permissions.request).
  ok(JSON.stringify(m.optional_host_permissions || []) === JSON.stringify(['https://*/*']), 'RULE: optional_host_permissions must be exactly ["https://*/*"] (requested per site at click time, never granted up front)');
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

  if (target === 'firefox') {
    const g = ((m.browser_specific_settings || {}).gecko) || {};
    ok(/^[^@\s]*@[A-Za-z0-9._-]+$/.test(g.id || ''), 'firefox: browser_specific_settings.gecko.id must look like name@domain (or {uuid})');
    ok(parseInt(g.strict_min_version, 10) >= 140, 'firefox: gecko.strict_min_version must be >= 140 (data_collection_permissions needs Firefox 140)');
    ok(JSON.stringify((g.data_collection_permissions || {}).required) === JSON.stringify(['none']) && !(g.data_collection_permissions || {}).optional, 'firefox: data_collection_permissions must be {required:["none"]} (nothing collected or sent)');
    ok(!(m.background && m.background.service_worker), 'firefox: background.service_worker is not supported (use background.scripts)');
    ok(!m.key && !m.update_url, 'firefox: no key/update_url');
  } else {
    ok(!('browser_specific_settings' in m), target + ': the shared/Chrome manifest must not carry Firefox-only settings');
  }
  return errors;
}

// Both packages must come from the same source: identical file lists and bytes except manifest.json.
function validatePackages() {
  const { build, walk } = require(path.join(ROOT, 'scripts', 'build.js'));
  const errors = [];
  const out = {};
  for (const t of ['chrome', 'firefox']) { out[t] = build(t); errors.push(...validate(out[t].dir, t).map((e) => t + ' package: ' + e)); }
  const a = walk(out.chrome.dir); const b = walk(out.firefox.dir); const s = walk(SRC);
  if (JSON.stringify(a) !== JSON.stringify(s) || JSON.stringify(b) !== JSON.stringify(s)) errors.push('packages must contain exactly the files in extension/');
  for (const f of s) {
    if (f === 'manifest.json') continue;
    const x = fs.readFileSync(path.join(SRC, f));
    if (!x.equals(fs.readFileSync(path.join(out.chrome.dir, f))) || !x.equals(fs.readFileSync(path.join(out.firefox.dir, f)))) errors.push('package file differs from source: ' + f);
  }
  if (!fs.readFileSync(path.join(out.chrome.dir, 'manifest.json')).equals(fs.readFileSync(path.join(SRC, 'manifest.json')))) errors.push('chrome package manifest must equal extension/manifest.json');
  // Firefox manifest = shared manifest + overlay only: removing the overlay keys gives the shared manifest back.
  const fm = JSON.parse(fs.readFileSync(path.join(out.firefox.dir, 'manifest.json'), 'utf8'));
  delete fm.browser_specific_settings;
  if (JSON.stringify(fm) !== JSON.stringify(JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8')))) errors.push('firefox manifest differs from the shared manifest by more than browser_specific_settings');
  return errors;
}

module.exports = { validate, validatePackages };
if (require.main === module) {
  const only = process.argv[2] === 'source';
  const errs = validate().concat(only ? [] : validatePackages());
  if (errs.length) { console.error('MANIFEST INVALID:\n- ' + errs.join('\n- ')); process.exit(1); }
  console.log('manifest OK (MV3; permissions: activeTab, scripting; no content_scripts; no up-front host permissions; optional https://*/* only)' + (only ? '' : '; chrome + firefox packages OK'));
}
