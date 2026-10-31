# Publishing for free (nothing has been published)

This project is free and stays free, so this guide covers only the zero-cost routes. **Nothing here has been done**: no store account was
created, no listing submitted, no GitHub release made. These are the steps for whoever does it, after the open items at the bottom are decided.

Build the packages first (`cd prototype && npm run build`, see `BROWSER_TESTING.md`):
`dist/terms-guide-<version>-chrome.zip` and `dist/terms-guide-<version>-firefox.zip`.

## Route summary

| Route | Cost | For | Status |
|---|---|---|---|
| GitHub release zip + "Load unpacked" | Free | Chrome, Edge, Brave, Opera, Vivaldi users who accept developer mode | Documented below; no release created |
| Firefox Add-ons (AMO), listed | Free | Firefox desktop (and Android, untested) | Not submitted |
| Firefox self-distribution (AMO-signed, unlisted) | Free | Firefox users from a GitHub release | Not done |
| Microsoft Edge Add-ons | Free (no registration fee) | Edge | Not submitted |
| Chrome Web Store | **One-time US$5 developer fee** | Chrome | **Excluded: the project is free-only** |

## 1. Chrome-family users: install free from a GitHub release zip
No store is involved. The user does this once (and again to update):
1. Download `terms-guide-<version>-chrome.zip` from the repository's Releases page and unzip it to a folder they will keep (the browser loads it from there).
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`, Vivaldi: `vivaldi://extensions`, Opera: `opera://extensions`) and switch on **Developer mode**.
3. Click **Load unpacked** and choose the unzipped folder (the one containing `manifest.json`).
4. Pin the Terms Guide icon, open a page with an "I agree" dialog, click the icon.

Honest limits to say in the release notes: the browser shows a "developer mode extensions" notice, nothing updates automatically, and the
user must trust the zip (publish its SHA-256 next to it). Whoever makes the release: attach the two zips from `npm run build`; `gh release create`
is a deliberate step for the owner and was not run here.

## 2. Firefox Add-ons (AMO) - free
Account: a free Mozilla account at addons.mozilla.org; there is no developer fee. Review is automatic first, with human review possible afterwards.

Before the first submission:
- **The add-on ID is permanent once published.** `prototype/manifests/firefox.overlay.json` currently says `terms-guide@el-jeffe81.github.io`
  (an email-style ID on a domain tied to the owner's GitHub name). Confirm it, or change it, **before** the first upload; changing it later makes a different add-on.
- `data_collection_permissions` is already `{"required": ["none"]}` (the extension collects and transmits nothing); AMO requires this declaration for new add-ons. Keep it truthful.
- The name is still "Terms Guide (working name)" (OPEN_QUESTIONS #3). Pick the real name first.
- The manifest has no `icons`. AMO will use a default icon; a real icon is strongly recommended for a listing (and required by the other stores).
- Prepare a short description, a longer description, a privacy statement ("no data collected; runs on your device; optional saved copies stay in the browser"), and a licence. The licence is undecided (OPEN_QUESTIONS #4); AMO asks for one.

Steps (listed on AMO):
1. `npm run build:firefox` and `npm run lint:firefox` (expect 0 errors).
2. Sign in at addons.mozilla.org -> **Developer Hub** -> **Submit a New Add-on**.
3. Choose **On this site** (listed). Upload `terms-guide-<version>-firefox.zip`.
4. Source code: the package is the plain, unminified source with no build step, so there is no separate source to upload.
5. Fill in the listing and the notes for reviewers (explain the optional `https://*/*` permission: it is requested per site, only after the user clicks, to read the documents an "I agree" dialog links to; mention `activeTab` + `scripting`).
6. Submit. After approval Firefox installs it permanently and updates it automatically.

Android: the manifest already includes `gecko_android`, so AMO will list it for Firefox for Android. It has **not been run on Android**
(see `FIREFOX_ANDROID.md`). To avoid publishing an untested Android listing, either test it first or remove the `gecko_android` block from the
overlay before the first upload.

### Free alternative: self-distribution (unlisted)
Same Developer Hub, choose **On your own**. AMO signs the file (free) and you host the signed `.xpi` yourself, for example in a GitHub release.
An unsigned or temporary add-on only lasts until Firefox restarts (release Firefox will not install unsigned add-ons permanently), so signing is required for any real use.

## 3. Microsoft Edge Add-ons - free
Account: a free Partner Center account for the Microsoft Edge program, which needs a Microsoft account (Outlook/Live/Hotmail, or a GitHub sign-in that creates one) as the primary owner.
Work or school accounts are not supported for this. Microsoft states there is no registration fee.

Steps:
1. Register at Partner Center -> Microsoft Edge program (individual account is enough).
2. `npm run build:chrome`; the Chrome package is a normal MV3 package that Edge loads (tested in Edge 156, see `BROWSER_TESTING.md`).
3. In Partner Center -> **Create new extension**, upload `terms-guide-<version>-chrome.zip`.
4. Fill in the listing: name, description, privacy policy link (a hosted page is needed; GitHub Pages or the repository README works), a logo and a small promotional tile (current required sizes are on Microsoft's publish page), optional screenshots.
5. Put the permission explanation in "Notes for certification". Submit; Microsoft says certification can take up to seven business days.

## 4. Chrome Web Store - excluded
Publishing there costs a one-time US$5 developer registration fee. The project is free-only, so this route is intentionally not used.
Chrome users get the free GitHub-release route in section 1 instead. If the owner later decides a $5 fee is acceptable, the same Chrome zip is what would be uploaded.

## Gaps to close before any store submission (decisions for the owner)
1. Final name, add-on ID (permanent on AMO), licence (OPEN_QUESTIONS #3 and #4).
2. Icons (16/32/48/128 px) and listing images; none exist in the repo.
3. A public privacy statement and, for Edge, a hosted privacy policy URL.
4. One manual run per browser family in a visible window with a real toolbar click and the real permission prompt (`BROWSER_TESTING.md`, "NOT tested").
5. The lawyer review of rule wording noted in OPEN_QUESTIONS.
6. Decide whether to ship the Android listing before it has been tested on a device.
7. Store policies and fees change; re-check each store's current page at submission time (the facts above were checked on 2026-10-31).
