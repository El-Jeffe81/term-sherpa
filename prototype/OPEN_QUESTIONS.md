# OPEN QUESTIONS (for Jeff)

1. **Dataset location (the "private dataset" question): DECIDED, local.** Jeff decided on 2026-10-31 that the dataset stays
   local, a file on each user's device (IndexedDB in the extension, SQLite for the CLI), with no central collection. Every record
   is `private_only = true`. A shared central dataset is out of scope; it would need a new explicit decision, an opt-in design,
   a legal review, hosting and a deletion-request plan.
2. **Lawyer review before any sharing.** Terms and privacy policies are authored works of their owners. The findings file says
   OTA's ODC-By covers only its database, not the underlying text, and that whether archiving or republishing is permitted depends
   on jurisdiction **[unverified; needs a lawyer]**. This prototype does not redistribute anything: the zip contains only invented
   fixture text, and export of real text is opt-in (`--include-text`).
3. **Naming.** Decided by Jeff on 2026-10-31: **Term Sherpa** (repo `El-Jeffe81/term-sherpa`). Still open: trademark and domain availability were not checked.
4. **Licence for our own code.** Decided: GPL-3.0-only (`LICENSE`, `package.json`, README), copyright 2026 El-Jeffe81.
5. **Partners.** Approve or reject each item in PARTNERS.md, especially Readability (better extraction) and anything that
   downloads a model in the next phase.
6. **robots.txt policy.** The CLI refuses when robots.txt is disallow, 5xx, 401 or 403, and treats 404 as allowed. Is that the
   policy you want? The extension reads only the page the user is already viewing, so robots.txt does not apply to it
   (that is a design judgement, not a legal conclusion).
7. **Fetching a different origin from the extension.** Not built. Chrome's `optional_host_permissions` might allow a click-time
   request **[unverified, per the findings file]**. The current design avoids it: the user opens the link and clicks again.
8. **Retention and deletion.** Local data stays until the user deletes it (popup buttons, or delete the SQLite file). Do you want an
   expiry (for example, drop snapshots after N months)?
9. **Raw HTML in the CLI dataset.** Kept for audit (the findings recommend it); `--no-raw` drops it. Keep as default?
10. **Scope of phase 2.** Now built: link detection in es/fr/de/pt/it, PDF detection (marked "needs pdftotext"), sections, legal hubs,
    page-chrome and language-list stripping, a quality report. Still open: actually reading PDFs (needs the pdftotext partner approved in PARTNERS.md),
    more languages, regional variants, and app-store listings (the findings flag Play and App Store listings as risky for scraping).
    Also: should documents flagged `injection_hints` be shown with a warning in the popup?
11. **Cloud-hosted fetching.** Not built, because it would need a server, logs and a retention policy. Needs your decision on whether it is in scope at all.

## Decided
- 2026-10-31: Jeff decided the dataset stays local, a file on each user's device with no central collection.
- 2026-10-31: Jeff approved the security plan: save only the terms document (never the page the user is on), CLI refuses non-public targets at every hop, terms text is untrusted data with exact-quote verification. Implemented; see docs/SECURITY.md.

## Explain phase: open decisions (added on branch wip/terms-explain)
- **"Track what I've agreed to"**: parked, not built. It would store personal data (what, when, which version). Do you want it, and where would it live?
- **Chrome built-in on-device AI (Prompt API)**: parked, not used. Do you approve trying it later as an optional extra?
- **Legacy collection popup**: kept as an opt-in "Save copies" path and an advanced view. Keep, or retire it?
- **Name**: decided, "Term Sherpa".
- **Context matrix**: which kinds of service move which findings up or down (see `CONTEXT_MATRIX` in `extension/core/rules.js`) is a set of judgement calls. Is a news site's limited liability really Low? Review the values, and the kinds of service (news, shopping, social, finance, app) for gaps. Optionally add a "Why it matters" toggle with the longer explanation (it is in the rules, currently not shown).
- **Rule wording and severity**: needs your review, and a lawyer's review of the plain-English explanations before wide release.
- **Optional host permission `https://*/*` (v0.3.0)**: needed so the Explain window can read the documents an agree dialog links to (they are usually on another host). Nothing is granted at install; Chrome asks once per site after the user's click, and it can be removed in Options. OK to ship this way? Alternative: no fetching (list the links only), or a fixed allow-list of legal-document hosts.
- **robots.txt (v0.3.1, built)**: the Explain window reads `https://<site>/robots.txt` before a linked document (one extra guarded request per site per analysis, in memory only, user-agent `*`). A disallow skips the document and shows its link. Missing, unreadable, slow or redirecting robots.txt means allowed (fail-open) - is that the policy you want? The CLI is stricter (it refuses on 5xx/401/403). Note a site that redirects robots.txt (for example to `www.`) is treated as unreadable, i.e. allowed, because redirects are never followed.
- **Redirects (v0.3.1, decision for Jeff)**: any redirect (including harmless ones like `/terms` to `/terms/`) makes a document "not read", with its link. The alternative, a `declarativeNetRequest` fence that lets same-site redirects through and blocks the rest before they go out, works (see `npm run probe:dnr`) but needs the install warning "Block content on any page". Which do you prefer? If the warning is acceptable the fence can be built as a follow-up; nothing else in the design needs to change.
- **DNS rebinding / SSRF**: the address guard works on the URL text and cannot see DNS answers. The per-site Chrome prompt is the barrier. Acceptable?
- **Severity floor**: arbitration, class-action/jury waiver, data sale/sharing and broad content licence never go below Medium. Is that the right list? (A rule that is Low by itself, such as ordinary service-provider sharing, stays Low.)
- **Regional dedupe**: heuristic, prefers the browser language then US English; it can merge distinct regional policies (e.g. /privacy/ca vs /privacy/us). Should the user be able to pick the region?
- **JavaScript-only documents** are reported as not read. Is a headless-render partner for those worth approving later?
- **Real-site check**: the CNN dialog and Chrome's real permission prompt were not tested (headless limits); needs a manual run in headed Chrome.

## Other browsers (added on branch feat/other-browsers)
- **Add-on ID (permanent on AMO once published)**: decided by Jeff on 2026-10-31: `term-sherpa@el-jeffe81.github.io`.
- **Firefox minimum version 140** (desktop) / **142** (Android): needed for the `data_collection_permissions` declaration AMO requires for new add-ons. Is dropping older Firefox releases acceptable?
- **Android listing**: the manifest marks Firefox for Android (142+) as supported; it has not been run on a real phone. Ship the Android listing before a device test, or untick Android on the first AMO submission? (See `docs/FIREFOX_ANDROID.md`.)
- **Publishing routes (free only)**: GitHub-release zip for Chrome-family users, AMO and Edge Add-ons. The Chrome Web Store is excluded (US$5 fee). Confirm, and say who creates the accounts and the release (nothing was created). See `docs/PUBLISHING.md`.
- **Icons**: done (concept A, approved; 16-128 px, in the manifest).
- **Manual check per browser family**: a visible-window run with a real toolbar click and the real permission prompt has not been done in any browser.


## v1.0.0 production build (added on branch release/v1.0.0)
Decided by Jeff: name Term Sherpa, version 1.0.0, GPL-3.0-only, the disclaimer text (first-run screen, bottom line of the explain window, store listing, privacy page), icon concept A, free-only publishing (Edge Add-ons and Firefox Add-ons desktop and Android; Chrome Web Store excluded), the privacy site in `site/` with `.github/workflows/pages.yml`.
Still open for the owner (each is a separate go-ahead; none was done):
- Make the repository public, enable GitHub Pages (Settings -> Pages -> GitHub Actions), create the GitHub release and tag `v1.0.0`, create the store accounts and submit. Steps: `docs/PUBLISHING.md`.
- **Firefox-only DNS check** (permission `dns`): Chrome and Edge keep the static check only. Acceptable? Known limit: DNS rebinding between the check and the request is not covered.
- **Cross-site iframes**: with `activeTab` alone, Firefox reads same-site frames only and says so for other sites; real Chrome behavior is unverified. Acceptable, or should the first click ask for the framed site up front?
- **Article-vs-terms heuristic**: a page is not read as terms when its address looks like an encyclopedia/news/blog/dated-article path or its title is a long headline. A legitimate terms page under such an address would show as "linked documents" instead. Acceptable?
- **Cookie banners**: a banner with no recognisable markup, no fixed position and no agree-style button is still missed; the real-site check is a snapshot (see `docs/BROWSER_TESTING.md`).
- Firefox for Android on a real phone, the real toolbar click and permission prompt in Chrome/Edge, and store review are untested.

### Opera and cross-site frames (found in the v1.0.0 final pass)
In Opera 139 the e2e check "iframe from another site not allowed" fails: the window does not add the note that part of the page is in a frame it could not read. Chrome, Edge, Brave, Vivaldi and Firefox pass it. Nothing is unsafe (the frame is simply not read), but the message is missing. Opera is not a store target for v1.0.0. Not investigated.
