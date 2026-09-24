# Third-party notices

## Shipped in the extension

Nothing. The XPI contains only this project's own JavaScript, HTML, PNG icons, and the MIT `LICENSE`. There are no runtime libraries, fonts, or remote resources.

Icons and interface glyphs (the identity mark, toolbar icons, and the 16 px icons drawn in `extension-src/lib/ui-model.js`) were drawn for this project and are covered by the project's MIT license, copyright 2026 Zack Fitch. The icon master is `assets/design/chat-toolkit-mark.svg`.

## Development only (not shipped)

| Tool | Version | License | Source |
| --- | --- | --- | --- |
| web-ext | 10.7.0 | MPL-2.0 | https://github.com/mozilla/web-ext |
| Happy DOM | 20.14.5 | MIT | https://github.com/capricorn86/happy-dom |
| Bun | 1.3.14 | MIT | https://bun.sh |
| Pillow (icon build) | 12.x | MIT-CMU (HPND) | https://python-pillow.org |
| resvg-py (icon build) | 0.5.0 | MIT | https://github.com/baseplate-admin/resvg-py |
| Selenium (screenshot capture) | 4.x | Apache-2.0 | https://www.selenium.dev |

Exact JavaScript dependency versions are pinned in `bun.lock`. Provider names (Claude, ChatGPT, Grok, Gemini, Google AI Studio, OpenRouter) are trademarks of their owners and are used only to identify supported sites.
