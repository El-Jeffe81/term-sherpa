# tc-prototype: local proof of concept for a free "terms guide" (working name, not decided)

Phase: **Explain** (built on the consumption phase). Click the extension on a terms page and a window explains it in plain
English: an overview, key risks ranked High / Medium / Low with the exact quoted sentence, and a short "What you're agreeing
to" list. The analysis is **on-device fixed rules, not AI**: no model, no network, nothing sent anywhere, and **nothing is
saved by default**. The older collection code (local dataset) is still there, off unless you opt in.
Values: privacy first, protect humans, help humans. Informational tooling only, **not legal advice**.

Everything here is local to this box/device. Nothing was pushed, sent or published. There is no GitHub repo involved.

## What is in the box
| Path | What |
|------|------|
| `extension/` | Chrome MV3 extension (toolbar click -> launcher -> **Explain window**; the old collection popup is kept as the advanced view) |
| `extension/core/` | Shared pure code: text extractor, link/page detector, hashing + versioning + diff, **rules.js + analyze.js (Explain rule engine)** |
| `extension/explain/` | Launcher popup and the Explain window |
| `cli/` | `tc-collect <url>` Node CLI (robots-aware, logged-out, rate-limited, SQLite) |
| `tests/` | Offline tests (node:test) + HTML fixtures for fake sites (`tests/fixtures/sites`) + optional Chrome e2e |
| `docs/SECURITY.md` | Local-only data, what is saved, SSRF guard, untrusted text, prompt-injection note for model phases |
| `docs/live-smoke.md` | Record of the 3 live smoke fetches |
| `PARTNERS.md`, `OPEN_QUESTIONS.md` | Candidate third parties (all pending owner approval) and decisions needed |

Requirements: Node >= 22.13 (uses built-in `node:sqlite` and `node:test`). **No npm dependencies** to install.
Chrome is only needed to use the extension, and for the optional e2e.

## Run the tests
```
cd /workspace/tc-prototype
npm test                 # offline unit + CLI + security + quality + rule-engine + extension-lint tests, no network beyond 127.0.0.1 (130 tests)
npm run validate         # manifest validation
npm run test:e2e         # OPTIONAL: real headless Chrome (19 checks); skips itself if Chrome is not installed
```
The tests only talk to a local fixture server on 127.0.0.1 serving invented sites ("Acme Example", `*.test` addresses).
No real site is scraped in tests.

## Load the extension (unpacked)
1. Open `chrome://extensions`, switch on **Developer mode**.
2. **Load unpacked** and pick the `extension/` folder (after pulling new code, press the reload button on the extension card).
3. Open a terms page (or a page whose footer links to terms), click the extension icon. A window opens and explains the page.

## Explain: what you see and how it works
Click the icon on a terms page. The window shows, top to bottom:
1. A notice: **Informational, not legal advice**.
2. **Overview in plain English**: word count and read time, what the service is, what you have to do (sentences copied from the document).
3. **Key risks, highest first**: each card has a High / Medium / Low label, a plain-English explanation and the exact sentence from the page (checked word for word; anything that cannot be verified is dropped). Very long sentences are shown in exact pieces, marked "Shortened".
4. **What you're agreeing to**: one short line per topic found.
5. If the page is not a terms page, it lists the terms links it found. Pick one, open it, click the icon again. Nothing is analysed until then.

The 12 topics checked: forced arbitration, class-action waiver, jury trial waiver, data sold or shared, auto-renewal / recurring billing, the company changing the terms on its own, license to your content, liability limits and disclaimers, termination at will, governing law and venue, age requirements, tracking and cookies. The rules are in `extension/core/rules.js`; the engine is `extension/core/analyze.js`.

Storage: **nothing is saved by default**. Options in the window has a "Save copies" checkbox that switches the older collection path back on (IndexedDB, versions, diff, export; manage it from the "saved copies" link). Without it, nothing is written when you click.

Not built (parked until Jeff decides): tracking what you have agreed to, and using Chrome's built-in on-device AI.

Older collection behaviour (still in the code; used only if you turn on "Save copies", or open the advanced popup). It does this on click, and only on click:
- Injects a detector into the current tab with `chrome.scripting.executeScript` (permission `activeTab`; there is no
  `content_scripts` entry in the manifest, and no host permissions).
- It lists terms / privacy / EULA / cookie links it finds (by link text, URL patterns and common paths such as
  `/terms`, `/privacy`; it only reports links that exist on the page, it never guesses URLs). Link text and URLs are
  recognised in English, Spanish, French, German, Portuguese and Italian; the language is shown, and PDF links are flagged.
- **It saves only the terms document itself, never the page you are on.**
  - If the page you are on **is** a terms page, it extracts the main text (with sections: heading, anchor, text) and saves it.
  - If it is not, it saves **no page text**; it stores only the detected links (URL, link text, type, language, PDF flag, host
    name found on) and offers them to open. "Open this page" (or a pasted URL) marks a document as picked; open it and click
    again and that document is saved.
  - Account, checkout, payment, login, orders and similar pages are never read, even if picked. A legal hub page ("Legal":
    a page that is mostly links to terms, privacy, cookies...) is not saved as a document; its links are listed.
  - There is no "save this page" button.
- Collapsed text (`<details>`, `aria-expanded` accordions) is read from the DOM without clicking anything. Language switchers,
  nav, header, footer, cookie banners and forms are stripped; `<main>`/`<article>` is preferred.
- A PDF link is flagged "needs pdftotext" (partner pending owner approval); PDFs are not read.
- If it finds no links, it asks you to paste a URL (it opens in a new tab; click again there).
- Saved documents show in the popup with versions, a short hash, "Show last change" (diff), Delete, "Download my data (JSON)" and "Delete everything" (this also clears stored links).
- A new version is stored only when the normalised text hash changes.
- Everything saved is sanitised first (control, bidi, zero-width and tag characters are removed) and stored as plain data.

The extension **never fetches anything itself** (no `fetch`, no background worker); it only reads the tab you are looking at.

## Run the CLI
```
node cli/bin/tc-collect.js --help
node cli/bin/tc-collect.js https://example.com/terms          # fetch ONE page and store it
node cli/bin/tc-collect.js https://example.com/ --links       # list legal links on a page, store nothing
node cli/bin/tc-collect.js list | history <url> | diff <url> | export [--include-text]
node cli/bin/tc-collect.js sections <url>                      # stored sections (heading, anchor, size)
node cli/bin/tc-collect.js verify <url> --quote "exact words"   # exit 0 only if the quote is in the stored original (whitespace-normalised)
node cli/bin/tc-collect.js quality [--json]                    # dataset quality report
```
Dataset: SQLite at `~/.local/share/tc-collect/dataset.sqlite` (or `$XDG_DATA_HOME`, `$TC_COLLECT_DB`, or `--db FILE`); file mode 600.
Tables: `source`, `document` (with `needs_partner`), `version` (clean text, sha256, raw HTML, fetched_at, UA, robots result, diff to previous, language, `removed_chars`, `injection_hints`), `section` (heading, anchor, level, text), `host_throttle`. Older dataset files are migrated in place.
Exit codes: 0 ok, 1 quote not found (`verify`), 2 usage, 3 robots disallow, 4 blocked (401/403/429/451), 5 captcha/bot-check, 6 not a terms page or a legal hub (links are listed), 7 other error, 8 unsafe target (not a public site), 9 PDF (needs pdftotext).

CLI behaviour:
- Honest User-Agent: `tc-collect/0.1.0 (user-initiated personal tool; fetches one page, logged out; honors robots.txt)`.
- Checks `robots.txt` first (RFC 9309-style rules; unreachable/5xx/401/403 on robots.txt = refuse; 404 = allowed). Honors `Crawl-delay` (capped).
- Logged out only: no cookies, no Authorization header, URLs with embedded credentials are refused.
- Rate limit: default 5 s between requests to one host, remembered across runs.
- Redirects: followed (max 5), robots re-checked at every hop. 20 s timeout, 5 MB cap, HTML/plain text only. A PDF is not read: it is recorded as "needs pdftotext" (exit 9, shown by `list` and `quality`).
- **Public sites only (SSRF guard).** Refuses localhost, loopback, private and link-local addresses (IPv4 and IPv6, odd spellings, and names whose DNS resolves to them, re-checked at connect time), `file://` and every non-http(s) scheme, and any redirect or `robots.txt` hop that leads there. Exit 8. Details in `docs/SECURITY.md`.
- Terms text is untrusted: sanitised, stored as plain data, injection-style phrases flagged, quotes verified with `verify`.
- Quality: page chrome and language lists are stripped, `<main>`/`<article>` preferred, accordion text read from the DOM, documents split into sections, legal hubs refused (links listed), `quality` grades every stored document.
- **Never works around anything**: on a robots disallow, 401/403/429/451 or a captcha/challenge page it stops, says why, and does not retry.
- `export` writes metadata only unless you pass `--include-text`; text is third-party content, private until a lawyer approves any sharing.

## Privacy design
- **Local only (decided 2026-10-31):** the dataset is a file on each user's device (IndexedDB inside the extension, SQLite file for the CLI). No central collection, no analytics, no tracking, no accounts, no uploads. Tests enforce no network APIs in the extension.
- Touch nothing until the user clicks. Least permissions: `activeTab` + `scripting` only; script injected on click; nothing in the background.
- Data minimisation: only the terms document itself is stored, never the page the user is on; for other pages only links are kept. Account, checkout and payment pages are never read. Nav, header, footer, forms, inputs, cookie banners and language lists are dropped. The extension stores no raw HTML.
- The user can export and delete everything from the popup.
- Records carry `private_only = true`. Sharing or redistribution is blocked on a lawyer review (OPEN_QUESTIONS.md).
- No model is bundled or downloaded. No third-party runtime dependency (PARTNERS.md).
- Explain: the page is read on click with `activeTab`; analysis is fixed rules run inside the extension window; nothing is stored unless the user ticks "Save copies"; page text is shown with `textContent` only.

## Known limitations (honest list)
- Explain rules are sentence-level patterns: they can miss unusual wording or misread a sentence, and "nothing found" does not mean a term is absent. Severity is a rough guide. English only. Wording and severity have not had a lawyer's review. This is not legal advice.
- Built-in extractor (heuristic, no Readability). It reads collapsed text that is in the DOM, but text a page only loads when you click (lazy-loaded via JS) is not captured. PDFs are detected but not read (needs the pdftotext partner). Chrome only. Link patterns cover English, Spanish, French, German, Portuguese and Italian only; the language guess for stored text uses stop words and says "unknown" for short text.
- Chrome-removal rules are heuristics; `tc-collect quality` flags leftovers (for example cookie-banner lines) but cannot prove a page is clean. The live-smoke Wikimedia language list was fixed on fixtures; it has not been re-fetched live.
- The SSRF guard protects a user-run CLI. It is not a hardened server component (see `docs/SECURITY.md`).
- Sanitising and injection flags reduce, but do not remove, prompt-injection risk for any future model phase (see `docs/SECURITY.md`).
- A Chrome extension cannot set the `User-Agent` header, and in this design it does not fetch at all; honest-UA fetching is the CLI's job.
- The activeTab user gesture itself cannot be simulated headless, so the e2e checks the injected code in a real DOM and the real IndexedDB layer, not a physical click. A PDF opened in Chrome's viewer was not tested in the e2e (the CLI path and PDF links are).
- `node:sqlite` is flagged experimental in Node 22.
- Not tested against real logged-in sites. No real site is scraped by tests; 3 live smoke fetches are recorded.
