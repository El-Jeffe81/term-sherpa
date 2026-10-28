# Roadmap

## Phases

| Phase | Goal | Done when |
|-------|------|-----------|
| 0. Concept (this PR) | Docs, schema and a sample entry. | Concept PR merged. |
| 1a. Tooling | Validation in CI, a source-capture and hashing script, an entry template. | Bad entries fail CI. |
| 1b. First pages | A handful of AI-service entries, each reviewed by a person. | Entries validate and every claim has a `source_ref`. |
| 1c. Static site | Build pages from entries, with last-verified dates and the disclaimer. | Site builds and is hosted. |
| Legal review | Lawyer reviews wording and policy. | Before launch or any paid product. |
| 2. App-store apps | Same entry format for popular apps. | New categories added via schema PRs. |
| Later | Paid guide, browser extension, change alerts. | After legal review and validated demand. |

## Open questions

1. **Re-check cadence.** Weekly, monthly, or tiered by service popularity? How fast should a flagged change be reviewed, and what does the page say while a review is pending?
2. **Name.** TBD. Needs a trademark and domain check.
3. **Monetization.** Free with donations, a paid guide, a browser extension, or an alerts subscription. Which first? Needs a lawyer's review.
4. **Settings steps.** Public help pages only, or also a maintainer's test account? How to label step dates, since app menus change often.
5. **Hash normalization.** Finalize the text-extraction recipe so layout-only changes don't trigger false alarms.
6. **Hosting and generator.** Choice of static site generator and host.
7. **Who reviews entries.** Single maintainer, or a second reviewer for high-severity ratings?

## Suggested next PR

**Add CI schema validation plus an entry template.** A small GitHub Actions workflow that validates every file in `examples/` and the future `entries/` directory against `schema/service.schema.json`, and a blank entry template. Small, low risk, and every later PR benefits. Pair it with turning on branch protection on `main` so the check is required.
