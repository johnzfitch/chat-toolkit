<img src="extension-src/icons/chat-toolkit-128.png" alt="Chat Toolkit icon" width="80" height="80">

# Chat Toolkit

**Keep your AI conversations in files you control.**

Chat Toolkit is a Firefox desktop extension that copies or saves the conversation you have open as Markdown, JSON, or HTML: all messages, only yours, or only the assistant's. Reasoning, citations, search steps, tool calls and results, created files, and attachment metadata are kept when the provider supplies them. Exports are complete; repetition (identical tool output, a source already linked in the text) is removed so the files stay efficient as context for another model.

[MIT license](LICENSE) · [Privacy](amo/PRIVACY.md) · [Contributing](CONTRIBUTING.md) · [Report a bug](https://github.com/johnzfitch/chat-toolkit/issues)

## Providers

| Website | Retrieval and limits |
| --- | --- |
| Claude | Conversation API and Cowork/code-session events; loaded-page fallback. Claude currently returns no reasoning text, so none is exported. |
| ChatGPT | API history on the selected branch, including supplied tool and reasoning messages; loaded-page fallback. |
| Grok at grok.com | Current `/c/` and older `/chat/` routes; response-tree traversal, selected `rid` branch, and batched history loading. |
| Gemini | Conversation RPC data, the selected response, reasoning, search queries, grounding sources, and product links; loaded-page fallback. |
| Google AI Studio | Loaded-page extraction; unloaded history is unavailable. |
| OpenRouter | Read-only access to chat records in the site's local IndexedDB; loaded-page fallback. |

Provider APIs change. Sign in to the provider and open a saved conversation before exporting. The extension cannot reconstruct messages or reasoning the service withholds. Loaded-page fallbacks include only content the page has loaded, and the result says so. Attachment metadata is exported; remote attachment files are not downloaded.

## Using it

Each supported chat page gets a small palette (224 px), docked left by default:

1. **Copy Markdown** / **Save file**: the two primary actions. Copy's label follows the chosen file type. Each button confirms on itself ("Copied", "Saved"); warnings and errors appear as a short notification.
2. **All · User · Assistant**: which messages.
3. **.md · .json · .html**: which file type.
4. **Advanced tools** (closed by default): API inspector, Page inspector, Compare API and page, Network inspector, Diagnostic capture, Account capture (Claude/ChatGPT), ChatGPT research recording, and page hooks. A small red light in the title bar shows while any recording, the Network inspector, or page hooks are active.

The title-bar menu docks the palette left or right, resets its position, hides it on the current site, and opens Help & privacy. The grip moves it by drag or arrow keys; the minus button collapses it to a small launcher. The toolbar button offers the same export controls, plus showing or hiding the palette for the site. The logo and primary buttons take the current platform's accent colour; the palette follows the system light or dark setting.

See [docs/COMMAND_INVENTORY.md](docs/COMMAND_INVENTORY.md) for every command, its handler, and its data, and [docs/EXPORT_FORMAT.md](docs/EXPORT_FORMAT.md) for the file formats.

## Install for development

Requires **Firefox desktop 140 or later**. This repository contains an unsigned extension; no Mozilla Add-ons listing or signed release is claimed.

1. Clone or download this repository.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Select **Load Temporary Add-on** and choose `extension-src/manifest.json`.
4. Reload your chat page.

Temporary installation lasts until Firefox exits. Normal installation requires a Mozilla-signed package (Firefox Nightly/Developer Edition can install an unsigned XPI with `xpinstall.signatures.required` set to false). Android has not been tested or declared. Publishing instructions and listing copy are in [amo/](amo/SUBMIT.md).

## Privacy and diagnostics

Exports are processed in your browser and go to your downloads folder or clipboard. User-requested operations authenticate to the current provider using your existing session; they never go to another site. Chat Toolkit has **no developer collection server, analytics, advertising, or automatic report uploads**. It stores only panel layout preferences, never conversation content, and writes nothing from private windows.

Diagnostics are explicit, bounded, tab-scoped, and memory-only. Network listeners exist only while a capture or recording runs. Reports can contain private content and identifiers; keep reports and HARs out of public issues. See the [privacy policy](amo/PRIVACY.md), [data-flow audit](docs/DATA_FLOW_AUDIT.md), [permissions](docs/PERMISSIONS.md), and [source review](docs/security-review.md).

## Develop and build

Runtime code is readable JavaScript with no compilation, minification, downloaded code, or third-party runtime dependencies. Development uses Bun **1.3.14** and Python **3.10+**. The lockfile pins web-ext **10.7.0** and Happy DOM **20.14.5**.

```text
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run lint:amo
python scripts/build-xpi.py dist/chat-toolkit-1.7.0-amo.xpi
python scripts/build-review-source.py dist/chat-toolkit-1.7.0-review-source.zip
```

The public tests use synthetic fixtures and need no provider account, network access, or private HAR. The owner's optional replay suite (`bun run test:private`) and its HARs are ignored and absent from the repository.

Build scripts refuse to overwrite archives, read every archive member back, check CRCs, and print SHA-256 hashes. Fixed ZIP timestamps and modes give identical XPI bytes with matching source and Python/zlib versions. Icons are generated from `assets/design/chat-toolkit-mark.svg` by `scripts/build-icons.py` (Pillow and resvg-py); the generated PNGs are committed, so a normal build does not regenerate them. `scripts/capture-listing-screenshots.py` renders listing screenshots from the synthetic harness in `assets/design/listing-harness/`.

[CI](.github/workflows/ci.yml) runs the public tests, Mozilla lint, and both builds. Lint reports one Android data-consent minimum-version warning even though the manifest targets desktop; see [reviewer notes](amo/REVIEWER-NOTES.md).

## Source map

| Path | Purpose |
| --- | --- |
| `extension-src/lib/common.js` | Platform detection and shared helpers. |
| `extension-src/lib/ui-model.js` | Shared command model, provider accents, preferences, drawn icons, and stylesheet for the palette and popup. |
| `extension-src/lib/dom-helpers.js` | Loaded-page extraction and snapshots. |
| `extension-src/lib/api-fetchers.js` | Same-origin provider retrieval and history traversal. |
| `extension-src/lib/parser-worker.js` | Normalization, branch selection, and Markdown/JSON/HTML rendering (runs as a content script; the name predates removal of an unused Worker). |
| `extension-src/lib/page-bridge.js` | Parser entry point and optional page request hooks. |
| `extension-src/lib/ui-panel.js` | Palette, notifications, report window, and clipboard. |
| `extension-src/lib/content.js` | Command dispatch and export orchestration. |
| `extension-src/lib/background.js` | Generated-file downloads and on-demand, tab-scoped network capture. |
| `extension-src/popup/` | Toolbar popup. |
| `tests/public/` | Provider, export, UI, diagnostic, and security regressions. |
| `amo/` | Listing, privacy policy, reviewer notes, submission guide. |
| `docs/` | Command inventory, permissions, data flows, policy mapping, export format, verification, source review, handoff. |
| `assets/design/`, `store/` | Icon master, screenshot harness, and listing icons (not packaged). |

## Author and license

Created by **Zack Fitch** · [zack@definitelynot.ai](mailto:zack@definitelynot.ai). Code, icons, and drawn UI glyphs are released under the [MIT License](LICENSE), copyright 2026 Zack Fitch. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Chat Toolkit is an independent utility, unaffiliated with the listed chat providers. Provider accounts, paid plans, and feature entitlements remain subject to each provider's terms.
