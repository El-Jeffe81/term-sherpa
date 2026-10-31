# Live smoke fetches (3 polite fetches, one per host)

Run: 2026-10-28, about 00:12 America/New_York (EDT), with `tc-collect <url>` at the default 5000 ms
per-host delay, logged out, honest User-Agent, a throw-away database (`/tmp/live-smoke.sqlite`, not shipped).
robots.txt was fetched first for each host and had to allow the path (the tool refuses otherwise).
Every request was a single GET for the page named below. Nothing was crawled.

| # | URL | robots.txt result | Exit | Stored as | Chars | sha256 (clean text) |
|---|-----|-------------------|------|-----------|-------|---------------------|
| 1 | https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use | allowed (page was fetched) | 0 | tos v1 | 50878 | 85405b6e5b0993425f2279cdddfaeaae17d04e1945b537d06b4e8d36879c7a02 |
| 2 | https://www.mozilla.org/en-US/about/legal/terms/mozilla/ | allowed | 0 | tos v1 | 11094 | 0d60f6abb0b19adc01a03ba375cf0b3b7bf4e80dcef287087c99dd2c60f3a922 |
| 3 | https://www.python.org/about/legal/ | allowed | 0 | other v1 (page is a "Legal Statements" index, no strong terms title) | 2287 | 310742e22da7c3eaa65f28b7f028ccf1bcfca73bb9046ce8d458c2ff44138fda |

## What I observed (quality notes, not legal conclusions)
- #2 (Mozilla): clean. Starts at the document title and ends at the last section.
- #3 (python.org): clean, but it is a short list of legal statements rather than a terms-of-use document,
  which the detector correctly did not call "tos".
- #1 (Wikimedia): the clause text is complete, but the stored text **starts with the page's translation language
  list** (about 100 short list items) before the terms. That is page chrome the built-in extractor keeps because
  it sits inside the content container. Known limitation, listed in README. A better cleanup rule (drop a leading
  run of 1-3 word list items) is a candidate follow-up. No text was altered after fetching.
- The stored text of these pages is third-party content, kept only in the temp database, never in the zip,
  and is private until a lawyer approves any sharing (see OPEN_QUESTIONS.md).
- No refusals happened in the live run. Refusal paths (robots disallow, 401/403/429/451, captcha) are covered by the
  offline tests against local fixtures.

## Update 2026-10-31 (after the quality work)
The page-chrome rule suggested above is now implemented (language lists, nav, footer, cookie banners are stripped; sections are stored). It is verified on invented fixtures only. The three live pages were **not** re-fetched, so the Wikimedia result above is the old behaviour until re-run.
