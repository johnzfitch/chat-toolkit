# Chat Toolkit privacy policy

Effective September 23, 2026, for version 1.6.7. Published by Zack Fitch; contact zack@definitelynot.ai.

Chat Toolkit exports conversations and provides optional diagnostics for supported chat websites. It has no developer-operated collection server, analytics, advertising, or automatic report uploads.

## Conversation exports

The extension reads conversation content and available metadata from the current provider's API, loaded page, or browser storage. It processes that data in your browser. Depending on the provider, this includes messages, supplied reasoning, citations, search queries, tool results, and attachment metadata. Generated files go to your downloads folder. Copy writes content to the clipboard. Dragging an exported file shares it with the destination you choose.

## Requests to chat providers

When you request an export or API diagnostic, the extension may send HTTPS requests to the current provider using your existing signed-in browser session. These requests include session cookies or access tokens, conversation and message identifiers, organization or project identifiers, and request metadata required to retrieve the selected data. The extension does not ask you to enter your password or create a separate extension account. No chat export is sent to the extension's developer.

The supported provider sites are claude.ai, chatgpt.com, chat.openai.com, grok.com, gemini.google.com, aistudio.google.com, and openrouter.ai. Optional Claude network diagnostics also cover api.anthropic.com requests from the selected tab. Each provider's own privacy policy governs its services.

The Firefox installation prompt declares authentication information and website content for authenticated provider requests and their cookies, identifiers, and request metadata. This does not mean the developer operates a collection service.

## Optional diagnostic tools

API, DOM, and Diff inspect the selected conversation's API data, visible page, and differences. Network records a short window of request metadata. Capture combines conversation data, page details, and bounded network information while the export runs.

ChatGPT research recording is off by default. Record enables it in the current tab, Stop prevents new recording, and Clear removes recorded data. Fetch ChatGPT research state makes authenticated requests for research sessions discovered in that tab only when you choose that action.

Export account capture is separate from normal exports and Capture. On Claude it may retrieve organization information, settings, memory, project files and documents, configured tools, and code-session metadata. On ChatGPT it retrieves a limited set of conversation and custom GPT metadata. Account data is processed locally and included in the requested capture file.

Page hooks are a separate opt-in that instruments the current page's requests during explicit captures. Reloading the page removes these hooks. Diagnostic reports may appear in the chat page's report panel and its developer console. Review reports before sharing them; they can contain private content, identifiers, URLs, request bodies, or tool results.

## Retention and controls

New background recordings are held in bounded memory buffers, not extension disk storage. Navigating, reloading, or closing the tab clears its background recording. Firefox unloading the extension background page or restarting the browser also discards it. Old in-memory research stores are pruned after inactivity. Recordings are not restored into another tab or Firefox container.

Clear also removes diagnostic disk caches left by earlier local versions. These older caches are never read by 1.6.7. Background recording and page hooks are disabled in private windows.

Saved files and clipboard contents remain until you delete or replace them. Clearing diagnostics or uninstalling the extension does not delete files you explicitly exported. The destination's own rules apply to files you share.

For support or privacy questions, contact [Zack Fitch](mailto:zack@definitelynot.ai). When you choose to send a report or email, its contents are shared with the recipient you choose; the extension does not send it automatically.
