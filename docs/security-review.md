# Source review — version 1.7.0

Covers all runtime JavaScript, the manifest, the popup, and the packaged help page in `extension-src/`: request destinations and credentials, diagnostics and retention, page interaction, downloads, parser dispatch, and export rendering, against [Mozilla's add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/) (read September 24, 2026). Policy mapping: [POLICY_COMPLIANCE.md](POLICY_COMPLIANCE.md).

## Changes in 1.7.0 and their tests

| Finding | Behaviour now | Public tests |
| --- | --- | --- |
| A blocking `webRequest` listener with request bodies saw every provider request at all times. | Listeners attach when a capture or recording starts and detach when idle (after a 15 s grace period for in-flight requests). | `public-release`: listeners attach only while recording or capturing |
| The parser Worker never started in Firefox, but `lib/parser-worker.js` was web-accessible to every site. | Worker path and `web_accessible_resources` removed; parsing runs in the content script (as it effectively always had). | `ui-redesign`: no Worker, no web-accessible script |
| `activeTab` and `https://api.anthropic.com/*` were unused. | Removed. `storage` added for layout preferences only. | `ui-redesign`: manifest permissions |
| Enable page hooks also switched on research recording. | Hooks enable locally and are refused in private windows. | `ui-redesign`, `public-release` |
| A parser error disabled the parser for the tab. | Command errors propagate to the action only. | `ui-redesign`: parser dispatch |
| HTML exports relied on escaping alone. | Plus `default-src 'none'` CSP, no-referrer, `rel="noopener noreferrer"` links. | `ui-redesign`, `security` |
| Layout preferences could be written from private windows. | Reads allowed, writes refused in private contexts; hidden-site entries limited to supported hosts. | `ui-redesign`: shared preferences |
| Favicon URLs near search results became "sources". | Image/icon fields and favicon-service URLs are skipped. | `export-efficiency` |

Carried forward from 1.6.7: authenticated requests validated against the current provider's HTTPS origin with redirects rejected; authentication bodies never captured (decoded-path match); reports and clipboard buffers in closed shadow roots; trusted clicks required; downloads accept generated content only; parser rejects inherited command names; recordings memory-only, tab-scoped, cleared on navigation/close, disabled in private windows.

## Reproduce

```text
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run lint:amo
bun audit --json
python scripts/build-xpi.py dist/reviewed-local.xpi
```

September 24 results: 125 public tests pass; 8 private replays pass; lint 0 errors and 1 Android warning. `bun audit` was last run for 1.6.7 (no advisories); dependency pins are unchanged.

## Limits

Live Firefox checks are listed in [VERIFICATION.md](VERIFICATION.md); the final palette design has not been viewed in a browser. Closed shadow roots stop ordinary DOM queries, not every possible host-page interference; Mozilla's best-practice advice to use iframes for injected UI is not followed, by design. Diagnostic reports can contain private data; excluding authentication bodies is not a claim to redact every secret. Full-history exports have no size cap and can use substantial memory on very large conversations. No review, test suite, or lint result substitutes for Mozilla's review. Report vulnerabilities per [SECURITY.md](../SECURITY.md).
