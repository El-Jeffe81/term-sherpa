This repo is a tool to read and understand terms and conditions, as well as potential risks for human interaction with technology.

The idea is to find the gotchas, the loopholes, the unforeseen consequences of interacting with websites, applications, apps, etc.

## Term Sherpa

**Term Sherpa** is a free browser extension that explains the terms, privacy policy or "I agree" box you are looking at, in plain English, before you click.
It works on your device with fixed rules: no AI service, no account, no analytics, no tracking.

> Term Sherpa is a plain-English guide, not a lawyer. It isn't legal advice and can miss or misread things. Read the full terms, and ask a lawyer about anything important.

### How to use it
1. Open a page with an "I agree" box, a cookie banner, or a terms or privacy page.
2. Click the Term Sherpa button in the toolbar. (In Chrome-family browsers, pin it from the puzzle-piece menu first. On Firefox for Android, see the Android notes below.)
3. The first time, a short welcome screen explains what it does and does not do.
4. If the box links to documents on other sites, your browser asks once per site whether Term Sherpa may read them. Say yes to include them, or no to just see the links.
5. Read the short list of what matters, each point with the exact words from the document. If nothing is found, it says that does not mean there is no risk.

### Privacy
Everything is worked out on your device. Nothing is collected or sent to the author. Nothing is saved unless you turn that on. Fetching a linked document only happens after your click, for sites you allow, over https, and respects each site's `robots.txt`.
Full policy: [site/privacy/index.html](site/privacy/index.html) (published at https://el-jeffe81.github.io/term-sherpa/privacy/ once GitHub Pages is switched on).

### Install for testers (not in a store yet)
It is not published anywhere yet; it is planned for Firefox Add-ons (desktop and Android) and Edge Add-ons, free. Until then:
- **Chrome, Edge, Brave, Opera, Vivaldi:** build it (`cd prototype && npm run build`) or take the `term-sherpa-1.0.0-chrome.zip` you were sent, unzip it to a folder you will keep, open the browser's extensions page (`chrome://extensions`, `edge://extensions`, ...), turn on **Developer mode**, choose **Load unpacked**, and pick the folder that holds `manifest.json`.
- **Firefox desktop:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and pick `manifest.json` from `prototype/dist/firefox/` (it is removed when Firefox restarts).
- **Firefox for Android:** see [docs/FIREFOX_ANDROID.md](docs/FIREFOX_ANDROID.md) (untested on a real phone).

### For developers
`prototype/` holds the source: one source, a Chrome-family package and a Firefox package (`cd prototype && npm run build`).
- Browser testing and results: [docs/BROWSER_TESTING.md](docs/BROWSER_TESTING.md)
- Firefox for Android: [docs/FIREFOX_ANDROID.md](docs/FIREFOX_ANDROID.md)
- Publishing steps, listing text and permission justifications (nothing published yet): [docs/PUBLISHING.md](docs/PUBLISHING.md)
- Open questions: [prototype/OPEN_QUESTIONS.md](prototype/OPEN_QUESTIONS.md)
- Product page and privacy policy: `site/` (deployed by `.github/workflows/pages.yml` once the owner enables GitHub Pages)

Issues and questions: https://github.com/El-Jeffe81/term-sherpa/issues

## License
Term Sherpa is free software under the GNU General Public License, version 3 only (GPL-3.0-only). See [LICENSE](LICENSE).

Copyright (C) 2026 El-Jeffe81
