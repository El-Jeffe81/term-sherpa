# Publishing Term Sherpa for free (nothing has been published)

Term Sherpa is free and stays free, so this guide covers only the zero-cost routes: **Edge Add-ons** and **Firefox Add-ons (desktop and Android)**,
plus a GitHub release as the backup download. **Nothing here has been done**: no store account was created, no listing submitted, no GitHub
release or tag made, the repository is private, and GitHub Pages is not enabled. These are the steps for the owner, each needing a separate go-ahead.

Build the packages first (`cd prototype && npm run build`, see `BROWSER_TESTING.md`):
`dist/term-sherpa-1.0.0-chrome.zip` (for Edge and other Chromium browsers) and `dist/term-sherpa-1.0.0-firefox.zip`.

## Route summary

| Route | Cost | For | Status |
|---|---|---|---|
| Firefox Add-ons (AMO), listed | Free | Firefox desktop and Firefox for Android | Not submitted |
| Microsoft Edge Add-ons | Free (no registration fee) | Edge | Not submitted |
| GitHub release zips + "Load unpacked" (backup) | Free | Chrome, Brave, Opera, Vivaldi, Edge users who accept developer mode | Documented below; no release created |
| Chrome Web Store | **One-time US$5 developer fee** | Chrome | **Excluded: the project is free-only** |

## Order of work (each step needs the owner's go-ahead)
1. Merge the release PR into the branch the owner chooses; then main when ready.
2. Make the repository public (needed so GitHub Pages is free and so the source link on the listings works).
3. Enable GitHub Pages: Settings -> Pages -> Source: **GitHub Actions**. `.github/workflows/pages.yml` then deploys `site/` on every push to `main` (or by hand from the Actions tab).
   The pages go live at `https://el-jeffe81.github.io/term-sherpa/` and `https://el-jeffe81.github.io/term-sherpa/privacy/`. Open both and read them before using the privacy URL anywhere.
4. Create the GitHub release (below).
5. Submit to Firefox Add-ons, then Edge Add-ons.

## Backup: create a GitHub release
Do this after the release PR is merged, from the merged commit.
1. `cd prototype && npm test && npm run validate && npm run build && npm run lint:firefox` (expect everything green and lint 0/0/0).
2. Note each zip's SHA-256: `sha256sum dist/term-sherpa-1.0.0-*.zip`. The build is reproducible, so the same commit gives the same zips.
3. On GitHub: Releases -> **Draft a new release** -> choose a new tag `v1.0.0` on the merged commit (or `gh release create v1.0.0 dist/term-sherpa-1.0.0-chrome.zip dist/term-sherpa-1.0.0-firefox.zip --title "Term Sherpa 1.0.0" --notes-file NOTES.md`).
4. Attach both zips. In the notes: what it is, the two zips and their SHA-256, the install steps for testers (below), the disclaimer, "free software, GPL-3.0-only", and the known limits (see "Honest limits").
5. Chrome-family testers install it once like this: unzip `term-sherpa-1.0.0-chrome.zip` to a folder they will keep; open `chrome://extensions` (Edge `edge://extensions`, Brave `brave://extensions`, Vivaldi `vivaldi://extensions`, Opera `opera://extensions`); turn on **Developer mode**; **Load unpacked**; choose the folder that holds `manifest.json`; pin the icon.
   The browser shows a developer-mode notice and nothing updates automatically.
6. Firefox release zips are unsigned, so release Firefox will not keep them installed. Firefox users should install from the Firefox Add-ons listing (or an AMO-signed unlisted file, see below).

## Firefox Add-ons (AMO), desktop and Android
Account: a free Mozilla account at addons.mozilla.org. No developer fee.

Already set in the package: add-on ID `term-sherpa@el-jeffe81.github.io` (permanent once published), `data_collection_permissions` = `{"required": ["none"]}`,
icons, minimum Firefox 140 (desktop) and 142 (Android). `npm run lint:firefox` must report 0 errors, 0 warnings, 0 notices.

Steps:
1. Sign in at addons.mozilla.org -> **Developer Hub** -> **Submit a New Add-on**.
2. Choose **On this site** (listed). Upload `term-sherpa-1.0.0-firefox.zip`.
3. **Compatibility:** keep both **Firefox for desktop** and **Firefox for Android** ticked (the manifest already allows Android). The Android build is untested on a real phone: see `FIREFOX_ANDROID.md`. Untick Android if you want to wait until it has been tested on a device.
4. **Source code:** the package is plain, unminified source with no build step and no bundler, so there is nothing separate to upload. If the form asks, answer that no code is generated, minified or concatenated. (If it asks anyway, upload the repository's `prototype/extension/` folder zipped; `scripts/build.js` only copies files and merges `manifests/firefox.overlay.json` into the manifest.)
5. Fill in the listing from "Listing text" below, set the licence to **GNU General Public License v3.0 only**, and set the privacy policy URL.
6. Notes for reviewers: paste the "Permission justifications" below, and mention that the `dns` permission is Firefox-only (see "Firefox-only DNS check" in `BROWSER_TESTING.md`).
7. Submit. After approval Firefox installs it and updates it automatically.

Free alternative: **On your own** (unlisted). AMO signs the file for free and you host the signed `.xpi` yourself (for example in a GitHub release).

## Microsoft Edge Add-ons
Account: a free Partner Center account in the Microsoft Edge program (Microsoft account as owner; work or school accounts are not supported). There is no registration fee.
1. Register at Partner Center -> Microsoft Edge program.
2. **Create new extension** and upload `term-sherpa-1.0.0-chrome.zip` (a normal MV3 package; tested in Edge 156, see `BROWSER_TESTING.md`).
3. Fill in the listing from "Listing text" below, set the privacy policy URL, upload the 128 px icon as the logo, and add screenshots (a couple are produced by the tests; see the PR).
4. Put the permission justifications in the notes for certification. Submit; Microsoft says certification can take up to seven business days.

## Chrome Web Store: excluded
It costs a one-time US$5 registration fee, and this project is free-only, so it is not used. Chrome users can use the GitHub release zip. If the owner later decides the fee is fine, the same Chrome zip is what would be uploaded.

## Listing text
Use the same text on both stores. Re-check each store's current limits when submitting (they change; the limits were not looked up for this draft).

**Name:** Term Sherpa

**Subtitle:** Term Sherpa – plain-English guide to terms & privacy

**Short description (under 130 characters):**
Explains the terms, privacy policy or "I agree" box you are on, in plain English. On your device. Free.

**Long description:**
> Term Sherpa explains the "I agree" box, cookie banner, terms of service or privacy policy in front of you, in plain English, before you click.
>
> How it works
> - Click the Term Sherpa button on a page with an "I agree" box, or on a terms or privacy page.
> - It finds the documents the box links to, reads them, and lists what matters, such as arbitration, selling or sharing your data, or a broad licence over what you post.
> - Each point is one plain sentence, with the exact words from the document so you can check it.
> - What counts as a bigger risk depends on the kind of service (a bank is different from a news site).
> - If it finds nothing, it says that does not mean there is no risk.
>
> Private by design
> - Everything is worked out on your device with fixed rules. No AI service, no account, no analytics, no tracking.
> - Nothing is saved unless you turn that on. Files are exported only if you choose to.
> - It asks for access to a site only when you click, one site at a time.
>
> Free and open source (GPL-3.0-only): https://github.com/El-Jeffe81/term-sherpa
>
> Term Sherpa is a plain-English guide, not a lawyer. It isn't legal advice and can miss or misread things. Read the full terms, and ask a lawyer about anything important.

**Category suggestion:** Firefox: *Privacy & Security*. Edge: *Productivity* (or the closest "privacy/security" category the form offers).

**Privacy policy URL:** https://el-jeffe81.github.io/term-sherpa/privacy/ (live only after the Pages steps above)

**Support / homepage:** https://github.com/El-Jeffe81/term-sherpa/issues and https://el-jeffe81.github.io/term-sherpa/

**Required disclaimer (must appear in the listing, exact text):**
Term Sherpa is a plain-English guide, not a lawyer. It isn't legal advice and can miss or misread things. Read the full terms, and ask a lawyer about anything important.

## Permission justifications
- `activeTab`: reads the page the user is on, only after they click the Term Sherpa button.
- `scripting`: runs the page reader on that tab after the click. There are no always-on content scripts.
- `storage`: keeps the "first-run screen seen" flag and the user's options on the device. Saved copies are opt-in and stay on the device.
- Optional host permission `https://*/*`: requested at click time, per site or (after an explicit in-extension opt-in screen) for all sites, so Term Sherpa can fetch the documents an "I agree" box links to (often on another host, such as a separate privacy site). Not granted at install and used only for reads the user starts. Requests are https only, send no cookies, Referer or scripts, refuse private and local addresses (checked on the final URL after any redirect, before the body is read), read at most 8 MB per page, and do not check `robots.txt`. The user can turn the access off and on in Options.
- `dns` (Firefox only): resolves the link's host name to refuse names that point at private or local addresses before fetching (guards against a public name pointing inside the user's network). The result is not stored or sent anywhere.
- Data collection: none (`data_collection_permissions` = none). Nothing is sent to the author or to any third party.

Install warnings measured so far: Chrome shows none for the required permissions (probe result `[]`, `npm run probe:warnings`); Firefox 159 shows no message for `dns` or `storage`.
How Firefox for Android words the permissions is **unverified**.

## Honest limits to put in the release notes
- Firefox for Android has not been run on a real phone (checked in a Chrome 360 px layout test and by code review only).
- A same-site iframe is read; a cross-site iframe is read only if the user allows that site ("Allow that site and look again"). Real Chrome behavior for cross-origin frames under `activeTab` is unverified.
- Pages that build their text with JavaScript after loading may be reported as "not read".
- It uses fixed rules, not AI, so it can miss unusual wording or misjudge a clause. Real-site checks are in the release PR.
- Store review has not happened.
