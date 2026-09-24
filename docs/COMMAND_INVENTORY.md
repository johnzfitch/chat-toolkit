# Command inventory — Chat Toolkit 1.7.0

Every user-visible command, the code that runs it, and the data it touches. Commands are defined once in `extension-src/lib/ui-model.js` and dispatched by `handleAction` in `extension-src/lib/content.js`. Page-palette buttons require a trusted click (`event.isTrusted`); popup commands arrive as extension messages. Every data action runs only on the page's own provider.

## Primary actions

| Label | Action id | Handler | Inputs | Output / side effect | Requests | Permissions |
| --- | --- | --- | --- | --- | --- | --- |
| Copy Markdown / Copy JSON / Copy HTML | `copy` | `copyChat` → `buildExport` | Scope and file type selectors | Clipboard. Markdown copies also carry rendered HTML for rich paste. | Conversation fetch on the current provider (see DATA_FLOW_AUDIT) | `clipboardWrite`, host |
| Save file | `save` | `saveChat` → `buildExport` → background `download` | Scope and file type | File in the downloads folder: `<platform>_<title>_<date>[_<role>_turns].<md|json|html>` | Same | `downloads`, host |
| All · User · Assistant | selector (`prefs.scope`) | `ui-panel.js` / `popup.js` | — | Chooses messages for Copy/Save. Stored layout preference. | none | `storage` |
| .md · .json · .html | selector (`prefs.format`) | same | — | Chooses the file type; relabels Copy. Stored. | none | `storage` |

Earlier direct actions `export-json`, `export-md`, `export-html`, `export-user-turns`, `export-assistant-turns` remain accepted by the dispatcher and map to `save`. Drag export was removed in 1.7.0.

## Advanced tools

| Label | Action id | Handler | Output | Requests | Notes |
| --- | --- | --- | --- | --- | --- |
| API inspector | `run-explorer` | `runExplorer` | Report window (copy/save as JSON) with provider schema paths and counts | Conversation fetch; on ChatGPT also a lean session bundle (custom GPT metadata when present) | — |
| Page inspector | `run-dom` | `runDOM` | Report of provider selectors matched on the page | none | Reads the page only |
| Compare API and page | `run-diff` | `runDiff` | Report of text only in the provider data or only on the page | Conversation fetch | — |
| Network inspector | `run-sniffer` | `runSniffer` | First click starts metadata-only recording of this tab's provider requests; second click opens the report and stops | none generated | No response bodies; background listeners attach only while running |
| Diagnostic capture | `export-capture` | `exportCapture(false)` | `.capture.json`: conversation, page summary, bounded network capture of the export's own requests | Conversation fetch | Ends a running Network inspector session |
| Account capture (Claude, ChatGPT) | `export-account-capture` | `exportCapture(true)` | As above plus account/session resources | Claude: organization, settings, memory, projects, skills, code sessions, etc. ChatGPT: custom GPT metadata | Separate explicit action |
| Record research (ChatGPT) | `diagnostics-start` | `changeRecording('start')` | Starts memory-only recording of deep-research traffic in this tab | none | Title-bar light while on |
| Stop recording | `diagnostics-stop` | `changeRecording('stop')` | Stops new recording; keeps recorded data | none | — |
| Clear recording | `diagnostics-clear` | `changeRecording('clear')` | Deletes this tab's recording and legacy disk caches | none | — |
| Fetch research state (ChatGPT) | `fetch-research-state` | `fetchResearchState` | Requests up to two missing research sessions found by the recording | `POST /backend-api/ecosystem/call_mcp` | Requires recording on |
| Enable page hooks | `enable-page-hooks` | `CT.enablePageHooks` | Instruments page fetch/XHR/WebSocket/EventSource during captures | none | Refused in private windows; reload removes |

## Palette chrome and popup

| Control | Effect |
| --- | --- |
| Grip (drag or arrow keys) | Moves the palette; stores `dock: free` and position |
| Menu → Dock left / Dock right / Reset position | Non-drag positioning |
| Menu → Hide on this site | Adds the hostname to `hiddenSites` (not written from private windows) |
| Menu → Help & privacy | Opens the packaged `help/privacy.html` |
| Minus / launcher | Collapse to a small button and restore |
| Popup menu → Show/Hide panel on this site | Edits `hiddenSites` |
| Popup Advanced tools | Diagnostic capture, Compare API and page (all others are in the page palette) |

## Outcome reporting

`handleAction` returns `{ ok, kind, title, detail }` to the popup and announces it on the page. Copy and Save confirm on their own button for about 1.6 s with details in the tooltip and a screen-reader live region. Warnings (for example a loaded-page fallback) and errors use a notification. Reports open their own window and are not repeated.
