# Permissions — Chat Toolkit 1.7.0

Each manifest permission, the code that needs it, what the user sees, and what happens without it. Checked against `extension-src/manifest.json`.

| Permission | Needed by | Why | If unavailable |
| --- | --- | --- | --- |
| `https://claude.ai/*`, `https://chatgpt.com/*`, `https://chat.openai.com/*`, `https://grok.com/*`, `https://gemini.google.com/*`, `https://aistudio.google.com/*`, `https://openrouter.ai/*` | `content_scripts`, `api-fetchers.js`, `background.js` webRequest filter, popup `tabs.query` URL | Run the palette on supported chats, fetch the open conversation from the same provider with the user's session, observe that provider's requests during explicit diagnostics, and let the popup recognize the tab | Palette and exports do not run on that site; the popup says the tab is unsupported |
| `clipboardWrite` | `ui-panel.js` `copyToClipboard` | Clipboard writes happen after the conversation is fetched, when the click's user activation has expired | Copy falls back to `execCommand('copy')` and then reports failure |
| `downloads` | `background.js` `download` handler | Save generated files and reports to the downloads folder (`saveAs: false`); only locally generated content is accepted, never a URL | Save file reports an error |
| `storage` | `ui-model.js` `loadPrefs`/`savePrefs` | Remember palette position, dock, collapsed state, scope, file type, and sites where the palette is hidden. Never conversation content; never written from private windows | Preferences reset each page load |
| `webRequest`, `webRequestBlocking` | `background.js` | Network inspector and Diagnostic/Account capture metadata; `filterResponseData` for bounded response capture during explicit captures and ChatGPT research recording. Listeners are attached only while a capture or recording is active and removed when idle. Response bytes are forwarded unchanged | Network diagnostics report unavailable; exports are unaffected |

## Removed in 1.7.0

| Permission | Reason |
| --- | --- |
| `activeTab` | Unused: the popup only needs the tab URL on supported sites, which the host permissions already provide. `tabs.sendMessage` needs no permission. |
| `https://api.anthropic.com/*` | No code requests it, and the Claude HAR (Aug 2026) shows no traffic to it from claude.ai. |
| `web_accessible_resources: lib/parser-worker.js` | Existed for a parser Worker that Firefox never starts from a content script (confirmed in Nightly 158). Removing it stops exposing a script to every website. |

## Not requested

`tabs`, `cookies`, `<all_urls>`, `nativeMessaging`, `unlimitedStorage`, `clipboardRead`, and any optional permission. No `content_security_policy` change. `incognito` is left at Firefox's default (runs in private windows only if the user allows it); in private windows diagnostics, page hooks, and preference writes are disabled.

## Background page

`background.persistent` is `true`. Research recording and capture state live only in memory; with a non-persistent event page Firefox could discard that state while a recording is on. Memory use when idle is small because the webRequest listeners are detached.
