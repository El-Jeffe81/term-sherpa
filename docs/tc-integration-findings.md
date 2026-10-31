# Terms-and-Conditions: integration findings (research only)

Researched 2026-10-27 (America/New_York). Nothing was created, modified, pushed or sent anywhere. Every claim has a URL. Items marked **[unverified]** or **[my analysis]** were NOT confirmed from a source this session.
This is an informational explainer, **not legal advice**. All partner tools below are suggestions; the owner approves each one.

---

## 0. BASELINE (web T&C pages only): a "terms explainer" / "terms guide"

> The name ("terms explainer" / "terms guide" vs. anything else) is the owner's decision. This file deliberately avoids calling it a "legal assistant".

Goal: a free, private tool that, only after the user says "please help me", finds, reads and explains a website's terms and privacy policy in plain English with risks. It is not legal advice and says so in every answer.

### FIND: locate the T&C / privacy page (only after "please help me")
1. **Nothing runs until the click.** Use a Manifest V3 extension with the `activeTab` permission (plus `scripting`). Per Chrome docs, `activeTab` gives temporary access to the current tab only when the user invokes the extension (action click, context menu, keyboard shortcut, omnibox). Access ends when the user navigates to another origin or closes the tab, and no install-time warning is shown. Source: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
2. **Case A, the user is already on the terms page:** read that page's DOM directly. The browser already loaded it, so no extra request is made.
3. **Case B, the user is on a sign-up or download page:** inject a small content script (via `scripting.executeScript`) that scans `<a>` elements in the page, footer and sign-up form. Match on link text ("Terms", "Terms of Service/Use", "Privacy", "Privacy Policy", "Conditions", "EULA", "Cookie", "Legal") and on href patterns such as `/terms`, `/tos`, `/privacy`, `/legal`. **[my analysis]** These are heuristics, not a standard. Show the user the candidates and let them confirm.
4. **Fallback:** if no link is found, ask the user for the URL. Do not guess-crawl.
5. **Cross-check (optional, owner approval):** ToS;DR's "terms-types" list names standard document types (Terms of Service, Privacy Policy, ...). https://docs.opentermsarchive.org/terms/reference/declaration (section "terms"). Reuse the vocabulary only.

### CONSUME: get and clean the live legal text
1. **Preferred, zero extra network:** extract from the DOM of the tab the user is already on, with Mozilla Readability (Apache-2.0, https://github.com/mozilla/readability). Google's own sample extension does exactly this, then summarizes on-device: https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/ai.gemini-on-device-summarization
2. **If the policy is on another URL:** fetch it once, **logged out, no cookies, no account**, from the user's own machine, with an **honest User-Agent** that names the tool. Check that origin's `robots.txt` first and skip if disallowed. Fetch slowly (one request per user action, no crawling). **Never bypass blocks, captchas or paywalls.** If blocked, tell the user and offer to open the page for them to select the text (they can paste it).
3. **Handle:** redirects (follow max ~5, record the final URL); PDFs (extract text locally, e.g. poppler `pdftotext`, GPL, used as an external tool; **[my analysis]**); JS-rendered pages (the activeTab DOM is already rendered, which is a big advantage over server-side scraping; Open Terms Archive needs a headless browser for this, see section 4); per-region/language variants (record locale; OTA treats region-varying content as a hazard, https://raw.githubusercontent.com/OpenTermsArchive/docs/main/content/concepts/design-principles.md).
4. **Clean:** Readability, then convert to Markdown (turndown, MIT, https://github.com/mixmark-io/turndown), strip nav/ads. Always keep the raw HTML/text alongside the cleaned text so the cleaning can be audited.
5. **Change detection:** SHA-256 of the cleaned text, compare to the last stored hash, store a new version and a diff only if changed. OTA does the same at 12h cron by default (https://raw.githubusercontent.com/OpenTermsArchive/docs/main/content/collections/reference/configuration.md). For a personal tool, check only when the user asks (no background polling).

### REPORT: explain in plain English, store privately
1. **Summarize locally.** Options verified in section 5 (Chrome built-in Summarizer API on Gemini Nano; llama.cpp, WebLLM, transformers.js with small open-weight models). No cloud API, no analytics, no telemetry.
2. **Answer format** (always the same): (a) what you're agreeing to, 5-8 bullets; (b) **risks** flagged, each with a short **verbatim quote** and where it is (e.g. data sharing/selling, tracking, arbitration or class-action waiver, auto-renewal, unilateral changes, account termination, content licence, data retention, children's data); (c) "what I couldn't find"; (d) "informational only, not legal advice". **[my analysis]** Small models can miss or invent clauses, so the quote is mandatory and the user can click to the source passage.
3. **Store** each analysed document in a **private, local, versioned** SQLite file (schema in section 6); nothing leaves the device.
4. **Hard limits:** no scraping at scale, no redistribution of third-party text (see section 7), no paid services, no data harvesting, no telemetry.

### Later (brief notes only): app stores
- **Google Play:** the public listing HTML links the developer's privacy policy (verified for one app; the `google-play-scraper` library exposes `privacyPolicy` and `datasafety`). BUT Play's robots.txt disallows `/store/apps/datasafety*`, and there is no public API for other developers' listings; the Play Developer API is only for your own account/apps. Treat as "user pastes the URL/text" until the owner and a lawyer approve more. Details in section 3.
- **Apple App Store:** the public listing HTML (apps.apple.com) shows the developer's privacy policy link and "App Privacy" label (verified for one app). The iTunes Lookup API has no privacy fields (verified for one app). Details in section 3.

---

## 1. CSO flags and how the design honours them

| # | Flag | Design response |
|---|------|-----------------|
| 1 | Keep the dataset private; ship only summaries and short quotes until a lawyer signs off | Local SQLite only; no sync, no upload, no public repo. Exports to the user only. Output = summary + short quotes. Redistribution of full text is off until counsel approves. |
| 2 | Check each source's terms and robots.txt, fetch slowly, identify honestly, never get around blocks; quote actual clauses | robots.txt check before any fetch; honest UA; 1 request per user action; stop on 403/429/captcha. Actual clauses quoted in section 3. |
| 3 | Fetch logged out, no cookies/accounts | Service worker fetch with `credentials: 'omit'`; no stored sessions. DOM-read case only sees what that tab already shows (note: a logged-in tab's DOM could contain account info, so extract only the legal-document container and drop the rest before storing. **[my analysis]**). |
| 4 | Report OTA code and data licences separately | See section 4 table. |
| + | Summarize locally or on our own server, no analytics | Section 5. |
| + | Not "legal assistant"; informational only | Name is the owner's decision; disclaimer on every output. |

Note on my own research probes: I made single logged-out GET requests (browser-style User-Agent, no cookies) to the public Play listing, Apple listing, robots.txt files and policy pages, only to verify what they contain. The product must use an honest UA instead.

---

## 2. Q2: Web browser (primary focus)

**Approach:** MV3 extension, `activeTab` + `scripting`, user-gesture only (https://developer.chrome.com/docs/extensions/develop/concepts/activeTab). Content script finds legal links; Readability extracts text; local summarizer explains.

**What's possible**
- Read the page the user is on with no broad host permissions (activeTab grants temporary host permission to that tab; same source).
- Fetching a *different* origin's policy from the service worker needs host permission for that origin. **[unverified]** Chrome's `optional_host_permissions` can request it at click time; confirm in https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions before building. Alternative needing no extra permission: have the user open the policy link and click the extension again (activeTab on the new page).
- Readability: Apache-2.0, standalone library, https://github.com/mozilla/readability (licence confirmed via GitHub API).
- Chrome extension cannot touch `chrome://` pages (same activeTab doc).

**Limits**
- Pages that load text only after interaction (cookie walls, accordions) may need the user to expand them first.
- Readability is tuned for articles; legal pages with tables/numbered clauses may lose structure, so keep raw text too. **[my analysis]**
- Chrome-only first; Firefox/Safari differ **[unverified]**.

**Risks**
- Extension permission scope (keep to activeTab; no `<all_urls>`).
- Sending page text or visited domains to any third party breaks the privacy-first rule. Summarize on-device.
- Site terms vs. automated access: see below.

**Site terms / robots.txt limits for automated access**
- robots.txt is the machine-readable signal; Google's ToS makes ignoring it a violation for Google's own services: Google Terms of Service (https://policies.google.com/terms) prohibit "using automated means to access content from any of our services in violation of the machine-readable instructions on our web pages (for example, robots.txt files that disallow crawling, training, or other activities)" and list "scraping content that doesn't belong to you" as conduct that can cause account disablement. (Quoted from the live page, fetched 2026-10-27.)
- Apple's site terms (https://www.apple.com/legal/internet-services/terms/site.html) state: "You may not use any "deep-link", "page-scrape", "robot", "spider" or other automatic device, program, algorithm or methodology, or any similar or equivalent manual process, to access, acquire, copy or monitor any portion of the Site or any Content ... Apple reserves the right to bar any such activity." (Quoted from live page.) Whether these site terms govern apps.apple.com listing pages specifically is **[unverified]**; treat them as applying.
- General sites: every site has its own terms; check them before fetching. Legal enforceability of scraping clauses varies by jurisdiction. **[unverified; needs a lawyer]** Safest posture for the tool: user-initiated, single-page, private, logged-out, honest UA, robots-respecting.

### Candidate free tools (suggestions only)
| Tool | Use | Licence | Notes / source |
|------|-----|---------|----------------|
| Mozilla Readability | main-text extraction | Apache-2.0 | https://github.com/mozilla/readability |
| turndown | HTML to Markdown | MIT | https://github.com/mixmark-io/turndown |
| ToS;DR (tosdr.org) | community ratings/summaries | see below | https://docs.tosdr.org/developer/tos-dr-developers/service |
| Open Terms Archive | versioned T&C archive + software | see section 4 | https://docs.opentermsarchive.org/ |

**ToS;DR details**
- Public API: `GET https://api.tosdr.org/service/v3?id=...&lang=en` (docs: https://docs.tosdr.org/developer/tos-dr-developers/service). A search endpoint also works unauthenticated; I got a service record for `yelp.com` (rating "E") from `https://api.tosdr.org/search/v5/?query=yelp.com`. The API terms for the *current* API were not located; **[unverified]**.
- Legacy API data was published under CC BY-SA 3.0 with an AGPL-3.0 "larger program" exception (https://tosdr.github.io/tosdr.org/api.html and https://tosdr.github.io/tosdr.org/legal.html). Whether the current API data keeps this licence is **[unverified]**.
- Code licences (GitHub API): `browser-extensions` AGPL-3.0 (https://github.com/tosdr/browser-extensions), `edit.tosdr.org` AGPL-3.0, `tosdr-declarations` AGPL-3.0, `ToSBack3` AGPL-3.0, `tosdr-versions`/`tosdr-snapshots` no clear licence in the API metadata. AGPL is strong copyleft: embedding it would make our code AGPL.
- **Conflicts with our constraints:** calling their API sends the domain the user is viewing to a third party (privacy), and depends on their ongoing goodwill/uptime. If used at all: optional, off by default, owner-approved, ideally from a user-triggered request only. Prefer a locally cached copy of their data if their licence and terms allow **[unverified]**.

---

## 3. Q1 Google Play and Q3 Apple App Store (brief, "later")

### Google Play
- **Policy link on listing:** Play requires every app to post a privacy-policy link in Play Console and in-app; the policy must be on a public, non-geo-fenced URL (no PDFs) and clearly labelled (https://support.google.com/googleplay/android-developer/answer/10144311). The Data safety form is also required for all published apps (https://support.google.com/googleplay/android-developer/answer/10787469) and is shown on the store listing. Developers are solely responsible for its accuracy (same page), i.e. it is self-declared, not verified.
- **Verified on a live listing:** the listing HTML for `com.yelp.android` contains the developer's privacy link (`yelp.com/static?p=privacy`) (my fetch, 2026-10-27).
- **Official API:** the Google Play Developer API is for developers' own apps. Access is via a service account or OAuth client whose actions are "limited to those permitted via the Users and permissions page on the Google Play Console" (https://developers.google.com/android-publisher/getting_started). I found no public API for other developers' listings, consistent with the CSO note.
- **robots.txt:** `https://play.google.com/robots.txt` disallows `/store/apps/datasafety*` (and `/store/xhr`, `/store/apps/collection/p3_details_*`), so automated fetching of the Data-safety page is disallowed. Individual `/store/apps/details?id=...` pages are not listed as disallowed in the portion I read **[verify the full file before use]**.
- **Terms:** Play ToS (https://play.google.com/intl/en/about/play-terms/, version dated July 29, 2026, update due November 17, 2026) incorporates the Google ToS; the robots.txt/scraping clause above therefore applies. The Play ToS also says users "must not collect or harvest any personal data of any user of Google Play".
- **Open-source scrapers:** `facundoolano/google-play-scraper` (Node.js, MIT, last push 2026-10-17; README says the maintainer no longer actively maintains it and to "expect the parser to break when Google Play's layout changes"; it hits throttling/captchas (503) and can get an IP banned) https://github.com/facundoolano/google-play-scraper . Its `app()` returns `privacyPolicy`; `datasafety()` returns collected/shared data, security practices and `privacyPolicyUrl` (README: https://raw.githubusercontent.com/facundoolano/google-play-scraper/dev/README.md). Python port `JoMingyu/google-play-scraper`, MIT, last push 2024-08-05. **Recommendation:** do not ship scrapers that hit `datasafety` (robots-disallowed) or bypass throttling. Safer: user opens the listing and uses the browser flow in section 0; or user pastes the policy URL.

### Apple App Store
- **Policy URL and label on listing:** Apple requires a public Privacy Policy URL for every app; the "App Privacy" label is entered by developers in App Store Connect (https://developer.apple.com/app-store/app-privacy-details/). Apple's own page says the label is developer-declared; the listing text says "This information has not been verified by Apple" (seen in my fetch of the Yelp listing, `apps.apple.com/us/app/yelp-food-services-reviews/id284910350`, after a 301 redirect, HTTP 200). That server-rendered HTML contained the "Developer's Privacy Policy" link and the data-type lists.
- **iTunes Search/Lookup API:** `https://itunes.apple.com/lookup?id=<trackId>` returns JSON (docs: https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/LookupExamples.html). **Verified (CSO note confirmed):** for Yelp (id 284910350) the response keys are `advisories, artistId, artistName, artistViewUrl, artworkUrl*, averageUserRating*, bundleId, contentAdvisoryRating, currency, description, features, fileSizeBytes, formattedPrice, genre*, kind, languageCodesISO2A, minimumOsVersion, price, releaseDate, releaseNotes, screenshotUrls, sellerName, sellerUrl, supportedDevices, track*, userRatingCount, version, wrapperType`. **There is no privacy-policy or privacy-label field.** `sellerUrl` and `trackViewUrl` are the only pointers (to the developer site / the listing). One app tested; re-check others.
- **API terms:** Apple's Search API overview limits use of promotional content (icons, previews) and attaches "Terms and conditions" (https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html). A rate limit is commonly cited (~20 calls/min) but I could not confirm it from Apple's page; **[unverified]**.
- **App Store Connect API:** for developers managing their own apps; not a source for other developers' apps. I could not retrieve its page text (the fetch returned only a title), so this is **[unverified]**, consistent with Apple's page saying developers enter privacy answers in App Store Connect.
- **robots.txt (apps.apple.com):** disallows `/api/*`, `/v1/*`, `/WebObjects/*`, `/includes/*`, `*/search?*`. So Apple's internal listing API (`/v1/...`) is off limits to bots; only the public HTML listing pages are not disallowed. Plus the Apple site-terms quote in section 2.
- **Open-source:** `facundoolano/app-store-scraper` (MIT, last push 2025-07-27) https://github.com/facundoolano/app-store-scraper . Same caveats: maintenance, terms, rate limits.

---

## 4. Open Terms Archive (OTA): how it stores T&Cs, and reuse

**How it works** (docs: https://docs.opentermsarchive.org/ and https://raw.githubusercontent.com/OpenTermsArchive/docs/main/content/deployment/reference/architecture.md)
- A **declaration** (JSON) per service lists each document: `fetch` URL, `select` (CSS selector/range), optional `remove`, `filter`, `executeClientScripts` (headless browser for JS pages) (https://raw.githubusercontent.com/OpenTermsArchive/docs/main/content/terms/reference/declaration.md). Document types come from a standard list (https://github.com/OpenTermsArchive/terms-types).
- A **snapshot** = original source document (HTML, PDF...). A **version** = cleaned text. Three git repos per collection: `*-declarations`, `*-snapshots`, `*-versions` (+ optional tracking-results). Storage backends: Git or MongoDB. Default cron: every 12 h. Principle: "Always keep an untouched snapshot of the source documents" and "Obtain documents like a user would" (design principles, link above).
- Engine internals (src read from GitHub): `Record` requires `serviceId, termsType, fetchDate, content`; Snapshot adds `mimeType`; Version adds `snapshotIds` and is Markdown. Git commits are the version history; commit titles "First record of..." / "Record new changes of..." (https://github.com/OpenTermsArchive/engine/tree/main/src/archivist/recorder).
- Datasets are published as GitHub releases and can go to data.gouv.fr (https://raw.githubusercontent.com/OpenTermsArchive/docs/main/content/collections/how-to/publish-to-datagouv.md).

**Licences, reported separately (CSO flag 4)**
| Component | Licence | Source |
|-----------|---------|--------|
| **Code**: engine (v17.0.0) | **EUPL-1.2** (must credit "Open Terms Archive Contributors" and share changes under similar terms) | https://github.com/OpenTermsArchive/engine (README, package.json) |
| Code: declarations repos | `contrib-declarations` EUPL-1.2; `demo-declarations` AGPL-3.0; `pga-declarations` AGPL-3.0 | GitHub API, https://github.com/OpenTermsArchive/contrib-declarations |
| **Data**: versions (e.g. `contrib-versions`) | **ODC-By 1.0**, attribute "Open Terms Archive contributors" | https://github.com/OpenTermsArchive/contrib-versions (README "License") |
| Data: other collections' versions/snapshots | GitHub shows NOASSERTION; read each repo's LICENSE file before use | https://github.com/OpenTermsArchive/demo-versions , https://github.com/OpenTermsArchive/pga-versions |
| Docs | CC-BY-SA-4.0 | https://github.com/OpenTermsArchive/docs |

- ODC-By licenses only the **database**, not its contents. Its text says the licence "only governs the rights over the Database, and not the contents of the Database individually" (https://raw.githubusercontent.com/OpenTermsArchive/contrib-versions/main/LICENSE). So the *copyright in each company's T&C text is not cleared* by OTA's data licence. This matters for redistribution (section 7).

**Could we reuse it?**
- *Ideas/schema:* yes, strongly (snapshot to version, hash, git history, document-type taxonomy).
- *Engine as-is:* **not recommended for our flags.** The headless fetcher uses `puppeteer-extra-plugin-stealth` (evasions to look like a normal browser) (https://github.com/OpenTermsArchive/engine/blob/main/src/archivist/fetcher/fullDomFetcher.js), and in the `src/archivist` code I grepped I found **no robots.txt handling**; the HTML fetcher sends only an `Accept-Language` header (htmlOnlyFetcher.js). That conflicts with "honest bot, respect robots.txt, never evade". It is also a server-side crawler on a 12 h schedule, not a user-triggered tool. EUPL-1.2 obligations apply if we embed or modify it.
- *Their published versions as a read-only lookup:* possible under ODC-By with attribution, as an **optional, owner-approved** bootstrap (e.g. "OTA has a recorded history of this document"). Do not depend on it (goodwill constraint), and keep our own dataset private.

---

## 5. Local, free summarization (user data stays on device)

| Option | Licence | Notes / source |
|--------|---------|----------------|
| Chrome built-in Summarizer API (Gemini Nano) | part of Chrome | Stable from Chrome 138, works in extensions; on-device; "No data is sent to Google or any third party"; needs ~22 GB free disk, >4 GB VRAM or 16 GB RAM + 4 cores, desktop only; model download once. Languages from Chrome 149: English, Spanish, Japanese, German, French. https://developer.chrome.com/docs/ai/summarizer-api , https://developer.chrome.com/docs/ai/get-started |
| llama.cpp | MIT | https://github.com/ggml-org/llama.cpp |
| Ollama | MIT | https://github.com/ollama/ollama |
| WebLLM (in-browser, WebGPU) | Apache-2.0 | https://github.com/mlc-ai/web-llm |
| transformers.js | Apache-2.0 | https://github.com/huggingface/transformers.js |
| Models: Phi-3.5-mini-instruct | MIT | https://huggingface.co/microsoft/Phi-3.5-mini-instruct |
| Qwen2.5-3B-Instruct | "qwen-research" custom licence (read before use) | https://huggingface.co/Qwen/Qwen2.5-3B-Instruct |
| Gemma 2 2B-it | Google Gemma terms; gated download needing login/acceptance (so not a clean "free OSS" fit) | https://huggingface.co/google/gemma-2-2b-it , https://ai.google.dev/gemma/terms |

Limits **[my analysis]**: small models have short context and can hallucinate, so chunk by clause, require verbatim quotes, and show "not found" instead of guessing. Own-server option is acceptable per CSO note, with no analytics.

---

## 6. Dataset design (private, versioned)

**Format recommendation:** one local **SQLite** file (zero-cost, single file, easy hashing, queryable); optional **JSONL** export for backup; Parquet only if analytics later. Keep it out of any public git repo. If git versioning is wanted, use a **private** local repo of Markdown versions (the OTA pattern) with access controls.

**Schema (SQLite)** **[my proposal]**
```sql
CREATE TABLE source   (source_id INTEGER PRIMARY KEY, kind TEXT CHECK(kind IN ('web','google_play','apple_app_store')),
                       app_or_site_id TEXT,      -- domain, Play package id, or Apple trackId
                       name TEXT, locale TEXT);
CREATE TABLE document (doc_id INTEGER PRIMARY KEY, source_id INT, doc_type TEXT,  -- tos|privacy|eula|cookies|other
                       url TEXT, final_url TEXT, discovered_via TEXT,           -- user_page|link_scan|user_pasted
                       robots_checked_at TEXT, robots_allowed INT, license_note TEXT);
CREATE TABLE version  (version_id INTEGER PRIMARY KEY, doc_id INT, fetched_at TEXT,  -- ISO-8601 UTC
                       http_status INT, mime_type TEXT, user_agent TEXT,
                       content_hash_raw TEXT, content_hash_clean TEXT,           -- SHA-256
                       raw_blob BLOB, clean_text TEXT, prev_version_id INT, diff_from_prev TEXT,
                       extractor TEXT,                                           -- e.g. readability@x.y
                       copyright_note TEXT, private_only INT DEFAULT 1);
CREATE TABLE analysis (analysis_id INTEGER PRIMARY KEY, version_id INT, created_at TEXT,
                       model TEXT, summary_md TEXT, risks_json TEXT,             -- [{risk,quote,loc}]
                       disclaimer_shown INT DEFAULT 1);
```
- Insert a new `version` only if `content_hash_clean` differs from the previous one (change detection).
- `private_only=1` blocks any export of `raw_blob`/`clean_text` until counsel approves (CSO flag 1). Exports contain only summaries and short quotes.
- Retention: delete on user request; store nothing the user didn't ask to analyse; no account data (strip non-document DOM before saving).

---

## 7. Copyright and redistribution risk of storing third-party legal text
- T&Cs and privacy policies are authored works of their owners; no general permission to republish them should be assumed. OTA's ODC-By covers only its database, not the underlying text (quote in section 4). Whether archiving/republishing is fair use or otherwise permitted depends on jurisdiction **[unverified; needs a lawyer]**. I am not providing a legal opinion.
- Private, per-user, on-device storage for the user's own analysis is the lowest-risk posture; sharing across users, public datasets, or training/redistribution is where risk rises.
- Play and Apple terms restrict scraping (quotes above), so bulk app-store collection is out of scope.
- Therefore: dataset private (flag 1); ship only summaries and short quotes until a lawyer signs off.

---

## 8. Open items for the owner
1. Approve the name ("terms explainer"/"terms guide") (owner's decision).
2. Approve (or not) each optional partner: ToS;DR lookup (privacy/goodwill trade-off), OTA read-only lookup, Chrome Summarizer vs. bundled model.
3. Lawyer review before any redistribution or any app-store collection.
4. Verify: `optional_host_permissions` flow; Play `/store/apps/details` robots status in the full file; Apple App Store Connect API/Search API limits; current ToS;DR API terms and licence.

## CSO review (approved from a security standpoint, 2026-10-28) — tightenings
1. Inject the content script only on the user's click (`chrome.scripting.executeScript` under activeTab). Never declare always-on `content_scripts` in the manifest.
2. Keep quotes short: just the sentence or clause that shows the risk.
3. Any model download (WebLLM or llama.cpp weights) counts as a partner: Jeff must approve it, after a license check.
4. Open question for Jeff: "private dataset" means either a local file on each user's device (safe) or a central dataset Jeff collects (data leaves the device, so it needs its own plan: opt-in only, terms text only, nothing about the user).

## Decision (2026-10-31)
Jeff decided the dataset stays local, a file on each user's device. There is no central dataset.
