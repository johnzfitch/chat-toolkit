# Data-flow audit — Chat Toolkit 1.7.0

Where data is read, processed, stored, and sent, based on the runtime source in `extension-src/`. "Sent" means an outbound request; data received from a provider in reply is not an upload to another party.

## Destinations

The extension makes requests only to the provider of the tab it runs in, over HTTPS, with redirects rejected (`providerURL`/`providerFetch` in `api-fetchers.js`). There is no developer server, analytics, telemetry, crash reporting, remote code, native messaging, localhost bridge, or sync. No request is sent on page load.

| Trigger | Request (same origin as the page) | Sent | Received |
| --- | --- | --- | --- |
| Copy / Save, API inspector, Compare, Diagnostic capture — Claude | `GET /api/organizations/<org>/chat_conversations/<id>?tree=True&rendering_mode=messages&render_all_tools=true` (fallback `?tree=false&rendering_mode=raw`); Cowork: `GET /v1/code/sessions/<id>` and `/events` | Session cookies, organization and conversation ids, Claude client headers | Conversation |
| Same — ChatGPT | `GET /api/auth/session` (for the bearer token, kept in memory only), `GET /backend-api/conversation/<id>` | Cookies, bearer token, device id, conversation id | Conversation |
| Same — Grok | `GET /rest/app-chat/conversations_v2/<id>`, `GET …/conversations/<id>/response-node`, `POST …/load-responses` (response ids, 30 per batch) | Cookies, conversation and response ids | Conversation |
| Same — Gemini | `POST /_/BardChatUi/data/batchexecute?rpcids=hNvQHb` with the page's own `at`/`f.sid` tokens | Cookies, page tokens, conversation id | Conversation |
| Same — OpenRouter, AI Studio | none (OpenRouter reads the site's IndexedDB read-only; AI Studio reads the page) | — | — |
| Account capture — Claude | About 20 `GET` account/org endpoints (settings, memory, projects and files, skills, code sessions, environments, i18n) | Cookies, org/project ids | Account data, into the capture file only |
| Account capture — ChatGPT | `GET /backend-api/gizmos/<id>` when the chat uses a custom GPT | Cookies, token | GPT metadata |
| Fetch research state — ChatGPT (recording on) | `POST /backend-api/ecosystem/call_mcp` (`get_state`, up to 2 sessions) | Conversation, message, and session ids | Research state |

## Reads

- Page DOM of the supported chat (loaded-page fallback, Page inspector, Compare).
- The provider's own cookies via `document.cookie` for ids Claude/ChatGPT already expose there (org id, device id); Gemini tokens from the page.
- OpenRouter's IndexedDB (`openrouter:playground…`), read-only; probes never create a database.
- Diagnostic recording: request metadata, request bodies, and bounded responses for the tab's provider, only while a capture or ChatGPT research recording runs. Authentication paths (`auth`, `oauth`, `login`, `signin`, `token`) are never body-captured.
- Opt-in page hooks: the page's fetch/XHR/WebSocket/EventSource traffic during captures.

## Storage and retention

| Store | Contents | Lifetime |
| --- | --- | --- |
| `browser.storage.local` `uiPrefs` | Format, scope, dock, position, collapsed, hidden hostnames (supported providers only) | Until changed or the extension is removed. Never written from private windows. |
| Background memory | Research recordings and capture buffers (bounded counts and sizes) | Cleared on Clear, navigation, reload, tab close, or browser restart |
| Content-script memory | ChatGPT access token; page-hook buffers | Page lifetime |
| Legacy `localStorage` (`chatToolkitPassive:*`) from old local builds | — | Never read; deleted on Clear |
| Downloads folder, clipboard | Files and text the user chose to save or copy | User-controlled |

## Processing

Parsing and rendering run locally in the content script (`parser-worker.js`). Exports keep all supplied content and remove only repetition. HTML exports carry a restrictive CSP (`default-src 'none'`), escape all provider text, allow only `http(s)` links, and send no referrer.

## Diagnostics visibility

Diagnostics start only from explicit commands in Advanced tools; hiding a button is not what disables them — the background has no webRequest listener until a capture or recording starts. A red light in the palette title bar shows while any recording, the Network inspector, or page hooks are active. Reports stay in the page's closed report window until copied or saved; they are also logged to that tab's developer console.

## Private windows

Exports work if the user allows the extension in private windows. Diagnostics, page hooks, and preference writes are refused there.

## Mozilla data-collection declaration

The manifest declares required `authenticationInfo` and `websiteContent` for the authenticated same-provider requests above. Whether requests that return data from the same site the user is on count as "transmission" is not settled by Mozilla's documentation; see [POLICY_COMPLIANCE.md](POLICY_COMPLIANCE.md). No chat text is sent anywhere by the extension, so `personalCommunications` is not declared.
