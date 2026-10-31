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
- Clicking the extension icon opens a small launcher, which opens a window (`explain/explain.html`) for the current tab. The page is read with `activeTab` + `scripting` only, on that click. No new permissions, no host permissions, no `content_scripts`, no background worker.
- The window is short on purpose (revised after testing on a real news site's Terms of Use): (1) a 3-line overview: which site and kind of document, the detected type of service, and one headline takeaway; (2) "Worth knowing": the High and Medium points; (3) "Also agreeing to": the Low points. Each point is **one plain sentence** (for example "You can't sue them in a class action lawsuit."), with a badge and, when the type of service changed its weight, a one-line note. The exact quote(s) from the page are behind a collapsed "Show exact wording" toggle. No word count, read time, topic counts or copied passages.
- A clear "Informational, not legal advice" notice is at the top of the window and in the analysis result.
- If the current page is not a terms page, the window lists the terms links it found (as before) and analyses nothing until the user picks one.

How it works
- The analysis is **on-device rules, not AI**. `extension/core/rules.js` holds 12 rules (forced arbitration, class-action waiver, jury trial waiver, data sold/shared, auto-renewal/recurring billing, unilateral changes, license to user content, liability limits and disclaimers, termination at will, governing law and venue, age requirements, tracking and cookies). Each rule has regex patterns, exclusions (to avoid "we do not sell your data" false alarms), severity escalators and mitigators (for example an arbitration opt-out lowers High to Medium), and a plain-English explanation.
- Each rule (and, where the wording matters, each pattern) carries a fixed one-sentence `line` written by us; page text is never pasted into it. Rules that make the same point are merged: arbitration, the class-action waiver and the jury waiver become one line built from the parts found ("Disputes go to private arbitration: no court, no jury, and no class action lawsuits."), with all their exact quotes kept behind the toggle. One item per point, no repetition between overview and list.
- **Context.** `extension/core/context.js` guesses the kind of service on-device from the site name and wording: news / media, shopping, social / user content, finance, app / software / subscription, or not clear. A weak or tied result is "not clear" and changes nothing. A matrix in `rules.js` then moves a finding up or down one step for that kind of service (for example limited liability is Low on a news site but High on a bank or shop; auto-renewal weighs more on subscriptions; a content licence weighs more on social platforms), and a note says so. Deterministic, no AI. The matrix values are judgement calls and need review.
- `extension/core/analyze.js` splits the text into sentences, applies the rules, merges, applies context, ranks the findings (severity, then rule priority) and builds the 3-line overview. Every quote is checked with the existing exact-quote verifier (`quote.js`) and dropped if it is not in the page text word for word. Very long sentences are cut to exact contiguous pieces and labelled "Shortened".
- No network calls, no paid services, no third-party dependencies (still zero npm deps).
- Page text is untrusted: it is sanitised, rendered with `textContent` only (never `innerHTML`), and injection-style phrases are only reported, never acted on.

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

Parked (needs Jeff's decision, nothing built)
- **"Track what I've agreed to"**: a record of the terms a user accepted, with dates and versions. Not built; it would store personal data and needs a design and privacy decision first.
- **Chrome's built-in on-device AI (Prompt API)**: not used and not wired in. Needs Jeff's approval first.
