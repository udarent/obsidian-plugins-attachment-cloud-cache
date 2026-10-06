# Attachment Cloud Cache

Upload your note attachments to **your own** S3-compatible storage and keep a local copy in a
cache folder — so images still render when you are offline.

> **Status: early development (0.1.0).** The project is being built feature by feature under TDD;
> see [Scope & roadmap](./docs/SCOPE.md) for what is done and what is planned.
>
> **What works today:** the settings tab (connection settings, a "test connection" button);
> **uploading** — pasting or dropping image files uploads them, keeps a local copy, and rewrites the
> link to your storage; **offline rendering** — images served from your storage are swapped to the
> local copy in both reading view and live preview, and a third-party image is never touched;
> **fetching missing copies** on demand (a new device, or a cache you cleared); and four maintenance
> commands (show cache usage, repair the index, clean up unused cache files, upload existing
> attachments). Everything runs on Obsidian 1.13.0+ on desktop and mobile.
>
> **Not built yet:** no real S3 provider has been exercised end-to-end, and no real-device run has
> happened — see "Verified scope" below for exactly what that leaves unproven.

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

### What happens when you paste or drag an image in

1. The bytes are written into your attachment folder **first**. Only then is an upload attempted.
   This order matters because the plugin has already cancelled Obsidian's own handling of that
   paste — so from that moment the image survives only if the plugin persists it. Writing first
   means the worst case is "the image is here, it just was not uploaded", rather than a lost image.
2. The image is uploaded, and on success the local file is **moved** into the cache folder (not
   copied, and never deleted).
3. If the upload fails you get a local embed link plus an explicit notice saying why, so the note is
   still usable and nothing is silently lost.

Two safeguards are deliberate and worth knowing about:

- **Pasting the same image twice makes no network request.** Keys are derived from the content
  hash, so the object is already there.
- **A same-named file is never overwritten.** Names are made unique (`a.png` → `a 1.png`) by
  consulting both Obsidian's index and the real disk, since each lags the other.

When the plugin cannot be sure about your intent, it stays out of the way. A paste that also
carries text is left to Obsidian (you are probably pasting text), and dragging inside the vault is
left to Obsidian (you are probably moving a note). If a paste contains any file type the plugin
does not handle, the whole batch is passed through rather than handling part of it — handling part
of it would mean the rest gets discarded with nothing to put back.

## Verified scope (read this before trusting it)

Being precise about what has actually been exercised matters more than a long feature list:

| Area | How it is verified |
|---|---|
| Signing, key/path derivation, settings merging, cache index, file naming | Exhaustive unit tests, plus mutation checks that each rule fails for its own reason |
| SigV4 correctness | Three published AWS vectors (including an S3 example with query ordering and `$`-encoding) |
| Upload/download/HEAD/DELETE and the retry policy | A real local HTTP server that **independently recomputes** the signature — not the plugin's own code |
| The upload chain: byte-identical content, exactly one PUT and zero GETs, the local file being moved rather than copied, a failed upload keeping the bytes, same-name files never clobbered | The same real HTTP server plus a real filesystem |
| Paste/drop decisions | Exhaustive boundary tests over the decision alone, since misjudging one can swallow your content |
| Paste/drop execution | A recording editor stub asserting what text is inserted, where it is inserted, and that nothing was lost |
| The plugin **actually being wired up** | The real built `main.js` is loaded, `onload()` runs, and everything is driven end-to-end: a paste (exactly one PUT, byte-identical cached copy, link inserted, a second identical paste issuing zero PUTs), rendering in **both** reading view and live preview (src swapped to the local copy, **zero** requests, a third-party image left alone), `clean-cache` (only the orphan goes to trash; a referenced copy survives; **cancelling touches nothing**), and batch upload (both link forms rewritten, originals kept). Removing any registration line in `src/main.ts` fails this test — that is the point of it |
| Hashing | Cross-checked byte-for-byte against `node:crypto` over padding and key-length boundaries |

**Not yet verified:** no real S3 provider (R2/MinIO/AWS) has been exercised end-to-end yet, and
**iOS has not been tested at all** — it cannot be tested on this machine. The code avoids APIs
known to be missing there and falls back when optional APIs are absent, but that is reasoning, not
evidence. Android has not been run on a real device either.

A **real-desktop smoke check does pass** (`npm run verify:real`, driving Obsidian over the DevTools
protocol): the plugin loads in a real host, all four commands register, the settings tab renders,
and — the part that only a real WebView can settle — the live-preview `src` interception installs
without breaking anything and leaves third-party addresses alone.

What that does **not** cover is anything requiring a human at the keyboard: pasting and dropping an
image for real, whether the link lands where you expect, whether Obsidian's own paste handling is
fully suppressed, and how the live-preview interception behaves while editing. That last one is the
least conventional thing in this codebase and the first thing to suspect if an image ever shows the
wrong source.

**Known difference from native behaviour — dropping a file.** Native Obsidian inserts the link at
the **pointer position**. This plugin inserts it at the **caret position**, because no public API
maps pointer coordinates to an editor position (the 1.13.0 type definitions contain no `coords` /
`posAt`-style API, and reaching for the CodeMirror view object would mean depending on something
undocumented). If your caret is somewhere else when you drop, the link goes there instead. This is a
deliberate trade rather than an oversight.

**Known limitation — old links after you change the storage URL.** Recognising "this image is ours"
relies on the current settings plus the local-copy index. If you change or clear the public URL
prefix **and** the copy is not in the index (a fresh device), those older links are treated as
third-party: shown as-is, never downloaded. Online they still render; offline they will not. The
choice is deliberate — the alternative is guessing at other people's URLs, which would mean pulling
images into your vault that were never yours.

## Supported Obsidian versions

Requires Obsidian **1.13.0** or newer — desktop and mobile.

The floor is set by the newest API the plugin uses, and that is now the **declarative settings API**
(`getSettingDefinitions()`, added in 1.13.0). Adopting it was a deliberate trade: settings become
searchable in Obsidian's global settings search, conditional rows are expressed as predicates instead
of re-rendering the whole tab, and simple rows need no read/write code at all. The cost is real and
worth stating plainly — users who have not updated Obsidian in the last few months cannot install
this plugin, whereas the previous floor (1.11.4, set by `SecretStorage`) covered them.

Access keys still go through `SecretStorage`/`SecretComponent` (1.11.4), which is below the floor and
therefore no longer the constraint.

The number is not an estimate. The `obsidian` type package is pinned to **exactly** `1.13.0`, which
turns `tsc --noEmit` (part of `npm run build`) into a version gate — using anything added later fails
to compile. Checked by probe rather than assumed: when the pin was at 1.11.4, calling
`DataAdapter.appendBinary` (added in 1.12.3) failed with `Property 'appendBinary' does not exist on
type 'DataAdapter'`, while this plugin's own source compiled clean against those types.

That gate only holds while the pin holds, so `npm run check:api-floor` fails if the dependency gains
a `^` range, if the pinned types drift from `minAppVersion`, or if the installed package no longer
matches the declaration. Any of those would leave the gate green while it proved nothing — and a
check that has quietly stopped checking is worse than no check.

`minAppVersion` is per release: if a later version needs a newer API, the floor rises for that
version and `versions.json` keeps older Obsidian builds on the last compatible release.

`minAppVersion` is per release: if a later version needs a newer API, the floor rises for that
version and `versions.json` keeps older Obsidian builds on the last compatible release.

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
- How that independence was actually checked — the method, the result, and the parts that could
  not be verified — is recorded in [docs/INDEPENDENCE.md](./docs/INDEPENDENCE.md). The short
  version: a line-by-line comparison against the upstream sources finds **zero** shared lines, and
  none of upstream's function names appear here. The document also states plainly what a line
  comparison cannot prove.

## Development

```bash
npm install
npm run dev          # watch build
npm run check        # type-check + build + lint + manifest + api-floor + verifier-consistency + tests
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

This is not ceremony. It has already paid for itself several times, catching assertions that were
unreachable behind an earlier check, a backoff cap no test could reach, a de-duplication rule that
would have collapsed every pasted file into one, and — most usefully — a real double-encoding bug
where an already-encoded path got encoded again, producing uploads that succeeded but links that
would not open.

Because that kind of assurance is easy to lose by accident, `npm run check` also runs
`scripts/check-mutate-files.mjs`. It statically verifies that each mutation script makes exactly one
`runMutations` call (a second one would never execute, because the first exits the process — and the
output would still look successful), that every mutation script is actually listed in
`npm run mutate`, and that every shared assertion suite is used by both a test and a mutation
script. A check that silently stops running is worse than no check, so the wiring is verified too.

The same principle produced `scripts/check-api-floor.mjs`, which guards the `minAppVersion` claim
described under [Supported Obsidian versions](#supported-obsidian-versions). That claim rests on the
type package staying pinned, which is exactly the kind of invariant that decays quietly — so it is
asserted rather than trusted.
