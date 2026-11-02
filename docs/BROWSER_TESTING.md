# Browser testing: what was run, how, and what was not

Everything here is free software on a Linux box with no display (headless). Nothing is published and no store account is involved.
The e2e test sites are invented (`*.test` names served from 127.0.0.1). The separate `npm run test:real` check does contact real public sites (read-only, nothing is clicked or submitted); see "Real-site check" below.

## One source, two packages

`prototype/extension/` is the only source. `npm run build` (in `prototype/`) writes:

| Output | What it is |
|---|---|
| `dist/chrome/` and `dist/term-sherpa-<version>-chrome.zip` | The shared source, with `manifest.json` copied byte for byte. For Chrome, Edge, Brave, Opera, Vivaldi. |
| `dist/firefox/` and `dist/term-sherpa-<version>-firefox.zip` | The same files; the manifest is the shared manifest plus `prototype/manifests/firefox.overlay.json` (`browser_specific_settings`: add-on ID `term-sherpa@el-jeffe81.github.io`, minimum versions, `data_collection_permissions` = none). |

The build never deletes anything; it stops if `dist/<target>` already holds stale files (remove the folder yourself first).
`npm run validate` builds both packages and checks that every file other than the manifest is identical, and that the Firefox manifest equals
the shared manifest plus `browser_specific_settings` and nothing else.

Why no `chrome.*` / `browser.*` shim: Firefox MV3 gives promises from `chrome.*` too, and the extension has no background page (no service
worker), so there was nothing to convert. `background.scripts` is only needed if a background is added later; `build.js` already converts a
future `background.service_worker` into `background.scripts` for the Firefox package.

## Commands

```
cd prototype
npm test                                   # unit suite (node:test), 236 tests
npm run validate                           # source manifest + both built packages
npm run build                              # dist/chrome, dist/firefox + zips
npm run lint:firefox                       # npx web-ext@10.8.0 lint -s dist/firefox (downloads web-ext on first use)
CHROME_BIN=/path/to/browser npm run test:e2e              # Chromium-family e2e (45 checks)
FIREFOX_BIN=/path/to/firefox GECKODRIVER_BIN=/path/to/geckodriver npm run test:e2e:firefox   # Firefox e2e (17 checks)
npm run probe:warnings                     # which install warnings does the browser show for the manifest permissions
CHROME_BIN=/path/to/browser npm run test:real             # real public sites (25 pages, about 4 minutes); results in $TC_REAL_OUT (default /workspace/real-sites)
```
Both e2e scripts skip themselves (exit 0, "SKIP") if the browser is not found. They need `openssl` for the local https fixture server.

### Chromium-family e2e (`tests/e2e/chrome-smoke.mjs`)
Drives the browser over the DevTools protocol on a pipe (`--remote-debugging-pipe`), loads the **unpacked source folder** with
`Extensions.loadUnpacked`, opens a fixture news page with an "Agree" dialog, and checks 45 things (first-run screen, disclaimer line, icons, "nothing found" wording, consent boxes inside iframes, a 360 px phone layout, and the list below): the injected page scripts, the
permission step, the guarded fetch (https only, no cookies, no Referer, no robots.txt request, redirects followed with the final URL vetted in all-sites mode and refused with a "Read it" button in per-site mode, 8 MB read cap, loopback refused), the
combined explanation, the hostile document (script / `onerror` / injected instructions stay inert), opt-in storage, removal of granted access.
`docs.newsco.test` is mapped to the local https server inside the throw-away profile only (`--host-resolver-rules`, `--ignore-certificate-errors`).

Environment switches: `CHROME_BIN` (browser binary), `TC_HEADFUL=1`, `TC_TRACE=1`, `TC_OPEN_VIA_OPENER=1` (Vivaldi, see below).

Per-browser notes from the runs:
- **Edge, Brave**: no changes needed.
- **Vivaldi**: tabs created with `Target.createTarget` never finish loading. The test opens its tabs with `window.open` from the first tab instead
  (automatic when the binary name contains "vivaldi").
- **Opera**: needs `GSETTINGS_SCHEMA_DIR` pointing at a directory with the GTK/GLib schemas, otherwise GLib aborts at start-up on a bare box.

### Firefox e2e (`tests/e2e/firefox-smoke.mjs`)
Uses geckodriver (WebDriver over HTTP, Node built-ins only). It builds `dist/firefox`, installs it as a temporary add-on in a throw-away
profile, and runs the same story as the Chrome test. Setup it needs, all confined to that profile:
- `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`: WebDriver cannot open `moz-extension://` pages, so the test opens them through the browser's own chrome context.
- Fixed extension UUID pref (`extensions.webextensions.uuids`) so the page URLs are known.
- `network.dns.localDomains` + `network.socket.forcePort` map `docs.newsco.test` and port 443 to the local https server.
- A throw-away test CA is imported into the profile's certificate store (Firefox rejects a bare self-signed server cert even when imported).
- `extensions.webextOptionalPermissionPrompts=false` auto-answers "Allow" to the optional-permission prompt.
- The toolbar action is triggered the way the button does it: open the unified-extensions panel, then dispatch the button's `command` event
  (a plain `.click()` does nothing in headless Firefox).

## Results

| Browser | Version | How | Result |
|---|---|---|---|
| Google Chrome | 156.0.8078.47 | e2e, unpacked source | 45/45 |
| Microsoft Edge | 156.0.4314.58 | same e2e, `CHROME_BIN` | 45/45 |
| Brave | 1.98.63 (Chromium 156.0.8078.80) | same e2e | 45/45 |
| Vivaldi | 8.2.4133.96 | same e2e, opener-based tabs | 45/45 (Vivaldi hides tab addresses from extensions, so the launcher cannot tell whether the window is already open: it shows only the "Open the explanation window" button, no sentence, and the test asserts that state; one earlier run failed at start-up in the launcher step: browser start-up timing) |
| Opera | 139.0.6053.22 (Chromium 155) | same e2e, `GSETTINGS_SCHEMA_DIR` | **Known issue, not re-run on the final build:** 39 checks passed, then it stopped (two earlier runs, same place). Earlier build: 35/35. The check that fails is "iframe from another site NOT allowed": in Opera the window does not say that part of the page is in a frame it could not read. Everything else before it passes, including the cross-site frame once site access is allowed. The later checks (JS-only page message, revoke) did not run. Not investigated further. |
| Firefox desktop | 159.0 (geckodriver 0.37.1) | Firefox e2e, `dist/firefox` | 17/17 |

Plus: `npm test` 236/236, `npm run validate` OK, `web-ext lint -s dist/firefox` 0 errors / 0 warnings / 0 notices (web-ext 10.8.0), with add-on ID `term-sherpa@el-jeffe81.github.io`.

### A real bug the Firefox run found
`scripting.executeScript({ files: ['core/untrusted.js', ...] })` worked in Chrome but failed in Firefox ("Unable to load script"):
Firefox resolves a bare path against the calling page (`explain/` or `popup/`), Chrome against the extension root. The paths now start with
`/`, which means the extension root in both. `validate-manifest.js` fails if a bare path comes back.

## Firefox-only DNS check (permission `dns`)
Firefox lets an extension ask the browser to resolve a host name (`browser.dns.resolve`, permission `dns`). Term Sherpa uses it, in Firefox only, to refuse a
document host whose name resolves to a private, loopback, link-local or otherwise non-public address, before any request is sent (`extension/core/dnsguard.js`).
Chrome and Edge have no such API, so there the check is absent and Chrome keeps its previous behavior: only the static address check (https only, names that look local, IP literals refused, and the final URL after a redirect checked the same way before the body is read) applies.
**Known limit (DNS rebinding):** the name is resolved just before the request and the browser resolves it again for the request, so a DNS server that changes its answer in between is not covered. It is a safety net, not a guarantee. The per-site permission prompt remains the main barrier.
The Firefox e2e checks it with `network.dns.localDomains` (the fixture name resolves to loopback and is refused with the plain-words message).

## Install warnings (evidence)
`npm run probe:warnings` loads the manifest in the browser and reads the permission warnings it would show. Measured: **Chrome (156): none (`[]`)** for `activeTab`, `scripting`, `storage` and the optional `https://*/*`.
**Firefox 159:** no install message for `dns` or `storage` (measured). How Firefox for Android words the permissions was not measured (see `FIREFOX_ANDROID.md`).
The new permissions in v1.0.0 versus the earlier prototype: `dns` (Firefox build only). It adds no install warning where measured.

## Consent boxes inside iframes (`allFrames`)
Many "I agree" boxes live in an iframe. The Explain window injects the page reader with `allFrames: true` (falling back to the top frame only), merges what the frames return
(`extension/core/frames.js`), and lists iframes that look like consent boxes but could not be read.
- Chrome: frames the extension may not enter are silently omitted by the browser; the e2e uses extension copies with `host_permissions` because headless Chrome cannot grant `activeTab` by a real toolbar click. **Real Chrome behavior with `activeTab` alone for a frame from another site is unverified.**
- Firefox 159, measured with a real toolbar click and `activeTab` only: a frame from the **same site** is read; a frame from **another site is not**. The window then says so in plain words and offers "Allow that site and look again", which asks for that one site.

## Redirects and JavaScript-only pages
A linked document that redirects is followed only when the final host is one the user allowed or when all-sites access is on (opt-in screen "Read policies wherever they're hosted"). The final URL must be https and pass the address checks, or the answer is discarded unread. Otherwise the window says "<Label> wasn't read. Its link goes to another site, which Term Sherpa doesn't follow yet. Open it and click Term Sherpa there." with a "Read it" button. Known limit: the browser sends one cookie-less GET to the redirect target even then; see `prototype/docs/SECURITY.md`.
A document that has fewer than 200 characters of text after it is loaded without scripts is reported as "This page only shows its text after it runs JavaScript..." with its link. The e2e covers both.

## Real-site check (`npm run test:real`)
`tests/e2e/real-sites.mjs` opens 25 real public pages (big-service terms and privacy pages, news front pages with cookie banners, sign-up pages, a Wikipedia article about terms, example.com) in headless Chrome with the extension, runs the same click-time flow, and records per page: whether anything was detected, the explanation, the number of risks and a screenshot, in `results.json` and `results.md`. It only reads; nothing is clicked or submitted.
It is a snapshot: sites change, show different banners by region, and sometimes block automated browsers. The result table and what it led to fixing are in the release PR.
Fixed because of it: a Services Agreement title (Microsoft) was not recognised; an encyclopedia/news article about terms was explained as if it were the terms; a plain cookie banner inside an iframe (Dropbox) was not recognised.
Not an extension problem: the Guardian and BBC front pages showed no cookie banner in this headless run (a fundraiser and a subscription banner instead), so there was nothing to find.

## The site/ pages
`site/index.html` (product page) and `site/privacy/index.html` (privacy policy) are plain HTML and CSS with no scripts, trackers or external fonts. `.github/workflows/pages.yml` deploys them to GitHub Pages on push to `main` or by hand. Pages is **not enabled** and the repository is private; see `PUBLISHING.md`.

## NOT tested (so nobody assumes it was)
- **A human clicking the toolbar icon** in any browser, and the **real permission prompt** the browser shows for the site. Headless Chromium
  cannot answer that prompt (the Chrome e2e checks the permission step, then runs the full flow on a temporary copy of the extension whose only change is that the same `https://*/*` is granted up front, so the per-site and all-sites modes are two separate throw-away copies and the permission calls are stubbed); in Firefox the prompt is auto-answered by a pref.
  Needs one manual run per browser family in a normal, visible window.
- **Firefox for Android**: cannot run on this box. See `FIREFOX_ANDROID.md` (code and documentation review only).
- **Windows and macOS** builds of any browser. Everything ran on Linux x86-64.
- **Safari**, Firefox for iOS, Chrome for Android (no extension support), Samsung Internet, and any other browser not listed above.
- **Edge / Brave / Opera / Vivaldi built-in extra features** (Brave Shields, Opera's own stores) were not studied; the extension is plain MV3.
- Real-world sites beyond the 25-page snapshot above, in other countries, logged in, or with other browsers.
- Installation from a store or from a signed `.xpi`; the Firefox run used a temporary add-on, which skips signing.
