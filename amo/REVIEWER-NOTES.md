# Reviewer notes — Chat Toolkit 1.6.7

Author: Zack Fitch <zack@definitelynot.ai>. MIT licensed, copyright 2026 Zack Fitch. Project and icon ownership were confirmed by the author. Source: https://github.com/johnzfitch/chat-toolkit.

This is a plain-JavaScript Manifest V2 extension for Firefox desktop 140 and later. Runtime code is shipped directly, without minification, transpilation, remote scripts, or third-party runtime libraries. No CSP or other security response headers are altered. Optional page hooks use Firefox's `exportFunction` and `wrappedJSObject`; they are not installed on startup and cannot be enabled by page storage flags.

## Rebuild

Use the included source ZIP, Python 3.10+, and the command below from the extracted root:

```text
python scripts/build-xpi.py rebuilt-review.xpi
```

No dependency download is required to build. All PNG icons are included. The script writes the contents of `extension-src` plus the root MIT `LICENSE` into a fresh archive, checks CRCs and byte equality, and prints the archive SHA-256 and tool versions. Identical source and Python/zlib versions produce identical ZIP bytes; archive-member bytes match across supported environments. The optional Windows icon generator is `scripts/build-icons.ps1`.

For validator and synthetic tests, install Bun, then run:

```text
bun install --frozen-lockfile --ignore-scripts
bun run lint:amo
bun run test
```

The validator dependency is pinned to web-ext 10.7.0. No npm dependencies are packaged into the extension. The owner's working repository also has private HAR replay tests; HARs, their contents, and those private-fixture tests are deliberately absent from the review ZIP.

## Permissions and data declarations

| Permission | Used for |
| --- | --- |
| Supported HTTPS host permissions | Run content scripts and retrieve the conversation from the provider in the signed-in tab. |
| api.anthropic.com host permission | Observe Claude API traffic during optional diagnostics; no script is injected into this host. |
| activeTab | Route a toolbar action to the visible supported chat tab. |
| clipboardWrite | Copy formatted HTML or text after asynchronous conversation fetching. |
| downloads | Save user-requested exports and reports through the background page. |
| webRequest, webRequestBlocking | Optional tab-scoped metadata and response capture through `filterResponseData`; original bytes are forwarded unchanged. |

The manifest's required data types are `authenticationInfo` and `websiteContent`. This is our classification of the provider cookies/access token and request context used for authenticated retrieval, following Mozilla's taxonomy. Chat text is processed locally; there is no extension-operator collection endpoint, telemetry, or advertising. No implicit-consent exemption is claimed. Firefox 140+ provides the built-in installation consent prompt. Ancillary diagnostics require explicit actions in Chat Toolkit's named Diagnostics controls.

Continuous research recording is disabled by default, restricted to its opted-in tab, and never written to disk. Tab navigation, reload, removal, or extension background unload discards it. Private-window recording and hooks are disabled. Responses from requests with no attributable tab are not assigned to a guessed account. The Clear action deletes legacy diagnostic caches without reading them.

## Functional review

1. Temporarily load `extension-src/manifest.json` through `about:debugging`. Open the toolbar's Help & privacy page; it works even outside a supported chat website.
2. Sign in to a supported provider using a dedicated test account. Open a saved conversation containing at least two user/assistant pairs. On Grok, use a `https://grok.com/c/<uuid>` conversation. Refresh the page after installing the extension.
3. Use JSON, MD, and HTML. Confirm the saved files contain the available selected history and that HTML renders conversation text as text, not executable markup. Check user-only and assistant-only exports, Copy, and dragging a Markdown file.
4. On Grok, selecting an earlier response with the provider's `rid` URL parameter should end the export at that response's parent chain. If history access returns an HTTP or schema error, the extension reports it instead of claiming an empty successful export.
5. Open Diagnostics. Record stays off before you click it. On ChatGPT, Record observes research/MCP traffic and related events in that tab; Stop prevents new recording. A second tab or container showing the same conversation must not receive the first tab's recording. Clear removes it. Navigation/reload/tab close disables recording.
6. Network opens a short metadata capture. Capture exports the current conversation with bounded diagnostic details. Broader account resources are retrieved only with Export account capture on Claude/ChatGPT. Optional page hooks require their own Enable page hooks action; reload removes them.
7. In private windows, background recording and page hooks report unavailable. Explicit conversation exports still operate if Firefox and the provider allow access.

Provider features may require paid plans; the extension does not sell a subscription or unlock provider entitlements. Google AI Studio uses loaded-page extraction. Other providers may use a DOM fallback if the API cannot supply messages. Unloaded content and provider-withheld reasoning cannot be reconstructed.

**Test-account credentials:** not supplied in this source archive. The publisher must supply dedicated reviewer credentials in AMO's private reviewer field for account-gated functionality, including any plan-specific feature being advertised. Do not substitute the owner's live cookies, access tokens, or HAR files. Mozilla's submission policies require sufficient testing access.

## Executed checks and limits

The public suite is in `tests/public/` and runs with `bun run test`. It exercises provider parsing and selected history, error handling, authenticated request destinations, recording defaults, memory-only storage, tab isolation, private windows, Clear/navigation/close behavior, unchanged response forwarding, account-capture separation, HTML escaping, closed UI roots, trusted UI actions, parser dispatch, and optional page hooks. It needs no private capture or account. Eight additional local HAR tests are run separately with `bun run test:private`; those tests and their private fixtures are absent from Git and the review ZIP. The [source review](../docs/security-review.md) describes changes, producing commands, and limitations.

The validator reports one retained warning, `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`: desktop minimum 140 is earlier than Android's data-consent support at 142. The manifest deliberately omits `gecko_android`, so AMO should list it for desktop only. This warning is also reported in Mozilla web-ext issue 3561. Android has not been tested; declaring it supported to silence this warning would be inaccurate.

The validator's metadata heuristically lists `lib/background.js` as an unknown minified file. It is readable source with comments and named functions; no minification step exists. This metadata entry is not an additional warning.

Live authenticated Firefox execution and provider-account testing were not available in the preparation environment. Offline replay, ordinary unit/integration tests, and static validation do not establish live service compatibility or Mozilla approval.

## Code map

- `common.js`, `dom-helpers.js`: platform detection and loaded-page extraction.
- `api-fetchers.js`: authenticated provider reads; Grok metadata, response-node traversal, and response batches.
- `parser-worker.js`: normalization, active-branch selection, text/HTML exports; also serves as the Worker fallback.
- `content.js`: explicit user actions; separates ordinary capture from account capture.
- `background.js`: local downloads and opt-in, memory-only request capture.
- `page-bridge.js`: Worker dispatch and separately enabled page hooks.
- `ui-panel.js`, `popup/`, `help/`: user controls, disclosures, and privacy information.

References: [Mozilla submission policies](https://extensionworkshop.com/documentation/publish/add-on-policies/), [data-consent taxonomy](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/), [desktop/Android compatibility](https://extensionworkshop.com/documentation/publish/version-compatibility/), [web-ext issue 3561](https://github.com/mozilla/web-ext/issues/3561).
