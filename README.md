<!-- lang:en -->

# Attachment Cloud Cache

[![Latest release](https://img.shields.io/github/v/release/udarent/obsidian-plugins-attachment-cloud-cache?label=release&sort=semver&color=2f6feb)](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases)
[![Obsidian](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=483699&label=Obsidian&query=%24.minAppVersion&url=https%3A%2F%2Fraw.githubusercontent.com%2Fudarent%2Fobsidian-plugins-attachment-cloud-cache%2Fmain%2Fmanifest.json)](https://obsidian.md)
[![License](https://img.shields.io/github/license/udarent/obsidian-plugins-attachment-cloud-cache?color=97ca00)](./LICENSE)

**English** · [简体中文](#attachment-cloud-cache附件云端缓存) —— 中文版在本文下方

> **中文摘要** —— 把笔记里的**附件**（图片、音频、视频、PDF、压缩包……任何文件）上传到**你自己的**
> S3 兼容存储，同时在本地留一份副本：断网、甚至存储整个停机时，笔记里的附件照样显示。
> 需要 Obsidian **1.13.0 或更新**（桌面端与移动端）；更低版本在社区目录里只会回一句
> *No appropriate version found.* —— 那是 Obsidian 的安装机制在拒绝，不是插件坏了。
> 界面（设置页 / 命令 / 通知）会跟随你的 Obsidian 界面语言自动切换成中文。
> **完整中文说明见本文下方「中文版」一节**（[直接跳过去](#attachment-cloud-cache附件云端缓存)）。

Upload your note attachments to **your own** S3-compatible storage — Cloudflare R2, AWS S3, MinIO,
Backblaze B2, or anything that speaks S3 — and keep a local copy as a **disposable cache**. Your notes
end up pointing at a portable, shareable address, while rendering never touches the network.

[Install](#installation) · [Releases](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases) · [Report a problem](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/issues)

Requires Obsidian **1.13.0+** (desktop and mobile) — see [Requirements](#requirements).

> **Every behaviour described on this page has been exercised for real** — see
> [How far it is verified](#how-far-it-is-verified). **Not proven yet:** iOS has never been run, and
> Android has not been run on a real device.

![Paste a file into a note: it uploads to your own storage, a copy stays in your vault, and the file still renders after the storage goes offline](https://raw.githubusercontent.com/udarent/obsidian-plugins-attachment-cloud-cache/main/docs/demo.gif)

*Recorded from the plugin actually running in Obsidian: paste a file → it is uploaded to your own
storage → the note keeps a link while a local copy stays behind. The last step stops the storage
outright to show that the file still renders.*

## Why use it

The job is normally split across two kinds of plugin, and each one leaves a gap you cannot work around:

- **Upload plugins** push the file to a remote host and usually delete the local file — so the note
  becomes a page of broken links the moment you are offline.
- **"Localize" plugins** download remote files back into the vault — so they can only help *after*
  you have been online, and the vault grows with every file it pulls.

This plugin does the upload **and** keeps the file as a cache, so you never have to choose:

|  | Upload-only plugins | Localize-only plugins | Attachment Cloud Cache |
| --- | --- | --- | --- |
| Where the file lives | a remote host | only inside your vault | **your** bucket, plus a local copy |
| Offline | broken | works, after one online pass | **works — zero remote requests** |
| A new device | links work online | re-download everything | **copies are back-filled on demand** |
| Vault size | small | grows with every attachment | **small — the copies are disposable** |
| Who holds the original | a third party | you, but only locally | **you, in storage you control** |

## Features

### Storing your files

- **Any S3-compatible storage** — Cloudflare R2, AWS S3, MinIO, Backblaze B2, or a self-hosted
  endpoint. Keys are content-addressed (`{hash}.{ext}`) by default, so the same bytes are stored once
  and pasting the same file twice uploads nothing.
- **Upload on paste or drag-and-drop**, with the note's link rewritten to your storage as it goes.
- **Any file type, not just images** — images, audio, video, PDF, archives, documents, files with no
  extension at all. Types Obsidian can preview (images, audio, video, PDF) are inserted as embeds;
  everything else becomes an ordinary link you can click open.
- **Bulk-upload what you already have** — one command walks the vault, uploads the attachments your
  notes link to, rewrites those links, and files each one into the cache folder.
- **Import a credentials file** instead of typing keys. MinIO's "Download credentials" JSON is the
  shape it expects; the secret goes into your OS keychain and no copy of the file is kept anywhere.

### Your notes stay readable anywhere

- **Offline rendering from the local copy**, with zero remote requests. The copy is what gets
  rendered — always, not only when the network happens to be down.
- **Audio, video and PDF preview offline too**, not just images. Obsidian renders them in place, and
  the remote address never reaches the page.
- **Canvas references count the same as note references.** A file placed on a canvas, or linked from a
  text card on a canvas, is uploaded and its canvas reference keeps working.
- **Multi-device without manual migration.** Notes hold an ordinary remote link, so a second device
  shows everything online; the local copy is downloaded on demand and cached from then on.
- **A light vault to sync.** With the default "move into the cache folder", the vault's bulk becomes
  text plus a folder of disposable copies — exclude that folder from sync and every sync gets faster
  and cheaper. A missing copy is simply re-downloaded when you next look at it.

### Keeping things tidy

- **A cache size limit** that trims least-recently-used copies in the background and frees the space
  immediately.
- **Commands for the whole lifecycle** — usage, index repair, cache cleanup, bulk upload, off-site
  picking, and cloud cleanup. See [Commands](#commands).
- **Cloud space cleanup** that lists the objects in your storage no note refers to, shows you how many
  and how large they are, and only deletes what you confirm.
- **Two optional features, both off by default**: caching files hosted on other sites, and the size
  limit above.

Works on desktop and mobile.

## Requirements

- **Obsidian 1.13.0 or newer**, desktop and mobile. The floor comes from the declarative settings API
  the settings page is built on. On anything older, the community catalogue answers *No appropriate
  version found.* — that is Obsidian's installer refusing, not this plugin failing.
- **An S3-compatible bucket you control**, plus an access key pair for it.
- **The bucket must allow anonymous reads**, or you must set a public URL prefix (a CDN or a custom
  domain). Otherwise the links in your notes open for you but not for anyone else — **Test connection**
  checks exactly this, by making one credential-free request to the address your links would use.

## Installation

**From inside Obsidian (recommended):** **Settings → Community plugins → Browse** → search for
`Attachment Cloud Cache` → install and enable.

**Manually:** download the three files from the
[latest release](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases/latest)
into `<vault>/.obsidian/plugins/attachment-cloud-cache/` (⚠️ the folder name must equal the plugin id),
then enable it under **Installed plugins**.

Then fill in the storage settings — see [Settings](#settings).

## How it works

**The everyday flow — paste or drop a file**

1. You paste or drop a file into a note.
2. It is uploaded to your bucket under a content-addressed key (`{hash}.{ext}` by default).
3. The link in the note is rewritten to the address your settings produce — an embed for types
   Obsidian can preview, a plain link for everything else.
4. A local copy stays in the vault (in the cache folder by default), and that copy is what renders.
   The note shows the file immediately, and keeps showing it offline.
5. Pasting the same bytes again uploads nothing: the object is already there.

**The one-off flow — a vault that already has attachments**

Run **Upload existing attachments**. It collects the files your notes and canvases link to, uploads
them, rewrites those links, and moves each file into the cache folder. Anything no note links to is
left exactly where it sits — a command that sweeps a whole vault should never touch files nothing
points at.

**When a copy is missing** — a new device, or you deleted the cache folder — rendering falls back to
downloading that one file from your own storage and caching it again. Files from other sites are never
downloaded this way.

**Nothing is lost when an upload fails.** The bytes stay local, the note gets a working local link,
and a notice says what went wrong. A remote link is never invented for a file that was not uploaded.

## Settings

All of it lives in **Settings → Attachment Cloud Cache**. The interface follows Obsidian's language.
The names below are the English ones; the Chinese half of this page lists them as they appear in a
Chinese interface.

**Storage connection**

| Setting | What it does |
| --- | --- |
| **Endpoint** | Your storage service address. |
| **Bucket** | The bucket objects are stored in. |
| **Region** | Most self-hosted services accept anything here (`us-east-1` is the usual filler). |
| **Access key ID** | A plain text field; capitals are normal. |
| **Secret access key** | Goes into the OS keychain, never into `data.json`. |
| **Public URL prefix** | Optional. Empty means links use `endpoint/bucket/key`, which requires anonymous reads; put a CDN or a custom domain here if you use one. The field shows what empty would produce. |
| **Test connection** | One signed request to your bucket, then one credential-free request to the exact address your links would use. |
| **Import from a credentials file** | Optional, and usually faster than typing: MinIO's "Download credentials" JSON fills in the endpoint, access key and addressing mode. The file is read where it already is, and no copy of it is kept. |

**Upload**

| Setting | What it does |
| --- | --- |
| **Upload on paste and drop** | On by default. When off, pasting and dropping are left to Obsidian and files are saved locally as usual; already-cached files still render offline. |

**Offline copies**

| Setting | What it does |
| --- | --- |
| **Where the local copy goes** | `Move into the cache folder (offline works)` — the default — `Leave in the attachments folder (offline works)`, or `Do not keep a local copy (offline unavailable)`. |
| **Cache folder** | Relative to the vault root. Disposable: deleting it only costs one re-download. |
| **Cache size limit (MB)** | Once the folder grows past this, the least recently used copies are deleted in the background and the space is freed right away. `0` means no limit. |
| **Download missing copies** | For files from this storage that have no local copy, such as ones synced from another device. Files from other sites are never downloaded. |
| **Cache files from other sites** | Off by default. While it is off, nothing from other sites is touched at all. |
| **When a note links to a file on another site** | `Leave it alone` — the default — or `Cache straight away`, which fetches that file directly from its site when you open such a note, uploads it, and rewrites the link. |
| **Pick specific files** | Opens a picker for the current note or the whole vault; only the files you tick are fetched. Ticking one is the same as agreeing to it. |

**Advanced**

| Setting | What it does |
| --- | --- |
| **Attachments folder override** | Leave empty to follow Obsidian's own attachment setting; a value here overrides it. |
| **Object key template** | Placeholders: `{hash}`, `{ext}`, `{filename}`, `{date}`. Changing it affects new uploads only; existing links keep working. |
| **Compatibility mode** | Addresses objects as `endpoint/bucket/key`. Keep this on for Cloudflare R2, MinIO and most self-hosted services; turn it off only if your provider requires bucket subdomains. |

## Commands

All of them are in the command palette:

| Command | What it does |
| --- | --- |
| **Show cache usage** | How much the cache holds, and how much of it could be reclaimed. |
| **Repair the local-copy index** | Drops index entries whose files are already gone, so the index matches the disk again. |
| **Clean up unused cache files** | Deletes cache files no note points at any more. Deletion cannot be undone and the space is freed immediately. |
| **Upload existing attachments** | Uploads the attachments your notes link to, rewrites those links, and moves each file into the cache folder. Files no note links to are left alone. |
| **Cache files from other sites…** | Lets you tick individual off-site files to fetch and upload. Needs the off-site feature turned on first. |
| **Clean up unused objects in the cloud…** | Lists the objects in your storage that no note here refers to — with the count and the size — then deletes the ones you confirm. |

## Good to know

Deliberate behaviour, and a few things that look like bugs but are not:

- **`tiff`, `heic` and `ico` are inserted as plain links, not embeds.** Obsidian cannot preview those
  in an embed, so a remote `![]()` would render as a broken image. Your files are untouched — only the
  link shape differs. This changed with the all-types release.
- **A dropped file's link lands at the caret, not at the pointer.** No public API maps pointer
  coordinates to an editor position. Deliberate trade.
- **"Do not keep a local copy" means nothing is available offline.** The default, "move into the cache
  folder", is the one that works offline.
- **Links written before you change the storage URL are not recognised as "ours" on a new device.**
  "Ours" is decided from the current settings plus the local index, so those links still render online
  but not offline, and are never downloaded automatically.
- **Deleting an uploaded file asks whether the copy in your storage should go too**, and the default is
  "local only". The same content is stored once, so a single object may be shared across notes and
  devices — and a cloud deletion cannot be undone. The cleanup command can only see *this* device's
  references, which is stated right in its confirmation.
- **The cache folder can be deleted at any time.** Copies are rebuilt the next time you look at them.
- **Moving to another device? Copy the plugin folder, but delete `.cache-index.json` first.** That file
  records where *this* device keeps its cached copies; `data.json` is what carries your settings. ⚠️ The
  secret access key is not in the folder at all — it lives in Obsidian's own keychain — so you re-enter
  that one field on the new device.

## Troubleshooting

| What you see | What it means |
| --- | --- |
| The community catalogue says *No appropriate version found.* | Your Obsidian is older than 1.13.0. That is the installer refusing, not the plugin failing. |
| Links open for you but not for anyone else | The bucket does not allow anonymous reads and no public URL prefix is set. **Test connection** reports this case specifically. |
| Attachments are broken on a second device | That device has no local copy and could not download one — check the storage settings there, and that **Download missing copies** is on. |
| The file was saved locally and no link was uploaded | The upload failed; the notice names the reason, usually the credentials or the region. Nothing was lost — the file is still in your vault. |
| An off-site file was refused as "a web page or plain text" | That address serves HTML (hotlink protection does this), not a file. Caching a web page would only give you a download you did not ask for, so it is refused on purpose. |
| An upload seems to never finish | Please report it with the console output — see [Getting help](#getting-help). |

## Privacy & security

- **It normally talks only to your storage**, and touches nothing outside your vault. No telemetry, no
  analytics, no ads.
- **One optional feature reaches other sites — only after you turn it on and tell it to act.** "Cache
  files from other sites" is **off by default**, and once on it still **does nothing by default**. To
  move a file off someone else's server you either (1) set "When a note links to a file on another
  site" to **Cache straight away** — then opening such a note requests that file **directly from its
  site**, uploads it to your storage and rewrites the link — or (2) run **"Cache files from other
  sites…"** (or the button in the settings) and tick the specific files you want; **only those** are
  fetched. That command names the sites it would visit and only fetches after you confirm. The request
  carries nothing beyond the file's own address.
- **A web page is never stored.** If an address answers with `text/html` or another `text/*` type, the
  file is refused instead of being uploaded as a useless download.
- **The secret access key lives in the OS keychain**, never in `data.json`. The **access key ID is
  written to `data.json`**: it is an identifier, not a secret — it is part of the signed request and
  appears in server logs — and Obsidian's keychain accepts only lowercase IDs while access key IDs
  routinely contain capitals.
- **Importing a credentials file reads that file and nothing else.** It is read where it already is
  (nothing is copied into your vault), and only the fields above are taken from it. Anything else in
  the file is reported back and ignored.

## How far it is verified

- **Automated tests** (Node, no framework; a real HTTP server and the real filesystem where it matters)
  cover signing, key and path derivation, settings merging, the cache index, the upload chain
  (byte-identical, exactly one PUT, zero GETs), paste/drop decisions, canvas rewriting and cleanup
  safety — and then a **mutation check** breaks each rule on purpose. An assertion that cannot fail is
  not an assertion.
- **Real host, real storage.** The shipped build has been exercised in real Obsidian (1.14.4) against a
  real MinIO instance: eight file types pasted and checked down to the uploaded bytes and
  Content-Type; canvas rewriting for both node kinds; audio, video and PDF previewed offline in both
  view modes with the remote address never reaching a single element; both cloud-cleanup entry points
  clicked through with real mouse events; and a full round trip in which the object key is recomputed
  independently from the bytes and the link opens **anonymously**. Reproduce that round trip with
  `npm run verify:real-storage` (it uploads one object to your bucket).
- **Not verified**: iOS has never been run, and Android has not been run on a real device — the code
  avoids APIs known to be missing there, but that is reasoning, not evidence. Non-ASCII object keys
  have tests but no real-provider run.

## Getting help

- **Something broke?** Open an issue:
  <https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/issues>
- **Say what you saw**: the exact message, your Obsidian version, and which storage provider you use.
  The errors are written to name the step that failed, so they usually place the problem on their own.
- **Working on the plugin?** `npm install`, then `npm run dev` for a watch build or `npm test` to build
  and run the suites.
- ⚠️ **Never paste your secret access key.** Nothing a report needs is in it — the message, the
  endpoint and the bucket name are enough.

## License

MIT — see [LICENSE](./LICENSE). An independent implementation written from scratch; it shares no code
with any other plugin.

---

<!-- lang:zh -->

# Attachment Cloud Cache（附件云端缓存）

[![最新版本](https://img.shields.io/github/v/release/udarent/obsidian-plugins-attachment-cloud-cache?label=release&sort=semver&color=2f6feb)](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases)
[![Obsidian](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=483699&label=Obsidian&query=%24.minAppVersion&url=https%3A%2F%2Fraw.githubusercontent.com%2Fudarent%2Fobsidian-plugins-attachment-cloud-cache%2Fmain%2Fmanifest.json)](https://obsidian.md)
[![授权](https://img.shields.io/github/license/udarent/obsidian-plugins-attachment-cloud-cache?color=97ca00)](./LICENSE)

[English](#attachment-cloud-cache) · **简体中文**

把笔记里的附件上传到**你自己的** S3 兼容存储 —— Cloudflare R2、AWS S3、MinIO、Backblaze B2，
或任何说 S3 协议的服务 —— 同时在本地留一份**可随时丢弃的缓存副本**。于是笔记里存的是一条可迁移、
可分享的地址，而渲染时完全不碰网络。

[安装](#安装) · [版本发布](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases) · [反馈问题](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/issues)

需要 Obsidian **1.13.0+**（桌面端与移动端）—— 见[环境要求](#环境要求)。

> **这一页写的每条行为都真机跑过** —— 见[已验证到什么程度](#已验证到什么程度)。
> **还没验证的：** iOS 从未运行过；Android 也没在真机上跑过。

![演示：往笔记里粘贴一个文件 —— 它上传到你的存储，vault 里留一份缓存副本；随后把存储整个停掉，文件仍然正常显示](https://raw.githubusercontent.com/udarent/obsidian-plugins-attachment-cloud-cache/main/docs/demo.gif)

*动图取自**真实运行**中的 Obsidian：粘贴一个文件 → 上传到**你自己的**存储 → 笔记里留下链接，
同时本地留一份副本。最后一步把存储**整个停掉**，用来证明文件照样显示。*

## 为什么用它

这件事通常被两类插件分着解决，而各自留一个绕不过去的缺口：

- **上传类**把文件推到远端主机，而且往往删掉本地文件 —— 一断网，笔记就变成一页裂图；
- **「本地化」类**把远端文件下载回 vault —— 你必须先联网至少一次它才有用，而且每拉一个文件，
  vault 就大一分。

本插件两件都做：上传，**并且**把文件留作缓存。于是不必二选一：

|  | 只上传的插件 | 只本地化的插件 | 本插件 |
| --- | --- | --- | --- |
| 文件放在哪 | 远端主机 | 只在 vault 里 | **你自己的桶** + 本地副本 |
| 断网时 | 打不开 | 联网一次之后可用 | **可用 —— 零远端请求** |
| 换新设备 | 在线能看 | 得把所有文件重下一遍 | **副本按需自动补回** |
| vault 体积 | 小 | 每存一个附件就大一分 | **小 —— 副本是可丢弃的** |
| 原件归谁 | 第三方 | 归你，但只在本机 | **归你，在你自己的存储里** |

## 功能

### 把文件存好

- **任何 S3 兼容存储** —— Cloudflare R2、AWS S3、MinIO、Backblaze B2 或自建端点。默认按内容寻址
  （`{hash}.{ext}`），同一份字节只存一份，粘两次不会重复上传。
- **粘贴或拖入即上传**，同时把笔记里的链接改写成指向你的存储。
- **任何类型的附件**，不只是图片 —— 图片、音频、视频、PDF、压缩包、文档、没有扩展名的文件都行。
  Obsidian 能预览的类型（图片、音频、视频、PDF）插入为嵌入，其余插入为可点开的普通链接。
- **存量附件一条命令搬完** —— 它在整个库里找出笔记引用着的附件，上传、改写链接，并把每个文件
  移入缓存目录。
- **从凭据文件导入**，不必手输密钥。它认的就是 MinIO「下载凭据」那份 JSON：秘密进系统钥匙串，
  插件不留这份文件的任何副本。

### 笔记在哪都能看

- **断网时用本地副本渲染**，零远端请求。渲染**始终**走副本，而不只是「网恰好不通」的时候。
- **音频、视频、PDF 离线也能直接预览**，不只是图片。宿主就地渲染它们，远端地址从不落到页面上。
- **画布里的引用与笔记里的同等算数。** 摆在画布上的文件、或画布文字卡片里链接的文件，同样会被
  上传，而且画布里的引用会继续有效。
- **多设备，零手工迁移。** 笔记里是普通远端链接，所以第二台设备在线就能看全部；本地副本按需下载，
  之后一直缓存着。
- **库很轻，同步很快。** 用默认档「移入缓存目录」时，vault 的体量变成纯文本 + 一个可丢弃的副本
  目录 —— 把这个目录排除在同步外，每次同步都更快更省容量。副本丢了，下次看它时会自动重新下载。

### 保持整洁

- **缓存大小上限**：超限时后台按最近最少使用清理，磁盘空间立刻释放。
- **覆盖全生命周期的命令** —— 占用统计、索引修复、缓存清理、批量上传、站外挑选、云端清理。
  见[命令](#命令)。
- **云端空间清理**：列出你存储里「本库没有笔记引用」的对象，先告诉你**有多少个、占多少空间**，
  只删你确认过的那些。
- **两个可选功能，默认都关**：缓存站外文件，以及上面的缓存上限。

桌面端与移动端都支持。

## 环境要求

- **Obsidian 1.13.0 或更新**，桌面端与移动端。下限来自设置页所用的声明式设置 API。更低的版本在
  社区目录里只会回一句 *No appropriate version found.* —— 那是 Obsidian 的安装机制在拒绝，
  不是插件坏了。
- **一个你自己控制的 S3 兼容存储桶**，以及一对访问密钥。
- **存储桶要允许匿名读取**，或者你得填一个公开访问前缀（CDN 或自定义域名）。否则写进笔记的链接
  你自己打得开、别人打不开 —— **测试连接** 检查的正是这件事：它会**不带任何凭据**请求一次
  「你笔记里会写的那条地址」。

## 安装

**在 Obsidian 里装（推荐）**：**设置 → 第三方插件 → 浏览** → 搜 `Attachment Cloud Cache` →
安装并启用。

**手动安装**：从[最新 release](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases/latest)
下载那三个文件，放进 `<vault>/.obsidian/plugins/attachment-cloud-cache/`（⚠️ 目录名必须等于插件 id），
再在 **已安装插件** 里启用。

然后填存储设置 —— 见[设置](#设置)。

## 工作方式

**日常流程 —— 粘贴或拖入一个文件**

1. 你把一个文件粘贴或拖进笔记。
2. 它被上传到你的桶，key 默认按内容寻址（`{hash}.{ext}`）。
3. 笔记里的链接被改写成你设置里产出的地址 —— 宿主能预览的类型用嵌入，其余用普通链接。
4. 本地副本留在 vault 里（默认在缓存目录），**渲染用的就是它**。笔记立刻显示这个文件，而且离线
   也一直显示。
5. 同一份字节再粘一次不会重复上传：对象已经在了。

**一次性流程 —— 手上已经有一堆附件的库**

运行 **上传已存在的附件**。它会收齐笔记与画布引用着的文件，上传、改写那些链接，并把每个文件移入
缓存目录。**没有任何笔记引用的文件一概留在原地** —— 一条要扫全库的命令，绝不该去碰没人指向的文件。

**副本缺失时** —— 换了新设备，或你把缓存目录删了 —— 渲染会退回去，从**你自己的存储**把那个文件
下载回来并重新缓存。站外文件永远不会走这条路。

**上传失败不会丢东西。** 字节留在本地、笔记里插一条能用的本地链接，并提示失败在哪一步。绝不会为
一个没上传成功的文件编造远端链接。

## 设置

全部在 **设置 → Attachment Cloud Cache** 里。界面跟随 Obsidian 的语言；下面这些名字就是中文界面
上显示的文字（本页英文半列的是英文名）。

**存储连接**

| 设置项 | 说明 |
| --- | --- |
| **服务地址** | 你的存储服务地址。 |
| **存储桶** | 对象存放在哪个桶里。 |
| **区域** | 多数自建服务填什么都行（惯例是 `us-east-1`）。 |
| **访问密钥 ID** | 普通输入框，含大写是正常的。 |
| **秘密访问密钥** | 进系统钥匙串，绝不写进 `data.json`。 |
| **公开访问前缀** | 可以留空。留空就用 `服务地址/存储桶/键`，那要求存储桶允许匿名读取；走 CDN 或自定义域名时把前缀填在这里。输入框里会显示「留空会用什么地址」。 |
| **测试连接** | 先向你的桶发一次签名请求，再**不带凭据**请求一次「你笔记里会写的那条地址」。 |
| **从凭据文件导入** | 可选，但一般比手输快：MinIO「下载凭据」给的 JSON 会填好服务地址、访问密钥与寻址方式。文件在原位置被读取，不留副本。 |

**上传**

| 设置项 | 说明 |
| --- | --- |
| **粘贴或拖入时自动上传** | 默认开启。关闭后粘贴与拖拽交回 Obsidian 处理，文件照常存在本地；已经缓存的附件仍然离线可见。 |

**离线副本**

| 设置项 | 说明 |
| --- | --- |
| **本地副本的处理** | `移入缓存目录（离线可用）`（默认）、`留在附件目录（离线可用）`，或 `不留本地副本（离线不可用）`。 |
| **缓存目录** | 相对 vault 根目录。**这个目录是可丢弃的**：删掉只会导致重新下载一次。 |
| **缓存大小上限（MB）** | 缓存目录超过这个大小后，后台会把最久没用过的副本删掉，空间立刻释放。填 `0` 表示不限制。 |
| **缺本地副本时自动下载** | 属于本存储、却没有本地副本的附件（例如从另一台设备同步来的）会自动下载。站外文件永不下载。 |
| **缓存站外文件** | 默认关闭。关着时，站外的东西一步都不会被碰。 |
| **遇到站外文件链接时** | `什么都不做`（默认），或 `直接缓存` —— 后者会在你打开含该链接的笔记时**直接向那个站点**取文件、上传并改写链接。 |
| **挑选要缓存的文件** | 打开一个选择器（当前笔记 / 全库），**只处理你勾中的**。勾选本身就是同意。 |

**高级**

| 设置项 | 说明 |
| --- | --- |
| **附件目录覆盖** | 留空表示跟随 Obsidian 自己的附件设置；填写后将覆盖它。 |
| **对象 key 模板** | 可用占位符：`{hash}`、`{ext}`、`{filename}`、`{date}`。改动只影响之后的上传，已有链接不受影响。 |
| **兼容模式** | 以 `地址/桶/键` 的方式寻址。Cloudflare R2、MinIO 与多数自建服务都要开着；只有服务商要求用桶名做子域时才关掉。 |

## 命令

都在命令面板里：

| 命令 | 做什么 |
| --- | --- |
| **查看缓存占用** | 缓存里有多少、其中多少可以回收。 |
| **自检并修复本地副本索引** | 丢掉那些文件已经不在的索引记录，让索引和磁盘重新对上。 |
| **清理未使用的缓存文件** | 删掉已经没有笔记指向的缓存文件。删除无法撤销，空间立刻释放。 |
| **上传已存在的附件** | 把笔记里引用着的附件上传、改写那些链接，并把每个文件移入缓存目录。没有任何笔记引用的文件不会被碰。 |
| **缓存站外文件（可挑选）…** | 勾选具体的站外文件去下载并上传。需要先打开站外文件功能。 |
| **清理云端未使用对象…** | 列出你存储里「本库没有笔记引用」的对象 —— 连同**个数与体积** —— 确认后删除。 |

## 需要注意的

有意为之的行为，以及一些「看起来像缺陷、其实不是」的事：

- **`tiff`、`heic`、`ico` 插入的是普通链接，不再嵌入。** 宿主无法在嵌入里预览这几种类型，
  写 `![]()` 只会得到一个坏图。你的文件没被动 —— 变的只是链接形态。这是「全格式」这一版带来的变化。
- **拖放文件的链接插在光标处，不是指针落点。** 公开 API 里没有「指针坐标 → 编辑器位置」的映射。
  这是有意取舍。
- **「不留本地副本」这一档断网时什么都看不到。** 默认档是「移入缓存目录」，那一档才离线可用。
- **改了存储地址之后，「新设备」上认不出老链接。** 判断「这是我们的」依赖当前设置加本地副本索引，
  所以那些老链接照常在线显示、但离线不显示，也不会被自动下载。
- **删掉一个已上传的文件时，会问你要不要连云端那份一起删**，默认是「仅删本地」。相同内容只存一份，
  所以同一个对象可能被多篇笔记、多台设备共用 —— 而云端删除无法撤销。清理命令只能看到**本设备**的
  引用情况，这一点直接写在它的确认框里。
- **缓存目录可以随时整体删除。** 再看那些文件时按需重建。
- **换设备？把插件目录整体复制过去，但先删掉 `.cache-index.json`。** 那个文件记的是**这台设备**的
  缓存副本在哪，而 `data.json` 才装着你的设置。⚠️ **秘密访问密钥根本不在目录里** —— 它存在
  Obsidian 自己的钥匙串中，所以要在新设备上重填那一项。

## 常见问题排查

| 你看到的现象 | 含义 |
| --- | --- |
| 社区目录说 *No appropriate version found.* | 你的 Obsidian 低于 1.13.0。那是安装机制在拒绝，不是插件坏了。 |
| 链接你自己打得开、别人打不开 | 存储桶没允许匿名读取，也没填公开访问前缀。**测试连接** 会专门报出这一种情况。 |
| 换台设备后附件裂了 | 那台设备没有本地副本、也补不下来 —— 检查它的存储配置，并确认 **缺本地副本时自动下载** 是开着的。 |
| 文件留在本地，但没有上传出链接 | 上传失败了；提示里写了原因，通常是凭据或区域。什么都没丢 —— 文件还在你的 vault 里。 |
| 站外文件被以「返回的是网页或纯文本」拒收 | 那个地址回的是 HTML（防盗链常见这样），不是文件。把网页缓存下来只会得到一份你没想要的下载，所以刻意拒收。 |
| 某次上传看起来永远不结束 | 请带上控制台输出反馈 —— 见[遇到问题](#遇到问题)。 |

## 隐私与安全

- **默认情况下它只连你自己的存储**，也不碰 vault 之外的文件。不含遥测、统计与广告。
- **有一个可选功能会访问其它站点，而且只有你打开它、并且明确让它做时才会。**「缓存站外文件」
  **默认关闭**；打开后**默认什么都不做**。要真正去搬别的站点的文件，你得做两件事之一：① 把
  「遇到站外文件链接时」设成**直接缓存** —— 那时打开含该链接的笔记，插件会**直接向那个站点**
  请求文件、上传到你的存储并改写链接；② 用**「缓存站外文件（可挑选）」**那条命令 / 设置页的按钮
  勾选具体几个，**只有勾中的**会被处理。那条命令与「上传已存在的附件」一样会**列出即将访问的站点**，
  只有你确认之后才会去取。请求里除文件地址本身不带任何其它内容。
- **网页永远不会被存下来。** 如果地址回的是 `text/html` 或别的 `text/*`，文件会被**拒收**，而不是
  作为一个没用的下载被传上去。
- **秘密访问密钥存在操作系统钥匙串里**，绝不写进 `data.json`。**访问密钥 ID 会写进 `data.json`**：
  它是标识符而不是秘密 —— 它本身就是被签名请求的一部分，也会出现在服务端日志里 —— 而且 Obsidian
  的钥匙串只接受小写 ID，访问密钥 ID 常规就带大写。
- **导入凭据文件只读那一份文件**。它就在原位置被读取（不会拷进 vault），也只取用上面那几项；
  文件里其余的键会如实回报并忽略。

## 已验证到什么程度

- **自动化测试**（跑在 Node 上、不用测试框架；该用真实的地方用真实 HTTP 服务与真实文件系统）覆盖
  签名、key 与路径推导、设置合并、缓存索引、上传链路（字节一致、恰好 1 次 PUT、0 次 GET）、
  粘贴/拖放判定、画布改写与清理类命令的安全性质 —— 之后还有一道**变异验证**：把每条规则故意改坏。
  不会失败的断言等于没有断言。
- **真实宿主与真实存储。** 构建产物在真实 Obsidian（1.14.4）里跑过，并且对着真实 MinIO 逐项验证：
  八种类型的文件粘贴后，逐项核对**上传的字节**与 **Content-Type**；画布两类节点的改写；
  音频、视频、PDF 在两种视图模式下离线预览，且**远端地址从未落进任何一个元素**；云端清理两条入口
  用**真实鼠标事件**点通；以及一次完整回环 —— 对象 key 由脚本从字节**独立重算**，链接**匿名**能打开。
  可用 `npm run verify:real-storage` 复现那次回环（它会往你的桶里传一个对象）。
- **没验证的**：iOS 从未运行过；Android 也没在真机上跑过 —— 代码避开了已知在那里缺失的 API，
  但那是推理，不是证据。含非 ASCII 字符的对象 key 有测试覆盖，但没在真实服务商上跑过。

## 遇到问题

- **出问题了？** 到 <https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/issues> 提 issue。
- **请说清你看到的**：报错原文、你的 Obsidian 版本、用的哪家存储服务。插件的报错都写明了失败在
  哪一步，通常靠它就能定位。
- **想改插件本身？** `npm install`，然后 `npm run dev` 起监听构建，或 `npm test` 构建并跑全部套件。
- ⚠️ **绝不要把秘密访问密钥贴上来。** 报告里没有一处需要它 —— 报错原文、服务地址和桶名已经足够。

## 授权

MIT —— 见 [LICENSE](./LICENSE)。本插件是独立实现，从零写起，不与任何其它插件共享代码。
