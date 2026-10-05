# Attachment Cloud Cache

Upload your note attachments to **your own** S3-compatible storage and keep a local copy in a
cache folder — so images still render when you are offline.

> **Status: early development (0.1.0).** The project is being built feature by feature under TDD;
> see [Scope & roadmap](./docs/SCOPE.md) for what is done and what is planned.

## Why another attachments plugin?

The two halves of this problem are usually solved by two different plugins, and each one leaves a
gap that is structural rather than a missing feature:

- **Upload plugins** rewrite your note to point at remote URLs — and typically delete or stop
  referencing the local file. Publishable and sync-friendly, but **images break offline**.
- **"Localize" plugins** download remote images back into the vault — which means you must be
  **online at least once** before offline can work at all.

This plugin does both, in that order: it uploads, then keeps the local file as a **cache** rather
than discarding it. The note keeps pointing at your storage (portable, shareable, small vault),
while rendering uses the local copy (works with no network, and in the offline case it makes
**zero** remote requests — the copy was already there).

The two halves are coupled by design, not bundled for convenience: if another plugin uploaded the
file first, it would already have removed the local copy, and there would be nothing left to cache.

## Features

- **S3-compatible storage**: Cloudflare R2, AWS S3, MinIO, Backblaze B2, and any S3-compatible endpoint
- **Content-addressed by default** (`{hash}.{ext}`), so the same image is stored once
- **Instant upload on paste and drag-and-drop**
- **Offline rendering from a local cache** — the cache mirrors your bucket layout and can be
  deleted at any time (it is rebuilt on demand)
- **Never loses an image**: if an upload fails, the file is written into your attachment folder and
  a working local link is inserted, with the reason shown
- **Desktop and mobile**
- **Credentials in secret storage** — access keys are never written to `data.json`

### Implementation notes worth knowing

- **No AWS SDK.** The SigV4 signer is written from scratch (about 200 lines) and verified against
  published AWS test vectors, so the plugin has no heavyweight dependency and no bundled SDK.
  Raising a mis-signed request is the kind of bug that is expensive to find, so the signer is
  pinned by vectors that AWS itself published: a wrong byte anywhere makes the signature differ.
- **Retries only when retrying can help.** Whether to retry is a whitelist: network failures and
  5xx/429/408, with capped exponential backoff. A 4xx is never retried — a rejected request will be
  rejected again, and retrying a credential error just turns "fix your settings" into "hangs for a
  few seconds, then fails the same way".
- **Errors never contain your secret key.** Error text is redacted unconditionally rather than
  trusting that a server echoes nothing back.
- **No Node built-ins.** Only APIs available on both desktop and mobile are used, because on mobile
  the Node modules simply are not there. This is enforced by lint, not just by convention.

## Verified scope (read this before trusting it)

Being precise about what has actually been exercised matters more than a long feature list:

| Area | How it is verified |
|---|---|
| Signing, key/path derivation, settings merging | Exhaustive unit tests, plus mutation checks that each rule fails for its own reason |
| SigV4 correctness | Three published AWS vectors (including an S3 example with query ordering and `$`-encoding) |
| Upload/download/HEAD/DELETE, retries, offline-path request counts | A real local HTTP server that **independently recomputes** the signature — not the plugin's own code |
| Hashing | Cross-checked byte-for-byte against `node:crypto` over padding and key-length boundaries |

**Not yet verified:** no real S3 provider (R2/MinIO/AWS) has been exercised end-to-end yet, and
**iOS has not been tested at all** — it cannot be tested on this machine. The code avoids APIs
known to be missing there and falls back when optional APIs are absent, but that is reasoning, not
evidence. Android and desktop real-device verification is still pending too.

## Installation

The plugin is not in the Community directory yet (it is under development). Manual installation:

1. Build or download `main.js`, `manifest.json`, and `styles.css`
2. Copy them to `<vault>/.obsidian/plugins/attachment-cloud-cache/`
   ⚠️ The folder name must match the plugin id exactly — `attachment-cloud-cache`
3. Enable it in Obsidian → Settings → Community Plugins → Installed plugins

## Setup

1. Open **Settings → Attachment Cloud Cache**
2. Fill in **Endpoint**, **Bucket**, **Region**, and **Public URL base**
3. Pick your **Access key / Secret key** through secret storage (not plain text settings)
4. Click **Test connection**

## Disclosures

- **Network use**: this plugin sends the attachments you choose to upload to the S3-compatible
  endpoint **you** configure. It talks to no other service, and includes no telemetry.
- **Files outside the vault**: not accessed. Everything the plugin reads or writes lives inside
  your vault.
- Credentials are stored in Obsidian's secret storage (the OS keychain), not in `data.json`.

## Permissions & licensing

- Licensed under the **MIT** license — see [LICENSE](./LICENSE).
- This is an **independent implementation**, written from scratch. It is not a fork of, and shares
  no code with, any other plugin. The feature comparison in
  [docs/SCOPE.md](./docs/SCOPE.md) is based on publicly documented behaviour of other plugins.

## Development

```bash
npm install
npm run dev          # watch build
npm run check        # type-check + build + lint + manifest validation + all tests
npm run test:unit    # tests only
npm run mutate       # mutation-check that every rule's assertions actually have teeth
```

Tests run on Node with no test framework — a real HTTP server and the real filesystem are used
rather than mocks where it matters, and the Obsidian host is replaced by a harness that can also
simulate mobile's restricted filesystem access (`scripts/lib/mock-obsidian.mjs`).

### What "mutation-check that the assertions have teeth" means here

Having tests is not the same as having tests that can fail. `npm run mutate` deliberately breaks
each rule in the source, reloads it, and requires that the suite goes red **for that rule's own
reason** — not merely that it goes red. If a rule can be disabled without any test noticing, the
run fails and reports the rule.

This is not ceremony. It has already paid for itself several times in this project, catching
assertions that were unreachable behind an earlier check, a backoff cap that no test could reach,
and — most usefully — a real double-encoding bug where an already-encoded path got encoded again,
producing uploads that succeeded but links that would not open.

The same loader lives in `scripts/lib/`, and each suite is shared between the test file and the
mutation script (`scripts/lib/*-suite.mjs`) so the two can never drift apart.
