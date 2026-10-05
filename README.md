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
node scripts/mutate-settings.mjs   # mutation-check that the settings tests actually fail
```

Tests run on Node with no test framework — a real HTTP server and the real filesystem are used
rather than mocks where it matters, and the Obsidian host is replaced by a harness that can also
simulate mobile's restricted filesystem access (`scripts/lib/mock-obsidian.mjs`).
