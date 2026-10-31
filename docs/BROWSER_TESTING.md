# Browser testing: what was run, how, and what was not

Everything here is free software on a Linux box with no display (headless). Nothing is published and no store account is involved.
All test sites are invented (`*.test` names served from 127.0.0.1); no real site is contacted.

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
npm test                                   # unit suite (node:test), 208 tests
npm run validate                           # source manifest + both built packages
npm run build                              # dist/chrome, dist/firefox + zips
npm run lint:firefox                       # npx web-ext@10.8.0 lint -s dist/firefox (downloads web-ext on first use)
CHROME_BIN=/path/to/browser npm run test:e2e              # Chromium-family e2e (35 checks)
FIREFOX_BIN=/path/to/firefox GECKODRIVER_BIN=/path/to/geckodriver npm run test:e2e:firefox   # Firefox e2e (12 checks)
```
Both e2e scripts skip themselves (exit 0, "SKIP") if the browser is not found. They need `openssl` for the local https fixture server.

### Chromium-family e2e (`tests/e2e/chrome-smoke.mjs`)
Drives the browser over the DevTools protocol on a pipe (`--remote-debugging-pipe`), loads the **unpacked source folder** with
`Extensions.loadUnpacked`, opens a fixture news page with an "Agree" dialog, and checks 35 things: the injected page scripts, the
permission step, the guarded fetch (https only, no cookies, no Referer, robots.txt, redirects not followed, loopback refused), the
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
| Google Chrome | 156.0.8078.47 | e2e, unpacked source | 35/35 |
| Microsoft Edge | 156.0.4314.58 | same e2e, `CHROME_BIN` | 35/35 |
| Brave | 1.98.63 (Chromium 156.0.8078.80) | same e2e | 35/35 |
| Vivaldi | 8.2.4133.96 | same e2e, opener-based tabs | 35/35 |
| Opera | 139.0.6053.22 (Chromium 155) | same e2e, `GSETTINGS_SCHEMA_DIR` | 35/35 |
| Firefox desktop | 159.0 (geckodriver 0.37.1) | Firefox e2e, `dist/firefox` | 12/12 |

Plus: `npm test` 208/208, `npm run validate` OK, `web-ext lint -s dist/firefox` 0 errors / 0 warnings / 0 notices (web-ext 10.8.0), with add-on ID `term-sherpa@el-jeffe81.github.io`.

### A real bug the Firefox run found
`scripting.executeScript({ files: ['core/untrusted.js', ...] })` worked in Chrome but failed in Firefox ("Unable to load script"):
Firefox resolves a bare path against the calling page (`explain/` or `popup/`), Chrome against the extension root. The paths now start with
`/`, which means the extension root in both. `validate-manifest.js` fails if a bare path comes back.

## NOT tested (so nobody assumes it was)
- **A human clicking the toolbar icon** in any browser, and the **real permission prompt** the browser shows for the site. Headless Chromium
  cannot answer that prompt (the Chrome e2e checks the permission step, then runs the full flow on a temporary copy of the extension whose only change is that the same `https://*/*` is granted up front); in Firefox the prompt is auto-answered by a pref.
  Needs one manual run per browser family in a normal, visible window.
- **Firefox for Android**: cannot run on this box. See `FIREFOX_ANDROID.md` (code and documentation review only).
- **Windows and macOS** builds of any browser. Everything ran on Linux x86-64.
- **Safari**, Firefox for iOS, Chrome for Android (no extension support), Samsung Internet, and any other browser not listed above.
- **Edge / Brave / Opera / Vivaldi built-in extra features** (Brave Shields, Opera's own stores) were not studied; the extension is plain MV3.
- Real-world sites. The fixtures are invented; a live check (for example a real "I agree" dialog) was not done.
- Installation from a store or from a signed `.xpi`; the Firefox run used a temporary add-on, which skips signing.
