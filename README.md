# Attachment Cloud Cache

**English** · [简体中文](./README.zh.md)

Upload your note attachments to **your own** S3-compatible storage, and keep a local copy so images
still render offline.

> **Status: 1.0.0.** Everything below works, and the full upload/download round trip has been proven
> against a real MinIO instance. Not proven yet: iOS has never been run, and Android has not been run
> on a real device.

## Why use it

The problem is normally split between two plugins, and each one leaves a gap you cannot work around:

- **Upload plugins** rewrite your note to point at a remote URL and usually delete the local file —
  so images break the moment you are offline.
- **"Localize" plugins** download remote images back into the vault — so you have to be online at
  least once before offline can work at all.

This plugin does both, in that order: it uploads, then keeps the local file as a **cache**. Your note
points at your storage (portable, shareable, small vault) while rendering uses the local copy — so
images are both **yours** and **always visible**, with zero remote requests when offline.

## Features

- **Any S3-compatible storage**: Cloudflare R2, AWS S3, MinIO, Backblaze B2 or a self-hosted endpoint
- **Uploads on paste or drag-and-drop**, rewriting the note link to your storage. Keys are
  content-addressed (`{hash}.{ext}`) by default, so the same image is stored once and pasting it twice
  uploads nothing
- **Images render offline** from the local copy, with zero remote requests
- **Never loses or overwrites a file**: a failed upload keeps the bytes locally and inserts a working
  link plus the reason; a same-named file becomes `a 1.png`, never replaced
- **Two optional features, both off by default**: caching images from other sites (nothing happens
  until you say so, and you can pick individual images), and a cache size limit that cleans up
  least-recently-used copies in the background
- **Five maintenance commands**: show cache usage · repair the local-copy index · clean up unused
  cache files · upload existing attachments · pick which off-site images to cache

Works on desktop and mobile.

## Installation

Requires Obsidian **1.13.0**+ (desktop and mobile) — the floor comes from the declarative settings API.
Anyone who has not updated Obsidian in the last few months cannot install this.

**From inside Obsidian (recommended):** **Settings → Community plugins → Browse** → search for
`Attachment Cloud Cache` → install and enable.

**Manually:** download the three files from the
[latest release](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases/latest)
into `<vault>/.obsidian/plugins/attachment-cloud-cache/` (⚠️ folder name = plugin id), then enable it
under **Installed plugins**.

## Setup

In **Settings → Attachment Cloud Cache**:

1. **Endpoint**, **Bucket**, **Region** — where your storage lives
2. **Public URL base** — optional. Empty means links use the object address (`endpoint/bucket/key`),
   which requires the bucket to allow anonymous reads; put a CDN or custom domain here if you use one
   (the field shows what empty would produce)
3. **Access key ID** (a plain text field; capitals are normal), then the **Secret access key** right
   below it
4. **Test connection** — one signed request to your bucket, then one **credential-free** request to
   the exact URL your links would use, so you learn whether other people can open them

## Things to know

- **A dropped file's link lands at the caret, not at the pointer.** No public API maps pointer
  coordinates to an editor position. Deliberate trade.
- **After you change the storage URL, older links are not recognised on a new device.** "Ours" is
  decided from the current settings plus the local index, so those links still render online but not
  offline, and are never downloaded automatically. Also deliberate.
- **"Do not keep a local copy" means no images offline.** The default, "move into the cache folder",
  is the one that works offline.
- **The cache folder can be deleted at any time** — images are rebuilt on demand.
- **Moving to another device? Copy the plugin folder, but delete `.cache-index.json` first.** That file
  records where *this* device keeps its cached copies; `data.json` is what carries your settings. ⚠️ The
  secret access key is **not** in the folder — it lives in Obsidian's own keychain — so you re-enter
  that one field on the new device.

## Privacy & security

- **It normally talks only to your storage**, and touches nothing outside your vault. No telemetry, no
  analytics, no ads.
- **One optional feature reaches other sites — only if you turn it on and tell it to act.** "Cache
  images from other sites" is **off by default**, and once on it still **does nothing by default**.
  To actually move an image off someone else's server you do one of two things: (1) set "When a note
  has an image from another site" to **cache straight away** — then opening such a note requests the
  image **directly from that site**, uploads it to your storage and rewrites the link; or (2) use the
  **"Cache images from other sites…"** command / the button in the settings, tick the specific images
  you want, and **only those** are fetched. That command, like "upload existing attachments", **names
  the sites it would visit** and only fetches after you confirm. The request carries nothing beyond
  the image's own address.
- **The secret access key lives in the OS keychain**, never in `data.json`. The **access key ID is
  written to `data.json`**: it is an identifier, not a secret — it is part of the signed request and
  appears in server logs — and Obsidian's keychain accepts only lowercase IDs while access key IDs
  routinely contain capitals.

## How far it is verified

- **Automated tests** (Node, no framework; a real HTTP server and the real filesystem where it matters)
  cover signing, key/path derivation, settings merging, the cache index, the upload chain
  (byte-identical, exactly one PUT, zero GETs), paste/drop decisions and cleanup safety — then a
  **mutation check** breaks each rule on purpose. An assertion that cannot fail is not an assertion.
- **Real host, real provider**: the shipped build runs in real Obsidian, and both directions of the
  round trip are proven against a real MinIO instance — the object key is recomputed independently from
  the bytes, the link opens **anonymously**, and the rendered `<img>` points at the local copy.
  Reproduce with `npm run verify:real-storage` (it uploads one object to your bucket).
- **Not verified**: iOS has never been run, and Android has not been run on a real device — the code
  avoids APIs known to be missing there, but that is reasoning, not evidence. Non-ASCII object keys
  have tests but no real-provider run.

## License

MIT — see [LICENSE](./LICENSE). An independent implementation written from scratch; it shares no code
with any other plugin.
