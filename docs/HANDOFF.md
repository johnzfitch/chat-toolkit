# Handoff — 2026-09-24

State of Chat Toolkit at version 1.7.0 and what is open. Everything below is also reflected in the code and the other docs.

## Where things are

- Runtime: `extension-src/` (MV2, Firefox desktop 140+). Start with `lib/content.js` (commands), `lib/ui-model.js` (command definitions, accents, icons, styles), `lib/parser-worker.js` (all export rendering).
- Tests: `bun run test` (public, 127); `bun run test:private` needs the owner's HARs and `tests/private/` (ignored).
- Build: `python scripts/build-xpi.py dist/<name>.xpi`, `python scripts/build-review-source.py dist/<name>.zip`. Icons: `python scripts/build-icons.py`.
- Submission: `amo/SUBMIT.md`, `amo/LISTING.md`, `amo/PRIVACY.md`, `amo/REVIEWER-NOTES.md`.
- Evidence and rationale: `docs/VERIFICATION.md`, `docs/POLICY_COMPLIANCE.md`, `docs/PERMISSIONS.md`, `docs/DATA_FLOW_AUDIT.md`, `docs/COMMAND_INVENTORY.md`, `docs/EXPORT_FORMAT.md`, `docs/security-review.md`.

## Open items

1. **Visual check of the palette and popup.** The 224 px matte design (pressed-key selectors, per-platform accent, drawn icons) passed DOM tests but has not been viewed in Firefox.
2. **Data-collection declaration.** Keep `authenticationInfo` + `websiteContent` or switch to `"none"`; trade-offs in `docs/POLICY_COMPLIANCE.md`.
3. **Listing screenshots.** None captured. `scripts/capture-listing-screenshots.py --firefox <path>` renders six 1280×800 images from the synthetic harness; real screenshots from a test account are an alternative.
4. **Reviewer accounts.** AMO requires test credentials for account-gated features, supplied privately.
5. **AMO submission and signing.** Not done; no agreements accepted.
6. **Claude's new RPC.** claude.ai now loads chats via `…/ConversationService/StreamTimeline` (Connect/protobuf). The JSON API still works; watch for its removal.
7. **Live Claude and OpenRouter tests** after the latest changes.

## Decisions made in this release

- One export level: complete content, repetition removed (no Full/Compact switch).
- Drag export, status footer, theme and density options removed; outcomes confirm on the pressed button.
- Parser runs in the content script; the Worker path and web-accessible script were removed after Firefox testing showed the Worker never started.
- Background is persistent; webRequest listeners attach only during diagnostics.
- Private windows: exports allowed if the user permits; no storage writes or diagnostics.
