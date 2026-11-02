# Firefox for Android: compatibility review (not run on a phone)

**Status: reviewed by reading the code and the MDN browser-compat data (checked 2026-10-31). NOT run on a real phone or emulator**; this box has none. What *was* tested: the layout at a 360 px wide phone viewport in headless Chrome (see "UI on a small screen"), and everything else on desktop Firefox 159 and Chrome 156.
Treat everything below as "should work, unverified" until someone tries it on a device. No store listing exists, so nothing is published for Android.

## Manifest
`prototype/manifests/firefox.overlay.json` declares `gecko_android.strict_min_version = "142.0"`. 142 is the first Android release that knows
`data_collection_permissions` (desktop: 140), which AMO requires for new extensions. The declaration also tells AMO the add-on is meant for Android.
Mozilla's own guidance says Manifest V2 is the safer choice on Android because Android lacks full MV3 parity. This extension has no background,
no content scripts and no declarativeNetRequest, so it does not hit the known MV3 gaps, but that is a judgement from reading, not a test.

## API by API

| API used (where) | Firefox for Android | Notes |
|---|---|---|
| `action.default_popup` (`explain/launcher.html`) | Supported (mirrors desktop) | Shown from the extensions menu. The popup is only a launcher. |
| `scripting.executeScript` with `files` / `func` | Supported (MDN: mirrors desktop, 102+) | Paths start with `/` (extension root); see BROWSER_TESTING.md. |
| `activeTab` | Supported (manifest permission, mirrors desktop) | Granted when the user opens the action; **not run** on Android. |
| `permissions.request` / `contains` / `getAll` / `remove` | `request` from 120, the rest from 79 | `request` must be called from a user click. `explain.js` calls it synchronously from the "Read these documents" click; nothing awaits before it. |
| `optional_host_permissions` (MV3) | Supported | Prompt UI on Android was not seen. |
| `tabs.query({active, currentWindow})`, `tabs.get`, `tabs.create` | Supported | MDN: `tabs.query` on Android "may only return a subset" of tabs; the active-tab query is the common case. |
| `windows.create` (`launcher.js`) | **Not supported** | Fixed in this branch: the launcher checks for `chrome.windows.create` and falls back to `tabs.create`; a unit test covers "missing" and "rejects". |
| IndexedDB (`popup/db.js`, opt-in storage) | Standard web API | Works in desktop Firefox (e2e). |
| `fetch` with `redirect:'follow'` (plus one `redirect:'manual'` probe), `credentials:'omit'` | Standard web API | Same engine as desktop. Not run on Android; the Firefox desktop e2e (`firefox-smoke.mjs`) has been updated for the v1.1 behaviour but could not be run in the environment that made the change. |

## UI on a small screen
Done in v1.0.0 (CSS only, `explain/explain.css`, `popup/popup.css`; every page has `<meta name="viewport" content="width=device-width, initial-scale=1">`):
- Under 480 px wide, or on a touch screen (`pointer: coarse`): 16 px body text, 17 px risk sentences, no text smaller than 13 px, and every button, link, "Show exact wording" summary, input and checkbox row at least 44 px tall (buttons 48 px).
- The launcher popup (280 px on desktop) and the saved-copies page (380 px) become full width under 420 px; long words and addresses wrap instead of scrolling sideways.
- **Tested**: `npm run test:e2e` opens the explain window (with a real analysis, quotes open, and again with every hidden section shown), the launcher and the saved-copies page at 360 x 740 with mobile emulation in headless Chrome, and fails on any sideways scroll, any tap target under 44 px, or any text under 13 px. A screenshot is written when `TC_SHOT` is set.
- **Not tested**: how it looks and feels in Firefox for Android itself (fonts, the system keyboard covering the paste box, the Android back button).

On Android the Explain page opens as a normal **tab** (no popup windows). The toolbar popup closes when focus moves to the new tab; the tab keeps the id of the page to read, and `activeTab` access was granted to that page when the user opened the action. Whether Firefox for Android keeps that grant after the tab switch is **unverified** and is the first thing to try on a device.

## Other Android notes
- Firefox-only `dns` permission (used by the DNS check in `core/dnsguard.js`): it is in the shared Firefox build, so Android gets it too. `browser.dns.resolve` is not listed as unsupported on Android in the MDN data, but that is unverified; if it were missing, `TCDnsGuard.fromBrowser` returns no check and the fetch still has all its other guards (https only, no IP addresses, no redirects, robots.txt).
- Iframes: the page is read with `allFrames`. On desktop Firefox 159, `activeTab` covered a same-site frame but NOT a frame from another site (tested with a real toolbar click); the window then says so and offers "Allow that site and look again". Android behaviour is unverified.
- First-run welcome screen and the disclaimer line are plain HTML and appear the same on Android.

## Known risks, in order
1. `activeTab` grant surviving the switch to the new tab (see above). If it does not, the fix is to read the page from the launcher popup before opening Explain, or to open Explain in the same tab.
2. The optional-permission prompt on Android for the `https://*/*` pattern: it is requested per site by default, and for all sites only after the user taps "Allow all sites" on the Term Sherpa opt-in screen. Whether Android shows that prompt, and the "Read it" tab fallback, are untested.
3. Extension install on release Firefox for Android needs an AMO listing (or an AMO-signed unlisted file); a temporary add-on needs a USB-connected device and `web-ext run -t firefox-android`.

## How to test it on a real phone (free)
You need the Firefox package: `cd prototype && npm run build:firefox` gives `dist/firefox/`.

1. On the phone install Firefox **Nightly** (or Beta) from Google Play. Release Firefox only installs add-ons from AMO.
2. On the phone turn on Developer options and USB debugging (Android Settings > About phone > tap "Build number" 7 times). In Firefox Nightly: Settings > Advanced > Remote debugging via USB (on).
3. On the computer install Android Platform Tools (`adb`), connect the phone by USB, run `adb devices` and accept the prompt on the phone. Note the device id it prints.
4. `cd prototype/dist/firefox`, then `npx web-ext@10.8.0 run -t firefox-android --android-device <device id> --firefox-apk org.mozilla.fenix` (Nightly; `org.mozilla.firefox_beta` for Beta). Firefox on the phone restarts with Term Sherpa loaded as a temporary add-on, and it is removed when you stop the command.
5. Optional: in desktop Firefox open `about:debugging`, connect to the phone, and inspect the extension's pages and console if something fails.

**What to check (write the results in OPEN_QUESTIONS.md)**
1. Open the extensions menu (three dots > Add-ons / Extensions), tap Term Sherpa. Expected: first time, the welcome screen, then "Continue".
2. Open a real terms page (for example the Terms of Service of any large site), tap Term Sherpa again. Expected: the Explain page opens in a tab and shows the page. (If it says it cannot read the page, that is risk 1 above.)
3. Open a site with an "I agree" box or cookie banner, tap Term Sherpa, tap "Read these documents". Expected: a permission prompt for that one site, then one combined explanation.
4. Text is readable, buttons are easy to tap, nothing scrolls sideways, the disclaimer line is at the bottom.
5. "Remove the site access I have allowed" removes the site.
