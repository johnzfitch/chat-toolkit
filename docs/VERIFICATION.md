# Verification — Chat Toolkit 1.7.0

What was actually executed on 2026-09-24, what it showed, and what remains unverified.

## Automated

| Check | Result |
| --- | --- |
| `bun run test` (public, synthetic) | 125 pass, 0 fail |
| `bun run test:private` (owner's HAR replays, not in the repository) | 8 pass, 0 fail: two ChatGPT HARs, Claude Cowork, Gemini (Sept 2 and Sept 24), Grok (Sept 23) |
| `bun run lint:amo` (web-ext 10.7.0) | 0 errors, 0 notices, 1 warning (`KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`; Android not declared) |
| `python scripts/build-xpi.py dist/chat-toolkit-1.7.0-amo.xpi` | 26 files, 123,828 bytes, SHA-256 `3ce648221a411b13636ab3cc9e78142cf6a673a6257c19666b283de359795c9b` (Python 3.14.6, zlib-ng 1.3.1); every member read back |
| `python scripts/build-review-source.py dist/chat-toolkit-1.7.0-review-source.zip` | 72 files from the public allowlist; every member read back (its hash changes with any doc edit, so it is printed by the script, not recorded here) |

Public test files: `claude-cowork`, `gemini-history`, `grok-history`, `openrouter`, `public-release` (background diagnostics, private windows, downloads, manifest), `security` (request destinations, closed UI roots, trusted clicks, hostile HTML, page hooks), `ui-redesign` (export fidelity, scoped exports, parser dispatch, preferences, palette, content pipeline, popup, manifest assets), `export-efficiency` (Gemini regression, de-duplication, Claude search sources, JSON layout).

## Live browser testing

| Date / build | Environment | What ran | Result |
| --- | --- | --- | --- |
| 2026-09-24, pre-redesign 1.7.0 test build | Firefox Nightly 158 (Selenium, fresh profile), logged out: ChatGPT, Claude, Grok, Gemini, AI Studio, OpenRouter | Content script load, palette render, parser, Page inspector | All loaded. Found the parser Worker never starts in Firefox (fails to load from a content script, with or without the web-accessible entry); removed. |
| Same | Nightly 158, copy of the owner's cookies only, read-only | All save variants, API/Page inspector, Compare, Diagnostic capture, Network inspector on ChatGPT (48 messages), Grok (8), Gemini (8) | All succeeded; HTML exports carried the CSP. Claude blocked by a Cloudflare human check (not bypassed); OpenRouter profile not signed in. |
| 2026-09-24, owner, test build round 1 | Owner's Firefox | Exports on all providers | Gemini broken (every message a user "G"); others worked. Fixed; replay test added. |
| 2026-09-24, owner, round 2 | Owner's Firefox, Claude | Full vs Compact, with HAR | Compact identical to Full; 30 of 103 sources were favicon URLs; no reasoning (Claude sends none). Fixed; later Compact removed in favour of one de-duplicating level. |

## Not yet verified

- The final 224 px matte palette and popup (round 3) have not been seen in a browser; only DOM-level tests ran.
- Toolbar theme icons on real light and dark Firefox themes.
- Packaged (non-temporary) install prompt wording for the data-collection declaration.
- Live Claude export after the Sept 24 changes; OpenRouter live export.
- Firefox for Android (not declared).

## Measured export sizes (bytes, owner HARs)

1.6.7 parser versus the 1.7.0 standard export on the same data, from `tests/private/measure-exports.js` (private). No content is removed; the savings come from repetition, whitespace, and empty fields. The 1.6.7 Gemini figure uses the fixed extractor, since 1.6.7 could not read that conversation.

| Conversation | Markdown | JSON |
| --- | --- | --- |
| ChatGPT, July (150 messages) | 339,037 → 331,061 (−2%) | 440,566 → 371,300 (−16%) |
| ChatGPT, August (70 messages) | 251,232 → 237,259 (−6%) | 348,293 → 273,377 (−22%) |
| Grok (8 messages) | 64,365 → 55,447 (−14%) | 241,820 → 76,426 (−68%) |
| Gemini (2 messages) | 23,476 → 19,692 (−16%) | 25,344 → 20,246 (−20%) |
