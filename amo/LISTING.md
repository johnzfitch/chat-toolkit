# Proposed Mozilla Add-ons listing

Publisher: Zack Fitch. Support: zack@definitelynot.ai. License: MIT, copyright 2026 Zack Fitch. Repository: https://github.com/johnzfitch/chat-toolkit. These are submission fields; the public description begins below.

**Name:** Chat Toolkit

**Summary** (under 250 characters): Copy or save AI conversations as Markdown, JSON, or HTML, with the reasoning, citations, and tool results the provider supplies. Choose all messages or only yours or the assistant's.

**Suggested categories:** Other; Web Development. Confirm against the categories the form offers.

**Platform:** Firefox desktop 140 and later. Android has not been tested or declared.

**Icons:** `store/icons/chat-toolkit-32.png` and `store/icons/chat-toolkit-64.png` (AMO asks for 32×32 and 64×64); 128/256/512 are also in `store/icons/`.

## Public description

Save the conversation you have open in a format you can keep, search, share, or give to another model.

Chat Toolkit adds a small palette to Claude, ChatGPT, Grok at grok.com, Gemini, Google AI Studio, and OpenRouter. The toolbar button offers the same controls.

- **Copy** or **Save file** as Markdown, JSON, or HTML.
- Export **all messages**, only **yours**, or only the **assistant's**.
- Keeps supplied reasoning, citations, search queries, tool calls and results, created files, and attachment metadata.
- Complete exports without repetition: identical tool output and already-linked sources are not repeated, so files stay compact as context for another model.
- Optional **Advanced tools** for inspecting a conversation's provider data, the page, and differences between them.

Sign in to your chat provider and open a saved conversation first. Available history varies by provider; when an export comes from the loaded page instead of the provider, Chat Toolkit says so. It cannot recover messages or reasoning the service does not provide.

**How your data is handled**

Chat Toolkit processes conversations in your browser and saves them to your downloads folder or clipboard. It has no developer server, analytics, or automatic uploads. When you export, it requests the conversation from the same chat site you are on, using your existing sign-in. It stores only the palette's layout and your export choices.

**Optional diagnostics**

Advanced tools can produce reports containing private conversation and account data; they stay in your browser unless you save or share them. Network inspection and capture record only while running, and a small light shows while they are active. ChatGPT research recording starts off and is scoped to its tab. Account capture additionally retrieves settings, memory, and project resources on Claude and ChatGPT. Page hooks are a separate opt-in removed by reloading.

The extension itself is free. Chat providers may require accounts or subscriptions. Chat Toolkit is an independent utility, unaffiliated with the listed providers.

## Release notes for 1.7.0

- Smaller, clearer palette: Copy and Save first, then message and file-type choices, with Advanced tools tucked below. Colours follow the chat site.
- Complete exports with repetition removed; compact JSON layout.
- Claude JSON now includes tool activity and created files. Gemini exports fixed and product links resolved.
- Emoji and code-block blank lines preserved; favicon links no longer listed as sources.
- Fewer permissions; network listeners only run during diagnostics.

## Screenshots

Not yet captured. Use 1280×800 images of harmless or synthetic conversations. Either capture from a test account, or run `python scripts/capture-listing-screenshots.py --firefox <path>` to render the real palette and popup over the synthetic page in `assets/design/listing-harness/` (it imitates no provider). Exclude profile details, sidebars, and personal content.
