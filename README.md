<img src="extension-src/icons/icon128.png" alt="Chat Toolkit icon" width="80" height="80">

# Chat Toolkit

**Keep your AI conversations in files you control.**

Chat Toolkit is a Firefox desktop extension that exports the conversation you have open to JSON, Markdown, or HTML. Copy formatted content, drag a Markdown file to another app, or save only your messages or the assistant's replies. Reasoning, citations, search steps, tool results, and attachment metadata are retained when the provider supplies them.

[MIT license](LICENSE) · [Privacy](amo/PRIVACY.md) · [Contributing](CONTRIBUTING.md) · [Report a bug](https://github.com/johnzfitch/chat-toolkit/issues)

## Providers

| Website | Retrieval and limits |
| --- | --- |
| Claude | Conversation API and Cowork/code-session events; loaded-page fallback. |
| ChatGPT | API history on the selected branch, including supplied tool and reasoning messages; loaded-page fallback. |
| Grok at grok.com | Current `/c/` and older `/chat/` routes; response-tree traversal, selected `rid` branch, and batched history loading. |
| Gemini | Conversation RPC data and selected responses; loaded-page fallback. |
| Google AI Studio | Loaded-page extraction; unloaded history is unavailable. |
| OpenRouter | Read-only access to chat records in the site's local IndexedDB; loaded-page fallback. |

Provider APIs change. Sign in to the provider and open a saved conversation before exporting. The extension cannot reconstruct messages or reasoning the service withholds. DOM fallbacks include only content loaded in the page. Available attachment metadata is exported; remote attachment files are not automatically downloaded.

## Install for development

Requires **Firefox desktop 140 or later**. This repository contains an unsigned extension; no Mozilla Add-ons listing or signed release is claimed.

1. Clone or download this repository.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Select **Load Temporary Add-on** and choose `extension-src/manifest.json`.
4. Reload your chat page. Use the Chat Toolkit panel or the toolbar button.

Temporary installation lasts until Firefox exits. Normal installation requires a Mozilla-signed package. Android compatibility has not been tested or declared. Publishing instructions and listing copy are in [amo/](amo/SUBMIT.md).

## Privacy and diagnostics

Exports are processed in your browser and go to your chosen download, clipboard, or drag destination. User-requested API operations authenticate to the current provider using your existing session. Chat Toolkit has **no developer collection server, analytics, advertising, or automatic report uploads**.

The optional Diagnostics controls inspect API data, the visible page, and bounded request captures. ChatGPT research recording starts off, is isolated to its tab, and is cleared on navigation or tab closure. Account capture is a separate action. Page request hooks require a separate opt-in and can affect site behavior; reload removes them. Diagnostic reports can contain private content and identifiers. Keep reports and HARs out of public issues.

See the [privacy policy](amo/PRIVACY.md) for permissions, retention, and data details, and the [source review](docs/security-review.md) for tested behavior and remaining limits.

## Develop and build

Runtime code is readable JavaScript with no compilation, minification, downloaded code, or third-party runtime dependencies. Development uses Bun **1.3.14** and Python **3.10+**. The lockfile pins development dependencies, including web-ext **10.7.0** and Happy DOM **20.14.5**.

```text
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run lint:amo
python scripts/build-xpi.py dist/chat-toolkit-1.6.7-amo.xpi
python scripts/build-review-source.py dist/chat-toolkit-1.6.7-review-source.zip
```

The public tests use synthetic fixtures and do not need a provider account, network access, or private HAR. The explicit `./tests/public` path prevents Bun from discovering older extracted releases elsewhere in the workspace. The owner's optional local replay suite uses `bun run test:private`; its tests and HARs are ignored and absent from the public repository.

Build scripts refuse to overwrite archives, create their output directory, read every archive member back, check CRCs, and print SHA-256 hashes. The XPI contains `extension-src/` contents plus `LICENSE`. The source ZIP uses an explicit public-file allowlist. Fixed ZIP timestamps and file modes produce identical XPI bytes with matching source, Python, and zlib versions. Included PNG icons require no regeneration; `scripts/build-icons.ps1` can regenerate them on Windows using .NET drawing.

[CI](.github/workflows/ci.yml) runs public tests, Mozilla lint, and both builds. Its unsigned artifacts are for inspection; CI does not sign or submit an extension. Lint currently reports an Android data-consent minimum-version warning even though this manifest targets desktop; see [reviewer notes](amo/REVIEWER-NOTES.md).

## Source map

| Path | Purpose |
| --- | --- |
| `extension-src/lib/api-fetchers.js` | Same-origin provider retrieval and history traversal. |
| `extension-src/lib/parser-worker.js` | Normalization, branch selection, and export rendering in a Worker or local fallback. |
| `extension-src/lib/content.js` | User actions and export orchestration. |
| `extension-src/lib/background.js` | Generated-file downloads and optional tab-scoped network capture. |
| `extension-src/lib/page-bridge.js` | Worker dispatch and optional page request instrumentation. |
| `extension-src/lib/ui-panel.js` | Panel, reports, notifications, and clipboard helpers. |
| `extension-src/lib/common.js`, `dom-helpers.js` | Platform detection and loaded-page extraction. |
| `tests/public/` | Provider, export, diagnostic, and security regressions. |
| `amo/` | Listing, privacy policy, reviewer instructions, and submission guide. |

## Author and license

Created by **Zack Fitch** · [zack@definitelynot.ai](mailto:zack@definitelynot.ai). Code and project icons are released under the [MIT License](LICENSE), copyright 2026 Zack Fitch. Development dependencies retain their respective upstream licenses and are not shipped in the extension.

Chat Toolkit is an independent utility, unaffiliated with the listed chat providers. Provider accounts, paid plans, and feature entitlements remain subject to each provider's terms.
