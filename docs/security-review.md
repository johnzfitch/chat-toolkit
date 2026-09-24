# Source review — version 1.6.7

This review covers all runtime JavaScript, the manifest, popup, and packaged help page in `extension-src/`. It examines request destinations and credentials, optional recording and retention, page interaction, download handling, parser dispatch, and export rendering against [Mozilla's add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/) and [data-consent documentation](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/), consulted September 23, 2026.

## Changes and executable evidence

| Finding | Implemented behavior | Public tests |
| --- | --- | --- |
| Authenticated helpers relied on callers to choose the right destination. | Validate the current provider's HTTPS origin before reading credentials; reject embedded URL credentials and redirects; encode provider path identifiers. | `security.test.js`: authenticated provider requests and token retry. |
| Capture classification matched full URL strings, so authentication query strings could resemble conversation or research endpoints. | Match decoded paths, exclude authentication body capture, and compare MCP/event paths directly. | `public-release.test.js`: authentication exclusion with Record off/on. |
| Reports and copy buffers used ordinary page DOM nodes. | Use closed shadow roots with references retained by the content script; require trusted events for data actions and bind action names in closures. | `security.test.js`: report privacy, copy buffer removal, and synthetic clicks; `public-release.test.js`: literal notification text. |
| The background download helper accepted an arbitrary URL. | Accept generated content only; reject URL-based downloads. | `public-release.test.js`: remote download rejection. |
| Opt-in page hooks used page-owned properties for XHR/stream metadata, changed listener identity, and could clone fetch responses too late. | Keep metadata in WeakMaps, preserve original page listeners, bound diagnostic text and entries, and clone before returning the response to its consumer. | `security.test.js`: XHR/stream state, listener removal, Clear, body limits, and unchanged page response. |
| Parser dispatch could look up inherited object properties. | Accept only own command handlers. Existing HTML rendering escapes provider text and limits links to HTTP(S). | `security.test.js`: inherited command rejection and hostile HTML/source links. |

Earlier 1.6.6 changes made research recording explicit, tab-scoped, and memory-only; disabled private-window capture; stopped restoring legacy disk caches; and separated account capture from ordinary exports. `public-release.test.js` exercises these behaviors. Provider regressions also cover Grok branches and 65-message batching, Claude events, Gemini selected responses, and OpenRouter local records.

The extension contains readable local JavaScript, no remote executable code, no dynamic code evaluation, no third-party runtime dependencies, and no developer data-collection endpoint. It does not modify CSP or security response headers. Development tests use JavaScript evaluation to load the source in test contexts; that test machinery is not included in the XPI.

## Reproduce

```text
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run lint:amo
bun audit --json
python scripts/build-xpi.py dist/reviewed-local.xpi
```

The September 23 local run of `bun run test` reported 71 tests, zero failures, and 273 assertions. `bun run test:private` separately reported eight tests, zero failures, and 150 assertions. `bun run lint:amo` reported zero errors and the one warning described below. `bun audit --json` returned `{}` with exit status 0. CI records public test, lint, and package output on each run.

Tests use synthetic fixtures and VM/DOM harnesses. The private tests replay locally supplied captures; no private capture or conversation is part of this repository. A dependency audit queries the package advisory database for the pinned development tools; it does not review the extension's own code or prove the absence of vulnerabilities.

The Android data-consent minimum-version warning is retained and explained in [reviewer notes](../amo/REVIEWER-NOTES.md). Firefox's required data declarations cover authenticated provider requests; they do not imply a developer collection service.

## Limits

Live authenticated Firefox execution was unavailable in the preparation environment. Bun's Worker/VM and Happy DOM tests do not establish Firefox Xray behavior, actual browser user activation, cross-container behavior in a running browser, or current provider-account compatibility. Closed shadow roots prevent ordinary DOM queries from reading their contents; they are not a general guarantee against all host-page attacks. Optional page hooks can affect provider behavior and remain separately enabled diagnostics.

Diagnostic reports and files may contain private conversation/account data and URLs. Excluding authentication response bodies is not a claim to redact every possible secret. Full-history exports intentionally have no message-text budget and may use substantial memory for very large conversations. DOM fallback fidelity depends on what the page loaded.

No source review, test suite, dependency audit, or local Mozilla validator result substitutes for Mozilla's review, signing, or required reviewer account access. See [SECURITY.md](../SECURITY.md) to report a vulnerability privately.
