# Proposed Mozilla Add-ons listing

Publisher: Zack Fitch. Support: zack@definitelynot.ai. License: MIT, copyright 2026 Zack Fitch. Repository: https://github.com/johnzfitch/chat-toolkit. The owner confirmed ownership of the project and its icons. These are submission fields; the public description begins below.

**Name:** Chat Toolkit

**Summary:** Export AI conversations to JSON, Markdown, or HTML. Keep supplied reasoning, citations, and tool results, with optional local diagnostics.

**Suggested categories:** Other; Web Development. Confirm the categories offered by the submission form.

**Platform:** Firefox desktop 140 and later. Android has not been tested or declared compatible.

**Icon:** `extension-src/icons/icon128.png` (the same chat/export symbol is included at toolbar sizes).

## Public description

Save the conversation you have open in a format you can keep, search, or share.

Chat Toolkit adds a compact panel to Claude, ChatGPT, Grok at grok.com, Gemini, Google AI Studio, and OpenRouter. You can also use its Firefox toolbar button.

- Export to JSON, Markdown, or HTML.
- Copy a formatted conversation or drag a Markdown file into another app.
- Export only your messages or only the assistant's replies.
- Retain reasoning text, citations, tool results, and attachment metadata when the provider makes them available.
- Inspect conversation API data, visible-page data, and differences between them using optional diagnostic tools.

Sign in to your chat provider and open a saved conversation before exporting. Service APIs change, and available history varies by platform and conversation type. Some exports fall back to the loaded page. Chat Toolkit does not recover hidden reasoning or unavailable messages.

**How your data is handled**

Chat Toolkit processes exports in your browser and saves them to your downloads folder or clipboard. It has no developer-operated collection server, analytics, or automatic report uploads. When you request an API-backed export or diagnostic, it sends authenticated requests to the current chat provider using session cookies or access tokens and identifiers needed to retrieve your data.

**Optional diagnostics**

The Diagnostics controls can produce reports containing private conversation and account data. Network and Capture record traffic during an explicit inspection or export. ChatGPT research recording stays off until you click Record, is scoped to that tab, and is cleared on navigation or tab closure. Fetching missing research state is a separate action. Export account capture additionally retrieves available settings, memory, project resources, and session metadata on supported providers. Optional page hooks instrument requests during captures and are removed by reloading the page. These tools do not automatically upload their reports.

The extension itself does not charge for these features. Chat-provider accounts, subscriptions, or feature access may be required by the provider.

Chat Toolkit is an independent utility, unaffiliated with the listed chat providers.

## Release notes for 1.6.7

- Grok's current `/c/` conversation routes, response-node history, response loading, and selected branches are supported.
- Export formats retain the full available selected Grok history, supplied reasoning/search steps, sources, and tool results.
- Added Firefox data-use declarations, Help & privacy, explicit diagnostic controls, and a separate account-capture action.
- Diagnostic recording is isolated per tab and no longer writes or restores disk caches.
- Replaced dynamic HTML text insertion with text nodes and added a recognizable chat/export icon.
- Enforced same-origin authenticated requests, excluded authentication bodies from diagnostics by URL path, and kept reports and copy buffers outside ordinary page DOM queries.
- Fixed optional fetch capture timing and stream listener handling; added public provider and security regression tests.
- Released project source and icons under the MIT license with contributor documentation and CI.

## Screenshots to capture from the running extension

No product screenshot has been fabricated. Use a harmless conversation in your own test account to capture the real chat panel, the actual toolbar popup, and one exported Markdown or HTML example. Exclude profile details, sidebar history, cookies, tokens, and personal conversation content. A screenshot is useful listing material; it is not a replacement for testing the extension.
