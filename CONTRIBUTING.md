# Contributing to Chat Toolkit

Bug reports, provider compatibility fixes, documentation, and tests are welcome. For a security issue, use [SECURITY.md](SECURITY.md) instead of a public issue.

## Work locally

Use Bun 1.3.14 and Python 3.10+. Run `bun install --frozen-lockfile --ignore-scripts`, then `bun run test`. Temporarily load `extension-src/manifest.json` in Firefox desktop 140+ using `about:debugging`, and reload the supported chat page after code changes. Use an account and conversation you are comfortable testing with.

Keep runtime code readable and local. The extension has no bundler or third-party runtime dependencies. Provider requests must remain on the current provider's HTTPS origin. Diagnostics stay explicit, bounded, and scoped to the initiating tab. Treat all provider content as untrusted text when rendering HTML. Preserve full available conversation history; diagnostic preview limits must not truncate ordinary exports.

Add a focused regression when fixing a meaningful behavioral defect. Put public tests in `tests/public/` and use synthetic fixtures. State which provider behavior was actually tested, whether a test was a replay or a live browser action, and any remaining limitations. Run `bun run test`, `bun run lint:amo`, and build a fresh XPI with `python scripts/build-xpi.py dist/local-change.xpi`.

## Private data

Never commit HARs, cookies, access tokens, private messages, exported chats, or provider account credentials. Do not paste them into issues or pull requests. A sanitized minimal schema or synthetic conversation is usually enough to reproduce a parser problem. `.gitignore` excludes HARs, local output, archives, caches, and the optional `tests/private/` suite, but inspect your staged files as well.

If a real capture is needed for your own diagnosis, keep it local and derive a synthetic public regression from the relevant structure. Do not present synthetic fixtures as live provider evidence. Contributors do not need the owner's private capture files to run the public suite.

## Pull requests

Explain the concrete problem and resulting behavior. Include the commands you ran and what they showed. Keep unrelated formatting changes out of behavioral fixes. Changes to permissions or data flows should update the manifest, packaged Help & privacy page, and `amo/` documentation together.

Contributions are distributed under this project's MIT license. Preserve copyright and license notices for any separately licensed code you introduce and describe its origin.
