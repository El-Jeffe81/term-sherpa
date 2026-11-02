'use strict';
/* robots.js - RFC 9309-style robots.txt parsing and matching. */

function parseRobots(text) {
  const groups = []; // {agents:[lowercase], rules:[{allow, pattern}], crawlDelay}
  let cur = null, lastWasAgent = false;
  for (let raw of String(text || '').split(/\r?\n/)) {
    raw = raw.replace(/#.*$/, '').trim();
    if (!raw) continue;
    const idx = raw.indexOf(':');
    if (idx < 0) continue;
    const key = raw.slice(0, idx).trim().toLowerCase();
    const val = raw.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], crawlDelay: null }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') cur.rules.push({ allow: key === 'allow', pattern: val });
    else if (key === 'crawl-delay') { const d = parseFloat(val); if (!Number.isNaN(d) && d >= 0) cur.crawlDelay = d; }
  }
  return { groups };
}

function patternToRegex(p) {
  let anchored = false;
  if (p.endsWith('$')) { anchored = true; p = p.slice(0, -1); }
  const src = p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + src + (anchored ? '$' : ''));
}

// Merge all groups that apply to our product token (specific match beats '*').
function rulesFor(parsed, productToken) {
  const token = productToken.toLowerCase();
  let specific = parsed.groups.filter((g) => g.agents.some((a) => a !== '*' && a === token));
  if (!specific.length) specific = parsed.groups.filter((g) => g.agents.includes('*'));
  const rules = [];
  let crawlDelay = null;
  for (const g of specific) { rules.push(...g.rules); if (g.crawlDelay !== null) crawlDelay = g.crawlDelay; }
  return { rules, crawlDelay };
}

function isAllowed(parsed, productToken, pathAndQuery) {
  const { rules } = rulesFor(parsed, productToken);
  let best = null;
  for (const r of rules) {
    if (r.pattern === '') continue; // empty Disallow = allow all; empty Allow = no-op
    if (!patternToRegex(r.pattern).test(pathAndQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

function crawlDelayFor(parsed, productToken) { return rulesFor(parsed, productToken).crawlDelay; }

module.exports = { parseRobots, isAllowed, crawlDelayFor };
