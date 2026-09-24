# Chat Toolkit privacy policy

Effective September 24, 2026, for version 1.7.0. Published by Zack Fitch; contact zack@definitelynot.ai.

Chat Toolkit exports conversations and provides optional diagnostics for supported chat websites. It has no developer-operated server, analytics, advertising, or automatic report uploads.

## Conversation exports

The extension reads the conversation you have open from the current provider's API, the loaded page, or the site's browser storage, and processes it in your browser. Depending on the provider this includes messages, supplied reasoning, citations, search queries, tool calls and results, created files, and attachment metadata. Save file writes to your downloads folder; Copy writes to your clipboard.

## Requests to chat providers

When you export or use an inspector, the extension may send HTTPS requests to the provider of the page you are on, using your existing signed-in session. Requests include that site's session cookies or access token, conversation and message identifiers, organization or project identifiers, and request metadata needed to retrieve the selected data. Requests never go to another site, and no export is sent to the developer.

Supported sites: claude.ai, chatgpt.com, chat.openai.com, grok.com, gemini.google.com, aistudio.google.com, and openrouter.ai. Each provider's privacy policy governs its services. Firefox's installation prompt lists **authentication information** and **website content** for these authenticated requests.

## What is stored

Only layout preferences: the palette's position and docking, whether it is collapsed, your message and file-type choices, and the supported sites where you hid the palette. No conversation content is stored. Nothing is written from private windows.

## Optional diagnostic tools

Under Advanced tools, API inspector, Page inspector, and Compare API and page inspect the current conversation's provider data, the visible page, and the differences. Network inspector records this tab's request metadata from when you start it until you stop it. Diagnostic capture saves the conversation with page details and bounded network data recorded during the capture. Account capture, a separate action, also retrieves organization details, settings, memory, projects and files, tools, and code sessions on Claude, or custom GPT metadata on ChatGPT.

ChatGPT research recording is off until you choose Record research, applies only to that tab, and is kept in memory; Stop recording stops it and Clear recording deletes it. Fetch research state requests research sessions the recording found, only when you choose it. Enable page hooks instruments the page's own requests during captures until you reload.

A small light in the palette's title bar shows while any recording, the Network inspector, or page hooks are active. Reports appear in a window on the page and in that tab's developer console; they can contain private content, identifiers, URLs, request bodies, or tool results. Review reports before sharing them.

## Retention and controls

Recordings live in memory and are discarded when you clear them, navigate, reload, or close the tab, or restart Firefox. They are never written to disk or restored into another tab or container. Clear also deletes diagnostic caches left by older local versions. In private windows, the Network inspector, Diagnostic and Account capture, research recording, and page hooks are refused; exports and inspector reports still work if you allow the extension there.

Files and clipboard contents you export remain until you delete or replace them. Removing the extension deletes its stored preferences but not files you saved.

For support or privacy questions, contact [Zack Fitch](mailto:zack@definitelynot.ai).
