# Reviewer notes — Chat Toolkit 1.7.0

Author: Zack Fitch <zack@definitelynot.ai>. MIT licensed. Source: https://github.com/johnzfitch/chat-toolkit.

A plain-JavaScript Manifest V2 extension for Firefox desktop 140 and later. Runtime code is shipped as written, without minification, transpilation, remote scripts, eval, or third-party libraries. No CSP or other security headers are altered. The page palette lives in a closed shadow root; its actions require trusted clicks and it exposes no moz-extension URL.

## Rebuild

From the source ZIP's root with Python 3.10+:

```text
python scripts/build-xpi.py rebuilt-review.xpi
```

No download is needed. The script packages `extension-src/` plus `LICENSE`, verifies every member, and prints the SHA-256. With the same Python/zlib versions the bytes match. Icons are pre-rendered from `assets/design/chat-toolkit-mark.svg` (`scripts/build-icons.py`, optional). Tests and lint: `bun install --frozen-lockfile --ignore-scripts`, `bun run test`, `bun run lint:amo` (web-ext 10.7.0).

## Permissions

| Permission | Used for |
| --- | --- |
| Seven provider hosts | Content scripts, same-origin conversation retrieval, and diagnostics on those sites only |
| `clipboardWrite` | Copy after the conversation is fetched |
| `downloads` | Save generated files and reports (generated content only; URLs are refused) |
| `storage` | Palette layout and export choices; never conversation content; no writes from private windows |
| `webRequest`, `webRequestBlocking` | Network inspector and diagnostic captures (`filterResponseData`, bytes forwarded unchanged). Listeners are added only while a capture or recording runs and removed afterwards |

Details: `docs/PERMISSIONS.md`, `docs/DATA_FLOW_AUDIT.md`.

## Data declaration

Required `authenticationInfo` and `websiteContent`: user-initiated requests send the provider's own cookies/token and conversation identifiers to that same provider to retrieve the open conversation, which is then saved locally. Nothing is sent to the developer or any third party, and no chat text is transmitted, so `personalCommunications` is not declared. No implicit-consent exemption is claimed.

## Functional review

1. Install the XPI (or load `extension-src/manifest.json` temporarily) and reload a supported chat. Help & privacy is reachable from the palette menu and the toolbar popup.
2. Sign in with the provided test account and open a saved conversation with at least two exchanges. On Grok use a `https://grok.com/c/<uuid>` conversation.
3. In the palette: choose **All / User / Assistant** and **.md / .json / .html**, then **Copy** and **Save file**. The button confirms ("Copied"/"Saved"); a loaded-page fallback shows a warning. HTML files render text only and carry `Content-Security-Policy: default-src 'none'`.
4. **Advanced tools**: API inspector, Page inspector, Compare API and page, and Diagnostic capture open reports or save a `.capture.json`. Network inspector starts on the first click and reports on the second. Account capture (Claude/ChatGPT) additionally reads account resources. On ChatGPT, Record research / Stop / Clear control memory-only recording in that tab; a red light shows while it runs.
5. Menu: Dock left/right, Reset position, Hide on this site (the toolbar popup can show it again).
6. Private window (if allowed): exports work; diagnostics, page hooks, and preference writes are refused.

Unloaded content and provider-withheld reasoning cannot be recovered. Claude currently supplies no reasoning text.

**Test-account credentials:** supplied in AMO's private reviewer field, not in this archive.

## Checks

`bun run test`: 125 tests, 0 failures. `bun run lint:amo`: 0 errors, 1 warning, `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` (desktop minimum 140 is below Android's consent support at 142; `gecko_android` is deliberately omitted and Android is not claimed). Live checks are listed in `docs/VERIFICATION.md`.

## Code map

- `common.js`, `ui-model.js`: platform detection; shared commands, accents, icons, styles.
- `dom-helpers.js`, `api-fetchers.js`: loaded-page extraction; same-origin provider retrieval.
- `parser-worker.js`: normalization and Markdown/JSON/HTML rendering, run as a content script.
- `page-bridge.js`: parser entry and opt-in page hooks.
- `ui-panel.js`, `content.js`: palette, reports, clipboard; command dispatch.
- `background.js`: downloads and on-demand, tab-scoped request capture.
- `popup/`, `help/`: toolbar popup; Help & privacy.
