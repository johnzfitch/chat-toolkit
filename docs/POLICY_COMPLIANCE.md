# Mozilla add-on policy mapping — Chat Toolkit 1.7.0

Mozilla's current documentation, read 2026-09-24, mapped to this extension. Quotes are verbatim from the linked pages. Status is our reading of the code; Mozilla's reviewers decide the outcome.

Sources: [Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/) (updated Apr 30, 2026) · [Policies FAQ](https://extensionworkshop.com/documentation/publish/add-on-policies-faq/) · [Built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/) (Mar 12, 2026) · [Submitting an add-on](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/) (May 10, 2026) · [Security best practices](https://extensionworkshop.com/documentation/develop/build-a-secure-extension/) · [Appealing listing](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/) · [MDN browser_specific_settings](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings) · [MDN browser_action](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_action).

| Requirement | What the source says | Chat Toolkit | Status |
| --- | --- | --- | --- |
| Data declaration for new extensions | "From November 3, 2025, all new extensions must adopt the Firefox built-in data collection consent system" | `data_collection_permissions.required: ["authenticationInfo", "websiteContent"]`, `strict_min_version: 140.0` | Declared — **classification open**, see below |
| Consent minimum version | Built-in consent in "Firefox for desktop 140 and later, and Firefox for Android 142 and later" | Desktop 140+; Android not declared | Met (lint warns about Android 142; Android not claimed) |
| Transmission definition | "data transmission refers to any data that is collected, used, transferred, shared, or handled outside of the add-on or the local browser" | Only same-provider requests with the user's session; nothing to the developer or third parties | See open question |
| Local exports | "Add-ons may provide user-initiated local backup features without requiring explicit user consent" (FAQ) | Copy and Save are user-initiated and local | Met |
| Minimal permissions | "Add-ons must only request those permissions that are necessary for them to function" | Seven provider hosts, `clipboardWrite`, `downloads`, `storage`, `webRequest(Blocking)`; `activeTab`, `api.anthropic.com`, and the web-accessible script removed | Met — [PERMISSIONS.md](PERMISSIONS.md) |
| Unexpected features are opt-in | Features affecting privacy "must be 'opt-in', meaning the user has to take non-default action" | Diagnostics, account capture, research recording, and page hooks each need an explicit command; network listeners exist only while one runs | Met |
| Private browsing | "Data from private browsing sessions must not be stored." | No conversation storage anywhere; preference writes, diagnostics, and hooks refused in private windows | Met |
| Self-contained code, no obfuscation | "Add-ons must be self-contained and not load remote code for execution"; no obfuscated code | Readable local JavaScript, no eval, no remote scripts, no `innerHTML` with variable markup | Met |
| Security headers | "Add-ons must not relax web page security headers, such as the Content Security Policy." | Not modified | Met |
| Performance | "must not negatively impact the performance or stability of Firefox" | Blocking webRequest listener removed except during diagnostics | Improved in 1.7.0 |
| Injected UI | Best practice: "Don't add UI elements, such as buttons or toolbars, directly to web pages… use iframes" | Palette is in a closed shadow root, requires trusted clicks, and exposes no moz-extension URL | Deliberate deviation from a best-practice recommendation, disclosed here |
| moz-extension paths | "Don't inject moz-extension paths directly" | Icons are inline SVG; no extension URL reaches the page | Met |
| Privacy policy | "if any data is being transmitted from the user's device, a privacy policy … is required" (Submitting) | [amo/PRIVACY.md](../amo/PRIVACY.md) | Ready to paste |
| Source code | Needed for "transpiled, minified or otherwise machine-generated code" | None; review ZIP offered anyway | Not required |
| Reviewer access | "if an account is needed … testing credentials to allow use of the add-on" | Needs dedicated provider test accounts in the private reviewer field | **Owner action** |
| Listing | Summary "limited to 250 characters"; screenshots "1280x800px"; icons "32x32 and 64x64" | [amo/LISTING.md](../amo/LISTING.md); `store/icons/`; screenshots not yet captured | Screenshots **open** |
| Toolbar theme icons | "dark": shown "when a theme using dark text is active"; "light": "when a theme using light text is active" | `ink-dark` (dark keyline) and `ink-light` (light halo) at 16/32/64 | Met |
| Manifest version | Mozilla stated in 2024 that it "has no plans to deprecate MV2"; no later deprecation announced through Aug 2026 | MV2 | Acceptable |

## Open question: data-collection classification

Mozilla's pages do not say whether an extension that sends a site's own cookies/token and conversation ids back to that same site, and saves the reply locally, "collects" data. Two readings:

1. **Keep the current declaration** (`authenticationInfo`, `websiteContent`). Literal reading: `websiteContent` covers "cookies … page headers, and request and response information". Low review risk; Firefox's install prompt lists these as required data collection.
2. **Declare `"none"`.** Nothing leaves for a party that did not already hold it. Risk: an Add-ons team member disabled an add-on for an inaccurate `"none"` (Mozilla Discourse, Sept 2026) and advised declaring what is actually transmitted.

The owner has not decided; the manifest keeps option 1. If changing, explain the choice in AMO's reviewer notes; reviewers do not see forum posts.

## Other observations

- Claude's web app now loads conversations through a Connect/protobuf RPC (`/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline`). The extension still uses the JSON API, which worked in the Sept 24 owner tests. If Claude retires it, Claude exports fall back to the loaded page.
- Mozilla may attempt to rebuild submitted source (`build-for-amo` npm script, Firefox 153 blog). Not relevant while no build step exists.
