# Publish Chat Toolkit on Mozilla Add-ons

The build produces an unsigned XPI for submission. No upload, agreement acceptance, AMO public listing, or signing is implied by the source repository or local validator results.

## Publisher information

| Field | Value |
| --- | --- |
| Name | Chat Toolkit |
| Author | Zack Fitch |
| Support email | zack@definitelynot.ai |
| Source/support issues | https://github.com/johnzfitch/chat-toolkit |
| License | MIT; copyright 2026 Zack Fitch |
| Extension ID | chat-toolkit@definitelynot.ai |
| Version | 1.6.7 |
| Compatibility | Firefox desktop 140+; Android not declared |

The author confirmed ownership of the project and icons. If an AMO listing already uses this extension ID, upload the version through its owning account. Dedicated reviewer account access for sign-in and advertised paid features belongs in AMO's private reviewer fields. It is not included in the repository. Do not upload live owner cookies, tokens, or HARs.

## Upload

1. Sign in to the [Mozilla Add-ons Developer Hub](https://addons.mozilla.org/developers/) with the publishing account and complete its account and agreement requirements.
2. Choose **Submit a New Add-on**, or upload a version to the existing listing. Choose **On this site** for a public AMO listing.
3. Upload `dist/chat-toolkit-1.6.7-amo.xpi`, containing runtime files and the MIT license.
4. If source is requested, upload `dist/chat-toolkit-1.6.7-review-source.zip`. It contains readable source, build scripts, synthetic public tests, and documentation. There is no transpilation or minification. Never ZIP the entire private working directory for submission.
5. Read the validator's output. The known Android minimum-version warning is explained in `REVIEWER-NOTES.md`; retain desktop compatibility unless Android has actually been tested.
6. Use `LISTING.md`, `PRIVACY.md`, and `REVIEWER-NOTES.md` for the public listing, privacy policy, and private reviewer instructions. Select MIT and supply the support email. Use `extension-src/icons/icon128.png` when asked for an icon. Capture real screenshots from harmless conversations in a running Firefox instance; no product screenshots are fabricated here.
7. Supply dedicated reviewer test-account access in the private reviewer fields, then submit and follow Mozilla's review messages. Retrieve the signed package when Mozilla makes it available.

## Build

From the project root, with Bun and Python installed:

```text
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run lint:amo
python scripts/build-xpi.py dist/chat-toolkit-1.6.7-amo.xpi
python scripts/build-review-source.py dist/chat-toolkit-1.6.7-review-source.zip
```

Use new filenames if the archives already exist. The scripts refuse to overwrite outputs. For `web-ext` on a restricted workstation, setting `NO_UPDATE_NOTIFIER=1` prevents an unrelated developer-tool update-cache write.

The optional local command `bun run test:private` requires the owner's private replay suite and HAR fixtures. It is not part of the public checkout or CI. The public suite runs independently.

Official reference: [Submitting an add-on](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/). Mozilla's current form and review requests govern submission. Local tests and lint do not establish Mozilla approval or live provider compatibility.
