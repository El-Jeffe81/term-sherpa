#!/usr/bin/env node
'use strict';
process.removeAllListeners('warning'); // node:sqlite prints an ExperimentalWarning on some Node versions
const path = require('node:path');
const fs = require('node:fs');
const { openStore, defaultDbPath } = require('../src/store');
const { createFetcher, Refusal, EXIT, buildUserAgent } = require('../src/fetcher');
const { collectUrl, listLinks } = require('../src/collect');
const V = require('../../extension/core/versioning');
const Quote = require('../../extension/core/quote');
const Qual = require('../../extension/core/quality');
const U = require('../../extension/core/untrusted');

const HELP = `tc-collect - collect terms/privacy/EULA/cookie text into a LOCAL dataset (SQLite).

Usage:
  tc-collect <url> [options]        fetch ONE page (logged out, robots.txt checked) and store it
  tc-collect <url> --links          list legal links found on that page (stores nothing)
  tc-collect list                   list stored documents
  tc-collect history <url>          list stored versions of a document
  tc-collect diff <url> [--from N --to N]   show the diff between two versions (default: last two)
  tc-collect export [--out FILE] [--include-text]   JSONL export (metadata only unless --include-text)
  tc-collect sections <url> [--version N]   list the stored sections (heading, anchor, size) of a document
  tc-collect verify <url> --quote "text" [--version N]   check a quote EXACTLY against the stored original
                                    (only whitespace is normalised); exit 0 verified, 1 not found
  tc-collect quality [--json]       dataset quality report (short text, lost structure, leftover page chrome,
                                    language, PDFs waiting for pdftotext, ...)

Options:
  --type <tos|privacy|eula|cookies|other>   store even if it does not look like a terms page
  --db <file>        dataset file (default: ${defaultDbPath()}; or env TC_COLLECT_DB)
  --delay <ms>       minimum gap between requests to one host (default 5000)
  --contact <text>   optional contact info to add to the User-Agent
  --no-raw           do not store the raw HTML
  -h, --help

Refuses (does not work around): robots.txt disallow, HTTP 401/403/429/451, captcha/bot-check pages, and any
address that is not a public http(s) site: localhost, loopback, private, link-local (IPv4 and IPv6, including a
name that resolves to one), file:// and other schemes, and redirects that lead to any of them (checked at every hop).
PDFs are not read: they are marked "needs pdftotext" (partner pending owner approval).
Exit codes: 0 ok, 1 quote not found, 2 usage, 3 robots, 4 blocked, 5 captcha, 6 not a terms page / legal hub,
            7 other error, 8 unsafe target (not a public site), 9 PDF (needs pdftotext).
Data stays on this device. No analytics, no uploads. Not legal advice.`;

function parseArgs(argv) {
  const o = { _: [], flags: {} };
  const withVal = new Set(['--type', '--db', '--delay', '--contact', '--from', '--to', '--out', '--quote', '--version']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.flags.help = true;
    else if (withVal.has(a)) { o.flags[a.slice(2)] = argv[++i]; }
    else if (a.startsWith('--')) o.flags[a.slice(2)] = true;
    else o._.push(a);
  }
  return o;
}

// opts.allowOrigins / opts.resolve: offline test harness only (tests/helpers/cli-test-entry.js). Never read from argv or env here.
async function run(argv, opts = {}) {
  const { _: pos, flags } = parseArgs(argv);
  if (flags.help || !pos.length) { console.log(HELP); return flags.help ? 0 : EXIT.usage; }
  const types = ['tos', 'privacy', 'eula', 'cookies', 'other'];
  if (flags.type && !types.includes(flags.type)) { console.error(`--type must be one of: ${types.join(', ')}`); return EXIT.usage; }
  const delayMs = flags.delay !== undefined ? parseInt(flags.delay, 10) : 5000;
  if (Number.isNaN(delayMs) || delayMs < 0) { console.error('--delay must be a number of milliseconds'); return EXIT.usage; }

  const cmd = pos[0];
  const store = openStore(flags.db);
  try {
    if (cmd === 'list') {
      const rows = store.listDocs();
      if (!rows.length) console.log('(nothing stored yet)');
      for (const r of rows) {
        if (r.needs_partner) console.log(`${r.doc_id}\t${r.doc_type}\tNEEDS ${r.needs_partner}\t-\t${r.last_checked_at}\t${U.printable(r.url)}`);
        else console.log(`${r.doc_id}\t${r.doc_type}\tv${r.versions}\t${(r.sha256 || '').slice(0, 12)}\t${r.fetched_at}\t${U.printable(r.url)}`);
      }
      return 0;
    }
    if (cmd === 'history' || cmd === 'diff') {
      if (!pos[1]) { console.error(`usage: tc-collect ${cmd} <url>`); return EXIT.usage; }
      const doc = store.getDoc(pos[1]);
      if (!doc) { console.error('Not in the dataset: ' + pos[1]); return EXIT.error; }
      const vs = store.getVersions(doc.doc_id);
      if (cmd === 'history') {
        for (const v of vs) console.log(`v${v.seq}\t${v.fetched_at}\t${v.content_hash_clean.slice(0, 12)}\t${v.clean_text.length} chars`);
        return 0;
      }
      if (vs.length < 2 && !flags.from) { console.log('Only one version stored; nothing to diff.'); return 0; }
      const to = flags.to ? vs.find((v) => v.seq === +flags.to) : vs[vs.length - 1];
      const from = flags.from ? vs.find((v) => v.seq === +flags.from) : vs[vs.indexOf(to) - 1];
      if (!from || !to) { console.error('Version not found.'); return EXIT.usage; }
      const d = V.lineDiff(from.clean_text, to.clean_text);
      console.log(`--- v${from.seq} (${from.fetched_at})\n+++ v${to.seq} (${to.fetched_at})\n+${d.added} -${d.removed} lines\n${d.text}`);
      return 0;
    }
    if (cmd === 'sections' || cmd === 'verify') {
      if (!pos[1]) { console.error(`usage: tc-collect ${cmd} <url>`); return EXIT.usage; }
      if (cmd === 'verify' && (flags.quote === undefined || flags.quote === true)) { console.error('usage: tc-collect verify <url> --quote "text"'); return EXIT.usage; }
      const doc = store.getDoc(pos[1]);
      if (!doc) { console.error('Not in the dataset: ' + pos[1]); return EXIT.error; }
      const vs = store.getVersions(doc.doc_id);
      if (!vs.length) { console.error('No text stored for this document' + (doc.needs_partner ? ` (needs ${doc.needs_partner}).` : '.')); return EXIT.error; }
      const v = flags.version ? vs.find((x) => x.seq === +flags.version) : vs[vs.length - 1];
      if (!v) { console.error('Version not found.'); return EXIT.usage; }
      const secs = store.getSections(v.version_id);
      if (cmd === 'sections') {
        if (!secs.length) console.log('(no sections stored for this version; re-collect to refresh)');
        for (const x of secs) console.log(`${x.idx}\t${'#'.repeat(x.level || 0) || '-'}\t${U.printable(x.heading, 70) || '(intro)'}\t#${U.printable(x.anchor)}\t${x.text.length} chars`);
        return 0;
      }
      // The quote is checked against the STORED ORIGINAL text only.
      const r = Quote.verifyQuoteInSections(secs, v.clean_text, flags.quote);
      if (flags.json) console.log(JSON.stringify({ verified: r.verified, reason: r.reason, version: v.seq, section: r.section, occurrences: r.occurrences }));
      else if (r.verified) console.log(`VERIFIED: found exactly in v${v.seq}` + (r.section ? ` (section "${U.printable(r.section.heading, 70) || '(intro)'}" #${U.printable(r.section.anchor)})` : ' (spans sections)') + (r.occurrences > 1 ? `; appears ${r.occurrences} times` : ''));
      else console.log(`NOT VERIFIED (${r.reason}): this quote is not in the stored text of v${v.seq}. Do not show it as a quote.`);
      return r.verified ? 0 : EXIT.notFound;
    }
    if (cmd === 'quality') {
      const rep = Qual.buildReport(store.qualityRows());
      if (flags.json) { console.log(JSON.stringify(rep, null, 2)); return 0; }
      console.log(`Dataset quality report (${store.file})\n  documents: ${rep.total}`);
      if (!rep.total) { console.log('  (nothing stored yet)'); return 0; }
      const fmt = (o) => Object.keys(o).sort().map((k) => `${k}=${o[k]}`).join('  ') || '-';
      console.log(`  grade:     ${fmt(rep.by_grade)}\n  type:      ${fmt(rep.by_type)}\n  language:  ${fmt(rep.by_language)}\n  issues:    ${fmt(rep.by_issue)}\n`);
      for (const d of rep.documents) {
        console.log(`[${d.grade.toUpperCase()}] ${d.doc_type}\t${d.chars} chars, ${d.sections} sections, v${d.versions}\t${U.printable(d.url, 100)}`);
        for (const i of d.issues) console.log(`    - ${i.code}: ${U.printable(i.detail, 160)}`);
      }
      return 0;
    }
    if (cmd === 'export') {
      const out = flags.out ? fs.createWriteStream(flags.out, { mode: 0o600 }) : process.stdout;
      for (const d of store.listDocs()) {
        const doc = store.getDoc(d.url);
        const vs = store.getVersions(doc.doc_id);
        const rec = { url: d.url, final_url: d.final_url, doc_type: d.doc_type, first_seen_at: d.first_seen_at, last_checked_at: d.last_checked_at, private_only: true,
          versions: vs.map((v) => ({ seq: v.seq, fetched_at: v.fetched_at, sha256: v.content_hash_clean, chars: v.clean_text.length, ...(flags['include-text'] ? { text: v.clean_text, diff_from_prev: v.diff_from_prev } : {}) })) };
        out.write(JSON.stringify(rec) + '\n');
      }
      if (flags.out) await new Promise((r) => out.end(r));
      if (flags['include-text']) console.error('Note: export contains third-party text. Keep it private until a lawyer approves any sharing.');
      return 0;
    }

    // collect
    const url = cmd;
    try { new URL(url); } catch { console.error('Not a valid URL: ' + url); return EXIT.usage; }
    const fetcher = createFetcher({ delayMs, contact: flags.contact, persistThrottle: store.persistThrottle, allowOrigins: opts.allowOrigins, resolve: opts.resolve });
    if (flags.links) {
      const r = await listLinks(url, { fetcher });
      if (!r.links.length) console.log('No terms/privacy/EULA/cookie links found on ' + r.finalUrl + '. Paste the URL of the document directly.');
      if (r.isHub) console.log('This looks like a legal hub page. Pick the documents you want and run tc-collect on each.');
      for (const l of r.links) console.log(`${l.doc_type}\t${l.confidence}\t${l.language}${l.is_pdf ? '\tPDF (needs pdftotext)' : ''}\t${U.printable(l.url)}\t${U.printable(l.text, 80)}`);
      return 0;
    }
    const noRaw = !!flags['no-raw'];
    const wrappedStore = noRaw ? { ...store, saveVersion: (r) => store.saveVersion({ ...r, rawBuffer: null }) } : store;
    const r = await collectUrl(url, { store: wrappedStore, fetcher, docType: flags.type });
    const msg = { new: 'stored (first version)', changed: `stored NEW version v${r.seq} (+${r.added} / -${r.removed} lines)`, unchanged: `unchanged since v${r.seq}; nothing new stored` }[r.status];
    console.log(`${r.docType}: ${msg}\n  url: ${r.finalUrl}\n  sha256: ${r.sha256}\n  chars: ${r.chars}, sections: ${r.sections}, language: ${r.language}\n  db: ${store.file}`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`REFUSED (${e.kind}): ${U.printable(e.message, 400)}`);
      if (e.marked) console.error(`  Marked in the dataset as ${e.marked.docType}, needs ${e.marked.partner} (no text stored).`);
      if (e.links && e.links.length) {
        console.error('Possible legal links on that page (run tc-collect on one of them):');
        for (const l of e.links) console.error(`  ${l.doc_type}\t${l.language}${l.is_pdf ? '\tPDF' : ''}\t${U.printable(l.url)}\t${U.printable(l.text, 80)}`);
      }
      return e.exitCode;
    }
    console.error('Error: ' + (e && e.message || e));
    return EXIT.error;
  } finally { store.close(); }
}

if (require.main === module) run(process.argv.slice(2)).then((c) => { process.exitCode = c; });

module.exports = { run };
