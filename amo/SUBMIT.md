# Publish Chat Toolkit on Mozilla Add-ons

The build produces an unsigned XPI for submission. No upload, agreement acceptance, listing, or signing has been done.

## Publisher information

| Field | Value |
| --- | --- |
| Name | Chat Toolkit |
| Author | Zack Fitch |
| Support email | zack@definitelynot.ai |
| Source/support issues | https://github.com/johnzfitch/chat-toolkit |
| License | MIT; copyright 2026 Zack Fitch |
| Extension ID | chat-toolkit@definitelynot.ai |
| Version | 1.7.0 |
| Compatibility | Firefox desktop 140+; Android not declared |

## Before submitting

- Decide the data-collection declaration (`docs/POLICY_COMPLIANCE.md`).
- Capture 1280×800 screenshots (`amo/LISTING.md`).
- Prepare dedicated provider test accounts for the private reviewer field. Never upload owner cookies, tokens, or HARs.

## Build

```text
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run lint:amo
python scripts/build-xpi.py dist/chat-toolkit-1.7.0-amo.xpi
python scripts/build-review-source.py dist/chat-toolkit-1.7.0-review-source.zip
```

The scripts refuse to overwrite outputs. On a restricted workstation set `NO_UPDATE_NOTIFIER=1` for web-ext.

## Upload

1. Sign in to the [Add-ons Developer Hub](https://addons.mozilla.org/developers/) with the publishing account.
2. **Submit a New Add-on**, choose **On this site**, and upload `dist/chat-toolkit-1.7.0-amo.xpi`.
3. Source code is not required (nothing is generated or minified). If requested, upload `dist/chat-toolkit-1.7.0-review-source.zip`.
4. Review the validator output; the Android warning is explained in `REVIEWER-NOTES.md`.
5. Use `LISTING.md` for the listing, `PRIVACY.md` for the privacy policy, and `REVIEWER-NOTES.md` plus test credentials for reviewer notes. Icons: `store/icons/chat-toolkit-32.png` and `-64.png`.
6. Submit and follow Mozilla's review messages; download the signed package when available.

Official reference: [Submitting an add-on](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/). Local tests and lint do not establish Mozilla approval or live provider compatibility.
