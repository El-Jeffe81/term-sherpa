# Legal and Safety

> This document records working policy for the project. It is not itself legal advice, and it has not been reviewed by a lawyer yet.

## Disclaimer text

Show this on every page and in every paid product:

> **Information only, not legal advice.** This page is a plain-English summary of a service's public terms and privacy information, written to help you understand your options. It may be out of date, incomplete or wrong. Terms change, and the official documents are what actually apply to you. Check the "last verified" date, read the official terms linked below, and talk to a qualified lawyer if you need advice about your situation. We are not affiliated with the service described.

## Excerpt and copyright policy

- **Summarize in our own words.** The entry's text is original writing.
- **Quote only short excerpts**, to support a specific point: at most 200 characters each (enforced by the schema), with a link to the source.
- **Never republish full terms**, policy pages, or large sections. Terms and policies are copyrighted.
- Captured page text used for hashing and review is kept **privately** for internal checking and is not published.
- Don't use logos or brand assets without checking the brand's rules. Plain use of a service's name to identify it is the intent.
- If a rights holder asks for something to be changed or removed, do it promptly.

## Public pages only

- **v1 reads only public terms, policy and help pages** that anyone can open without logging in.
- **Never access users' accounts or data.** No logins, no scraping behind sign-in, no asking users to share their chats or settings screens.
- Settings steps are taken from public help pages or by the maintainer's own test account, and are labeled with a date. Respect each site's `robots.txt` and terms for automated fetching, and fetch gently.
- The site collects no user accounts. Keep analytics minimal and privacy-respecting.

## Accuracy and conflicts

- Each claim links to its source, capture date and content hash, so it can be checked (see [data-model.md](data-model.md)).
- Describe what the text says, not what the company intends. Where the text is unclear, say so (`not_stated`) rather than guess.
- Don't make accusations. Ratings are editorial and explained by the rubric in [risk-taxonomy.md](risk-taxonomy.md).

## Get a lawyer's review

Before **publishing** the site or **selling** anything (a paid guide, a browser extension, or change alerts), have a qualified lawyer review: the disclaimer, the excerpt policy, how ratings are worded, the site's own terms and privacy notice, and any claims made in marketing. Paid products raise the bar on accuracy, so this matters more once money is involved.

## Branch protection (recommended for Jeff)

Turn on branch protection for `main` in the repo settings (Settings > Branches, or Rules > Rulesets):

- Require a pull request before merging.
- Require status checks to pass (once the schema-validation check exists).
- Block force pushes and deletion of `main`.
- Optionally, require review before merge.

This keeps unreviewed changes out of the published content. Only the repo owner can change these settings.
