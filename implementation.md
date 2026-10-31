# Implementation

## CSO Concerns (read first)

Security options must be considered before anything is done.

1. Keep the dataset private. Until a lawyer signs off, share only summaries and short quotes.
2. Respect each site's rules and never get around blocks.
3. Fetch while logged out, so no user data gets in.
4. Check open-source licenses before reusing anything.

## Current Phase

Consumption only: go out and find, look at, and collect terms and conditions text into a dataset. Implementation and advising come later, as a separate discussion.

Decision (2026-10-31): the dataset stays local, a file on each user's device. No central collection.

## Explain phase

Status: built on branch `wip/terms-explain` (PR into `groks-go-forward-plan`). Advice is still out of scope: this phase only **explains** the terms page the user is looking at.

What was built
- Clicking the extension icon opens a small launcher, which opens a window (`explain/explain.html`) for the current tab. The page is read with `activeTab` + `scripting` on that click. No `content_scripts`, no background worker, and no host access up front (from v0.3.0 there is one *optional* host permission, see "The agree dialog" below).
- The window is short on purpose (revised after testing on a real news site's Terms of Use): (1) a 3-line overview: which site and kind of document, the detected type of service, and one headline takeaway; (2) "Worth knowing": the High and Medium points; (3) "Also agreeing to": the Low points. Each point is **one plain sentence** (for example "You can't sue them in a class action lawsuit."), with a badge and, when the type of service changed its weight, a one-line note. The exact quote(s) from the page are behind a collapsed "Show exact wording" toggle. No word count, read time, topic counts or copied passages.
- A clear "Informational, not legal advice" notice is at the top of the window and in the analysis result.
- If the current page is itself a terms page, only its own text is explained. If it is not, and it shows an "I agree" dialog, consent banner or sign-up prompt, the window explains the documents that prompt links to (next section). Otherwise it lists the legal links it found, collapsed to one entry per document.

How it works
- The analysis is **on-device rules, not AI**. `extension/core/rules.js` holds 12 rules (forced arbitration, class-action waiver, jury trial waiver, data sold/shared, auto-renewal/recurring billing, unilateral changes, license to user content, liability limits and disclaimers, termination at will, governing law and venue, age requirements, tracking and cookies). Each rule has regex patterns, exclusions (to avoid "we do not sell your data" false alarms), severity escalators and mitigators (for example an arbitration opt-out lowers High to Medium), and a plain-English explanation.
- Each rule (and, where the wording matters, each pattern) carries a fixed one-sentence `line` written by us; page text is never pasted into it. Rules that make the same point are merged: arbitration, the class-action waiver and the jury waiver become one line built from the parts found ("Disputes go to private arbitration: no court, no jury, and no class action lawsuits."), with all their exact quotes kept behind the toggle. One item per point, no repetition between overview and list.
- **Context.** `extension/core/context.js` guesses the kind of service on-device from the site name and wording: news / media, shopping, social / user content, finance, app / software / subscription, or not clear. A weak or tied result is "not clear" and changes nothing. A matrix in `rules.js` then moves a finding up or down one step for that kind of service (for example limited liability is Low on a news site but High on a bank or shop; auto-renewal weighs more on subscriptions; a content licence weighs more on social platforms), and a note says so. Deterministic, no AI. The matrix values are judgement calls and need review.
- `extension/core/analyze.js` splits the text into sentences, applies the rules, merges, applies context, ranks the findings (severity, then rule priority) and builds the 3-line overview. Every quote is checked with the existing exact-quote verifier (`quote.js`) and dropped if it is not in the page text word for word. Very long sentences are cut to exact contiguous pieces and labelled "Shortened".
- No network calls, no paid services, no third-party dependencies (still zero npm deps).
- Page text is untrusted: it is sanitised, rendered with `textContent` only (never `innerHTML`), and injection-style phrases are only reported, never acted on.

### The agree dialog: explain what the user is about to agree to (v0.3.0; fetch hardening in v0.3.1)

Why: people meet the terms at an "I agree" prompt (for example a news site's "Legal Terms and Privacy" Agree dialog), not on a terms page, and privacy policies are part of what they accept. Opening each document by hand was too much work, and a hub page listing 18 regional copies of one privacy policy was unusable.

What happens on the toolbar click
- The injected script (`core/consent.js`, run with the same one-time `activeTab` injection) looks for an agree/consent prompt: a modal dialog, a consent banner, an inline "By clicking ... you agree to ..." line, or an "I have read" checkbox, with buttons such as Agree, I agree, Accept, Continue, Accept all. It collects the legal documents linked from that prompt (terms, privacy, cookie policy, EULA, community guidelines, subscription terms, arbitration agreement, ...). Footer links alone do not count as a prompt. **It never clicks, ticks or changes anything on the page.**
- The explain window fetches those documents itself (`core/docfetch.js`, at most 6, one request each, no crawling) and shows **one** combined explanation in the usual concise format: overview line 1 names the documents ("host: Terms, Privacy, Cookies (from the agree dialog)"), key risks are one sentence each with a source label ("Terms", "Privacy", "Terms + Privacy"), the exact wording is collapsed and labelled "From Privacy:" etc., and the same point found in several documents is one line with all its quotes. A "Documents read" list at the bottom shows what was read or not.
- Regional and language duplicates (`/en-us`, `/fr-fr`, `?lang=`, country domains) are collapsed to one entry per document type, preferring the user's browser language/region, then US English. Link lists show 3 entries and a "Show more" toggle.
- Severity floor: forced arbitration, class-action and jury waivers, data sale/sharing and a broad content licence never drop below Medium for any type of service, so a page disguised as news cannot hide them. (A rule that is Low in its own right, such as ordinary service-provider sharing, stays Low.)

The new permission (the only manifest change)
- `"optional_host_permissions": ["https://*/*"]` (version 0.3.0). Nothing is granted at install. When the user has clicked the icon and a prompt was found, the window calls `chrome.permissions.request` for only the origin(s) of the linked documents (for example `https://docs.example.com/*`), and Chrome shows its own prompt. Why it is needed: an extension page cannot read another site's pages without host access, and the documents are usually on a different host than the page. Why it is optional: nothing can be read before the user clicks and then approves that site; the grant can be removed again (Options, "Remove the site access I have allowed", or chrome://extensions).
- `chrome.permissions.request` needs a user gesture, and the toolbar click does not carry over into the window. So if access is not yet granted the window shows a button ("Read these 4 documents"); that click is the gesture. After the first approval of a site there are no extra clicks.
- No `host_permissions`, no `content_scripts`, no background. `permissions` is unchanged (`activeTab`, `scripting`).

How documents are fetched (CSO concerns 2 and 3)
- https only; the SSRF guard (`core/netguard.js`) rejects loopback, private, link-local and credentialed URLs; since v0.3.1 bare IP-address hosts are refused too, and redirects are not followed at all (below). Sensitive paths (account, checkout, login) and PDFs are never fetched (a link is offered instead).
- GET with `credentials: 'omit'` (logged out, no cookies), `referrerPolicy: 'no-referrer'`, `cache: 'no-store'`, no custom headers except Accept, and the browser's own User-Agent (an extension cannot set it). 12 s timeout, 2 MB cap (declared length and streamed), html/xhtml/plain only. A fetched legal hub is not followed.
- The response is parsed with `DOMParser` in the extension page (`explain/domparse.js`), which does not run scripts or load images or other resources; the text goes through the same extractor and sanitiser as page text and is rendered with `textContent` only. A document with under 200 characters of text (needs JavaScript) is reported as not read, with its link.
- Fetched text is analysed in memory and **not saved** unless the "Save copies" opt-in is on.
- Redirects (v0.3.1): `redirect:'manual'`. Any redirect makes that document "not read" with its own link; the redirect target is never requested. Reason: vetting a target before the request goes out needs `declarativeNetRequest`, which shows the install warning "Block content on any page"; `declarativeNetRequestWithHostAccess` has no warning but does not apply to sites the extension has no access to (the exact case here). Both facts were measured in headless Chrome (`npm run probe:dnr`, `tests/e2e/dnr-probe.mjs`). No new permission was added. Cost: harmless same-site redirects (`/terms` to `/terms/`) also show as links.
- robots.txt (v0.3.1, `core/robots.js`): before each document the window GETs `https://<site>/robots.txt` the same guarded way (https, no cookies, no referrer, no cache, no redirects, 4 s timeout, first 512 KiB, at most 2000 rules). It applies the `User-agent: *` group (our requests carry the browser's own User-Agent, so no site can address us by a name), longest match wins, Allow wins ties, `*` and `$` supported (no regular expressions, so a hostile file cannot cause backtracking). A disallow skips the document and shows its link with a short reason. Missing (4xx), 5xx, unreadable, slow, redirected or unparseable robots.txt means the fetch is allowed. The result is cached per site in memory for that one analysis and never saved.

Tests added: dialog detection (modal with Terms + Privacy links, cookie banner, inline prompt, checkbox, no dialog, footer links not counted), regional link dedupe and locale ranking, document-type labelling, the severity floor, URL guard on fetched links and redirects, fetch limits (size, time, type, redirects, hostile pages), combined analysis (dedupe across documents, source labels), manifest validation, and a headless-Chrome e2e: a CNN-style Agree dialog page plus linked Terms, Privacy, Cookies and (hostile) Community Guidelines pages on a local https server (a self-signed certificate; `*.test` host mapped to 127.0.0.1 inside the test Chrome only, so production code has no test bypass). The e2e checks that the page's Agree button is never clicked, the real manifest fetches nothing before approval, the fetch carries no cookies or Referer, the hostile document runs no script and loads no image, a JS-only document is reported as unread, and 18 regional privacy links collapse to one entry.

Terms are **not saved by default**
- Clicking the icon stores nothing. The earlier "collect" code path (IndexedDB, versions, diff, export) is kept and available, but it is **off**; it is switched on only by an explicit "Save copies" checkbox in the window's Options. The old popup is still reachable from Options as the advanced collection view. No files were deleted.
- The only other thing kept is the picked terms link, for one hour, in `localStorage` (a URL, no terms text).

Tests
- `tests/rules.test.js`: every rule has positive and negative fixtures; ranking and stability, quote exactness (including odd whitespace, wrapped lines, curly quotes, abbreviations, long sentences), dedupe and merging, one-sentence lines, context detection and the context matrix (news vs finance liability), evidence cap, hostile text, the 3-line overview with no filler, huge and empty input, and a static scan that the engine contains no network, AI or dynamic-code calls.
- `tests/extension.test.js`: launcher, single page-read point, textContent only, collapsed exact-wording toggle and no filler text, off-by-default storage, no AI APIs, script order (context.js before analyze.js), docs.
- `tests/e2e/chrome-smoke.mjs` (headless Chrome, extension loaded unpacked): the Explain window renders the real injected-script result: ranking, collapsed exact quotes that are verbatim, no word count, a news-site fixture judged in context, hostile text stays text, nothing is written to IndexedDB by default, opt-in writes one copy, no non-extension network requests.

Known limits
- The type-of-service guess can be wrong or "not clear"; the context adjustments are judgement calls. Rules are sentence-level patterns. They can miss unusual wording or misread a sentence, and "nothing found" is not proof that a term is absent. Severity is a rough guide, not a verdict.
- The wording of the plain-English explanations and the severity choices have not been reviewed by a lawyer.
- English only. The real `activeTab` toolbar click cannot be simulated headless, so the e2e feeds the window the real injected-script output instead of a physical click.
- Chrome's permission prompt cannot be answered headless, so the e2e runs the full agree-dialog flow on a temporary copy of the extension whose only change is that `https://*/*` is a normal `host_permissions` entry. The real manifest is tested up to the point of the prompt (a real mouse click is sent, nothing is fetched without an answer). The real prompt and a real site's dialog (for example cnn.com) need a manual check in headed Chrome.
- JavaScript-only documents are not read. The static address guard cannot see DNS (a public name that resolves to a private address); the per-site Chrome prompt is the barrier there. Regional dedupe is heuristic and can merge two genuinely different regional policies (for example `/privacy/ca` and `/privacy/us`); the merged entry says how many versions were collapsed. Dialog detection is heuristic and can miss custom consent widgets or dialogs inside iframes. A terms page ignores any consent banner it shows itself.

Parked (needs Jeff's decision, nothing built)
- **"Track what I've agreed to"**: a record of the terms a user accepted, with dates and versions. Not built; it would store personal data and needs a design and privacy decision first.
- **Chrome's built-in on-device AI (Prompt API)**: not used and not wired in. Needs Jeff's approval first.
