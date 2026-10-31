# Firefox for Android: compatibility review (not run)

**Status: reviewed by reading the code and the MDN browser-compat data (checked 2026-10-31). NOT run on a device or emulator**; this box has none.
Treat everything below as "should work, unverified" until someone tries it. No store listing exists, so nothing is published for Android.

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
| `fetch` with `redirect:'manual'`, `credentials:'omit'` | Standard web API | Same engine as desktop; behaviour matches the desktop e2e (redirects not followed). |

## UI on a small screen
- Before this branch the Explain page had no `<meta name="viewport">`, so a phone would show it as a zoomed-out 980 px page. Added to
  `explain.html`, `launcher.html`, `popup.html`.
- On Android the Explain page opens as a normal **tab** (no popup windows). The toolbar popup closes when focus moves to the new tab; the tab
  keeps the id of the page to read, and `activeTab` access was granted to that page when the user opened the action. Whether Firefox for Android
  keeps that grant after the tab switch is **unverified** and is the first thing to try on a device.
- `body.launcher` is fixed at 280 px and the saved-copies page at 380 px; both switch to full width under 420 px. Visual result not checked.
- Touch targets and text size were not reviewed against Android guidelines.

## Known risks, in order
1. `activeTab` grant surviving the switch to the new tab (see above). If it does not, the fix is to read the page from the launcher popup before opening Explain, or to open Explain in the same tab.
2. The optional-permission prompt on Android for `https://*/*`-pattern sites (it is requested per site, not for all sites).
3. Extension install on release Firefox for Android needs an AMO listing (or an AMO-signed unlisted file); a temporary add-on needs a USB-connected device and `web-ext run -t firefox-android`.

## How to test it for real (free)
1. Install Android Studio's emulator or use a spare phone with USB debugging, plus Firefox (Nightly, Beta or release) on it.
2. `cd prototype && npm run build:firefox`, then from `dist/firefox`: `npx web-ext run -t firefox-android --firefox-apk org.mozilla.firefox` (use `org.mozilla.fenix` for Nightly).
3. Open an invented terms page served from your computer, open the extensions menu, tap Terms Guide, confirm the Explain tab opens, tap "Read these documents", and confirm the permission prompt and the explanation.
