# OPEN QUESTIONS (for Jeff)

1. **Dataset location (the "private dataset" question): DECIDED, local.** Jeff decided on 2026-10-31 that the dataset stays
   local, a file on each user's device (IndexedDB in the extension, SQLite for the CLI), with no central collection. Every record
   is `private_only = true`. A shared central dataset is out of scope; it would need a new explicit decision, an opt-in design,
   a legal review, hosting and a deletion-request plan.
2. **Lawyer review before any sharing.** Terms and privacy policies are authored works of their owners. The findings file says
   OTA's ODC-By covers only its database, not the underlying text, and that whether archiving or republishing is permitted depends
   on jurisdiction **[unverified; needs a lawyer]**. This prototype does not redistribute anything: the zip contains only invented
   fixture text, and export of real text is opt-in (`--include-text`).
3. **Naming.** The name is undecided ("Terms Guide (working name)"). Choose one before any store listing or public docs;
   check trademark and domain availability (not done here).
4. **Licence for our own code.** `package.json` says UNLICENSED for now. Pick one before sharing.
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
