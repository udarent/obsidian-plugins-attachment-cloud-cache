# Attachment Cloud Cache

**English** · [简体中文](./README.zh.md)

Upload your note attachments to **your own** S3-compatible storage and keep a local cache copy — so
images still render when you are offline.

> **Status: 1.0.0.**
> **What works:** upload on paste/drop, offline rendering, fetching missing copies on demand, optional
> third-party image caching and a cache size limit, and four maintenance commands.
> **Verified:** the full upload / download round trip is proven against a real MinIO instance — see
> **How far it is verified** below.
> **Not proven yet:** iOS has never been run, and Android has not been run on a real device.

## Why use it

This problem is usually split between two plugins, and each one leaves a gap you cannot work around.
**Upload plugins** rewrite the note to point at remote URLs and typically delete the local file, so
images break offline. **"Localize" plugins** download remote images back into the vault, so you have
to be online at least once before offline can work at all.

This plugin does both: it uploads, and then keeps the local file as a **cache**. Your note points at
your storage (portable, shareable, small vault) and rendering uses the local copy — which works with
no network, and makes **zero** remote requests when offline.

## Features

- **S3-compatible storage**: Cloudflare R2, AWS S3, MinIO, Backblaze B2, or any S3-compatible endpoint
- **Uploads on paste or drag-and-drop**, rewriting the link in your note to point at your storage
- **Images render offline**: rendering swaps in the local copy, with zero remote requests when offline
- **Content-addressed by default** (`{hash}.{ext}`): the same image is stored once, and pasting it
  twice uploads nothing
- **Never loses an image**: if an upload fails, the file stays in your attachment folder, a working
  local link is inserted, and the reason is shown
- **Never overwrites a same-named file**: `a.png` becomes `a 1.png`
- **Optional third-party image caching** (off by default): asked once per site, downloaded only if
  you agree
- **Optional cache size limit** (off by default): least recently used copies are cleaned up in the
  background, freeing the space immediately
- **Four maintenance commands**: show cache usage, repair the local-copy index, clean up unused cache
  files, upload existing attachments
- **Desktop and mobile**

## Installation

Requires Obsidian **1.13.0** or newer (desktop and mobile). The floor is set by the declarative
settings API, which makes the settings searchable in Obsidian's global search. The cost is real:
anyone who has not updated Obsidian in the last few months cannot install this.

1. Build or download `main.js`, `manifest.json`, and `styles.css`
2. Copy them to `<vault>/.obsidian/plugins/attachment-cloud-cache/`
   ⚠️ The folder name must match the plugin id exactly — `attachment-cloud-cache`
3. Enable it in **Settings → Community plugins → Installed plugins**

## Setup

Open **Settings → Attachment Cloud Cache**, then:

1. Fill in **Endpoint**, **Bucket**, and **Region**
2. **Public URL base** is optional — leave it empty and links use the object address
   (`endpoint/bucket/key`), which requires the bucket to allow anonymous reads. If your images go
   through a CDN or a custom domain, put that prefix here; the field shows what leaving it empty
   would produce
3. Type your **Access key ID** (a plain text field — capitals are normal), then the **Secret access
   key** in the field right below it
4. Click **Test connection** — it sends one signed request to your bucket, and then opens the URL
   your links would use **without any credentials**, telling you whether other people can open them

## Things to know

- **A dropped file's link lands at the caret, not at the pointer.** Native Obsidian uses the pointer
  position, but no public API maps pointer coordinates to an editor position (reaching it would mean
  depending on undocumented internals). If your caret is elsewhere when you drop, the link goes
  there. This is a deliberate trade.
- **After you change the storage URL, older links are not recognised on a new device.** "This image
  is ours" is decided from the current settings plus the local-copy index. If you changed the domain
  or cleared the public URL base and have no local copy, those links are treated as third-party:
  they still render online, but not offline, and they are never downloaded automatically. Also
  deliberate — the alternative is guessing at other people's URLs.
- **The "do not keep a local copy" option means no images offline.** Of the three options, only that
  one conflicts with working offline; the default is "move into the cache folder (works offline)".
- **The cache folder can be deleted at any time.** That is part of the design: images are rebuilt on
  demand. Delete it whenever you want the space back.

## Privacy & security

- **It normally talks only to your storage.** The plugin sends the attachments you choose to upload
  to the endpoint you configured. It contains no telemetry, no analytics and no ads.
- **One optional feature reaches other sites — and only if you turn it on.** "Cache images from other
  sites" is **off by default**. Once it is on, opening a note with an image hosted elsewhere asks you
  **once per site**: choosing "Cache and remember this site" makes the plugin request that image
  **directly from that site**, upload it to your storage and rewrite the link; sites you answered
  "Don't ask for this site" for are never requested. The request carries nothing beyond the image's
  own address. With the feature off, the plugin makes no request to any site other than your storage.
- **Nothing outside your vault is touched.** Everything it reads or writes lives inside your vault.
- **The secret access key lives in the OS keychain**, never in `data.json`. **The access key ID is
  written to `data.json`** — it is an identifier, not a secret (it is part of the signed request
  itself, and appears in server logs), and Obsidian's secret storage only accepts lowercase IDs while
  access key IDs routinely contain capitals. The ID alone cannot sign anything.

## How far it is verified

- **Automated tests**: signing and key/path derivation, settings merging, the cache index, the upload
  chain (byte-identical content, exactly one PUT, zero GETs), paste/drop decisions, and the safety
  properties of the cleanup commands. Plus **mutation checks**: every rule is deliberately broken and
  the suite must fail *for that rule's own reason* — a test that cannot fail is not a test.
- **Real host**: the real build is loaded in real Obsidian — the plugin loads, all four commands
  register, the settings tab renders, and the live-preview image swap works without touching
  third-party images.
- **Real provider**: proven in both directions against a real MinIO instance. Pasting an image uploads
  it — the object key is recomputed independently from the bytes (`node:crypto`) and matches the one
  written into the note; the link opens **anonymously** (no credentials, i.e. what other people see);
  the bytes read back are identical to the local copy; and the rendered `<img>` points at that local
  copy rather than the remote URL. The download path is covered by earlier runs on the same instance.
  Reproduce with `npm run verify:real-storage` (it uploads one object to your bucket).
- **Not verified**: iOS has never been run (it cannot be, on this machine), and Android has not been
  run on a real device. The code avoids APIs known to be missing there and falls back when optional
  APIs are absent — but that is reasoning, not evidence. Object keys containing non-ASCII characters
  have also not been exercised against a real provider; the encoding itself is covered by tests.

## License

MIT — see [LICENSE](./LICENSE). This is an independent implementation written from scratch, sharing
no code with any other plugin.

## Development

```bash
npm install
npm run dev          # watch build
npm run check        # build + lint + manifest + static guards + tests
npm run test:unit    # tests only
npm run mutate       # mutation-check that every rule's assertions actually have teeth
```

Tests run on Node with no test framework: where it matters, a real HTTP server and the real
filesystem are used rather than mocks. `npm run check` also runs a few static guards, one of which
exists purely to stop the two READMEs from drifting apart.
