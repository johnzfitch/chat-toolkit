# Changelog

## 1.7.0 — 2026-09-24

Exports
- One standard export: complete content with repetition removed (identical long tool outputs become a reference; sources already linked in the text are not listed again; Grok raw fields already exported as reasoning, blocks, or sources are dropped). JSON is `export_version` 5: one message per line, empty and zero fields omitted. Measured on real conversations: JSON 16–68% smaller, Markdown 2–16% smaller.
- Claude JSON now includes reasoning (when supplied), tool calls, tool output, and created files; previously only message text.
- JSON and HTML can be scoped to user or assistant messages, like Markdown.
- Gemini: fixed exports that turned every message into a user message reading "G" (reasoning steps were mistaken for turns); shopping placeholders become real product links and sources; tab-title suffix removed from titles.
- Emoji and symbols are no longer stripped; blank lines inside code blocks are preserved; fences grow when content contains backticks.
- Site favicon URLs are no longer listed as sources.
- HTML exports carry a restrictive CSP and no-referrer policy.

Interface
- New 224 px matte palette: Copy / Save first, pressed-key All · User · Assistant and .md · .json · .html selectors, Advanced tools last. Platform accent on the logo and primary buttons. Outcomes confirm on the pressed button; warnings and errors notify. A title-bar light shows only while diagnostics run.
- Toolbar popup rebuilt with the same controls; its menu shows or hides the page palette per site. Palette docking, reset, collapse, hide-on-site, and keyboard movement.
- New identity and toolbar icons (light and dark theme variants) and drawn 16 px icons. Drag export, the status footer, and theme/density options removed.

Diagnostics and permissions
- Network inspector records until selected again (was a fixed 250 ms window). Enable page hooks no longer turns on research recording. Parser errors no longer disable parsing for the tab.
- webRequest listeners attach only while a capture or recording runs; background page is persistent so recordings are not discarded.
- Removed `activeTab`, `api.anthropic.com`, and the web-accessible parser script; added `storage` for layout preferences (never written from private windows).
- Removed unused code: Worker parser path, Gemini capture fallback that cleared its own data, character-budget code, unused helpers and exports.

## 1.6.7 — 2026-09-23

- Apply Zack Fitch's author/support details and the MIT license, including the license in release archives.
- Organize the public repository with synthetic provider tests, contribution/security guidance, and CI; keep private HAR replay material local.
- Enforce the current provider's HTTPS origin before authenticated fetches and reject redirects. Encode provider path identifiers.
- Exclude authentication response bodies from diagnostic capture by decoded URL path, including query-string attempts to resemble research endpoints.
- Keep reports, copy buffers, and controls in closed shadow roots; require trusted UI events for data actions. Restrict downloads to generated files.
- Bound optional page-hook captures, retain XHR/stream state in content-script WeakMaps, preserve page listener removal, and clone fetch responses before the page consumes them.
- Reject inherited parser command names and add credential, markup, UI, and diagnostic regressions.

## 1.6.6 — 2026-09-23

- Add Firefox data-use declarations, Help & privacy, public listing material, and reproducible build scripts.
- Make research recording opt-in, isolated per tab, and memory-only; disable diagnostics in private windows and remove legacy caches on Clear.
- Separate ordinary conversation capture from account capture and render notification text literally.
- Add the project chat/export icon.

## 1.6.5 — 2026-09-23

- Recognize Grok's `/c/<uuid>` and older `/chat/<uuid>` routes.
- Load Grok response-node history and message bodies in batches, preserving the selected branch and supplied reasoning, sources, and tool data.
- Report HTTP, challenge-page, incomplete-history, and schema errors instead of claiming an empty successful export.

These entries describe source versions and local builds. They do not imply that the versions were signed or published on Mozilla Add-ons.
