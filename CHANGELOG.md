# Changelog

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
