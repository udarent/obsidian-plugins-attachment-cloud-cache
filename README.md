<!-- lang:en -->

# Attachment Cloud Cache

<p>
  <a href="https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases"><img alt="release" src="https://img.shields.io/github/v/release/udarent/obsidian-plugins-attachment-cloud-cache?label=release&amp;sort=semver&amp;color=2f6feb" vspace="6"></a>
  <a href="https://obsidian.md"><img alt="Obsidian" src="https://img.shields.io/badge/dynamic/json?logo=obsidian&amp;color=483699&amp;label=Obsidian&amp;query=%24.minAppVersion&amp;url=https%3A%2F%2Fraw.githubusercontent.com%2Fudarent%2Fobsidian-plugins-attachment-cloud-cache%2Fmain%2Fmanifest.json" vspace="6"></a>
  <a href="https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/blob/main/LICENSE"><img alt="license: MIT" src="https://img.shields.io/github/license/udarent/obsidian-plugins-attachment-cloud-cache?color=97ca00" vspace="6"></a>
</p>

**English** · [简体中文](#attachment-cloud-cache附件云端缓存)

**Your attachments live in your own storage — and still render offline.** Paste a file: it uploads to **your**
S3-compatible bucket (Cloudflare R2, AWS S3, MinIO, Backblaze B2, self-hosted), the note keeps a portable link,
and the file itself stays in your vault as the local copy. **Rendering reads that copy — no network round trip.**

[Install](#installation) · [Releases](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases) · [Report a problem](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/issues) · Requires Obsidian **1.13.0+** ([why](#requirements))

**Contents** · [Quick start](#quick-start) · [Why](#why-use-it) · [Features](#features) · [Requirements](#requirements) · [Installation](#installation) · [Settings](#settings) · [Commands](#commands) · [Good to know](#good-to-know) · [Privacy](#privacy--security) · [Verification](#how-far-it-is-verified) · [Help](#getting-help) · [License](#license)

![Paste a photo, a chart and a PDF into a note: each one uploads to your own storage and the note keeps a link; one command opens the attachment manager, where chips carry their own counts and ticking rows turns on the batch actions; then the storage goes offline and all three still render](https://raw.githubusercontent.com/udarent/obsidian-plugins-attachment-cloud-cache/main/docs/demo.gif)

*Paste a photo, a chart and a PDF — each one uploads and the link in the note is rewritten. The file itself stays in your vault (that **is** the local copy). One command then opens the **attachment manager**: one table for every attachment, chips that carry their own counts, and batch actions whose labels state how many of the ticked rows they can actually act on. With the storage offline, all three still render — what renders are the copies in your vault. The vault in the recording is a throwaway one and the storage is a local mock.*

## Quick start

1. **Fill in the storage connection** — endpoint, bucket, region and a key pair (or import MinIO's credentials file).
2. **Press Test connection** — a green *public* light or a blue *private* light both mean you are ready.
3. **Paste a file into a note** — it uploads, the link is rewritten, and the file stays in your vault as the local copy.

## Why use it

Upload-only plugins break your notes the moment you go offline; “localize” plugins need one online pass first.
This does both: the file goes to your bucket, and the copy that renders stays in your vault.

|  | Upload-only | Localize-only | This plugin |
| --- | --- | --- | --- |
| Offline | broken | after one online pass | **works — renders from the copy** |
| A new device | links work online | re-download everything | **copies back-filled on demand** |
| Vault size | small | grows with every file | **small — copies are disposable** |
| Who holds the original | a third party | you, but locally only | **you, in your own storage** |

## Features

- **Any S3-compatible storage, any attachment type** — images, audio, video, PDF, archives, documents, files
  without an extension. What Obsidian can preview becomes an embed; everything else a clickable link.
- **Attachment manager** — one dialog for every attachment in the vault: a six-column table (name, folder, state,
  whether any note links to it, size, open), filter chips that carry their own counts, and batch actions on the
  selection (upload, delete local, use the local file, delete from cloud). Rename works on a single row.
- **Any way in** — pasted, dropped, from your phone's gallery or camera, shared into Obsidian, or copied into the vault.
- **It tells you what your bucket allows** — a status light next to **Test connection** (*public* / *private* /
  *unreachable*), re-checked on demand; no link is rewritten for it.
- **The same file twice is one object** — the key is the file name plus its full content hash: one address,
  the original name in the link, the extra copy cleaned up.
- **Offline and multi-device** — rendering uses the local copy, and a new device back-fills copies on demand.
  Canvas references count too, and one command uploads what your notes already link.
- **Cloud cleanup** — lists the attachments this vault uploaded that no note links to any more; deletes only what you confirm.
- **Two optional extras, off by default** — off-site files treated as ordinary files (with a site list), and a
  local-copy limit that trims least-recently-used copies.

## Requirements

- **Obsidian 1.13.0 or newer**, desktop and mobile.
- **An S3-compatible bucket you control**, plus an access key pair.
- **The bucket does not have to be public.** Public reads only matter if you paste links elsewhere; otherwise the
  plugin fetches with your keys and shows local copies. **Test connection** tells you which case you are in.

## Installation

**From Obsidian:** Settings → Community plugins → Browse → search `Attachment Cloud Cache` → Install → Enable.

**Manually:** put `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases/latest) into
`<vault>/.obsidian/plugins/attachment-cloud-cache/` (⚠️ the folder name must equal the plugin id).

## Settings

In **Settings → Attachment Cloud Cache** (Chinese names in the [中文版](#attachment-cloud-cache附件云端缓存) below):

| Group | Setting | What it does |
| --- | --- | --- |
| **Storage connection** | **Endpoint · Bucket · Region** | Where your storage lives. The bucket name is case-sensitive; self-hosted services usually take `us-east-1`. |
| | **Access key ID · Secret access key** | The secret goes into the OS keychain, never `data.json`; **Import from a credentials file** fills these in from MinIO's JSON. |
| | **Compatibility mode** | Keep it on for Cloudflare R2, MinIO and most self-hosted services. |
| | **Public link address (optional)** | Empty means `endpoint/bucket/key`; fill it in for a CDN or your own domain. |
| | **Test connection** | A **status light** (*checking* / *public* / *private* / *unreachable*) plus a button that re-checks upload, read-back, delete and external reach — without keeping anything or rewriting a link. |
| **Upload** | **Upload new attachments automatically** | On by default; off leaves new files local only. |
| | **Upload files from other sites** | Off by default; the site list narrows the **automatic** path only, and picking by hand is never restricted. |
| | **Also upload files on this computer** | Off by default, desktop only: lets “Upload all” follow `file:///` paths written in your notes. |
| | **Upload all attachments** | The reverse of *Revert links to local paths*: one confirmation, no list to tick. |
| | **Revert links to local paths** | Points note links back at the files in your vault. **Nothing is deleted**; files with no copy keep pointing at your storage. |
| **Offline and local copies** | **What happens to the local copy** | **Keep it** (default, offline works) or **delete it after uploading** (saves space; no offline, and PDFs need a copy). With delete mode, “Upload all” also removes the local copies of files that were already uploaded, once it finishes. |
| | **Download missing local copies automatically** | Fetches files the current device does not have yet. Auto-download is skipped in delete mode — except for a private bucket, where it always runs. |
| | **Local copy limit (MB) · Space used** | `0` = no limit; least-recently-used copies go first, and only after the object is confirmed in your storage. The line under it shows what the copies take up right now. |
| **Cloud cleanup** | **When an attachment is no longer linked** | Ask (default) / notify / do nothing. Cleanup always asks. |
| **Logs and troubleshooting** | **Deletion log · Debug logging** | Every permanent cloud delete is recorded (that log is the only record left); debug logging prints each stage to the console and changes nothing. |

## Commands

| Command | What it does |
| --- | --- |
| **Attachment manager** | The only command. Opens one dialog (a wide window on desktop, full screen on phones) with a multi-column table (name, folder, state, whether any note links to it, size, open): every attachment plus filters (to clean up / not uploaded / uploaded / cloud-only / unreferenced, each showing how many items it holds), and batch actions on the selection (upload, delete local, use local file, delete from cloud). Rename works on a single row. **It closes itself when the batch finishes** and one notice tells you how many succeeded, were skipped, or failed. |

 > **Upgrading from 1.8 or earlier**: the separate **Upload attachments** and **Clean up attachments** commands are gone — both are now filters plus actions inside **Attachment manager**. If you had shortcuts bound to them, bind them again.

## Good to know

- **A lost copy comes back when you next view the note**, under its original name. This needs the link to be
  recognised as yours: links written *before* a storage-URL change still work online on a new device, but never
  render offline and are never downloaded automatically.
- **One file, one object** — shared by several notes and devices. A storage deletion cannot be undone, and cleanup
  sees **this device's** references only.
- **`tiff`, `heic` and `ico` are inserted as plain links** — Obsidian cannot preview them in an embed.
- **A dropped file's link lands at the caret, not at the pointer** — no public API maps pointer coordinates to an
  editor position. Deliberate.
- **The local-copy index repairs itself** shortly after startup and periodically afterwards; it only edits the
  index, never a file.
- **Moving to another device? Copy the plugin folder, but delete `.cache-index.json` first** — it records where
  *this* device keeps its copies. The secret key is not in the folder at all.

**Common failures**

| Symptom | What it means |
| --- | --- |
| *No appropriate version found.* | Your Obsidian is older than 1.13.0 — the installer refusing, not a broken plugin. |
| Links open for you but not for others | The status is *private*: the bucket refuses anonymous reads. **Test connection** says so. |
| Broken on a second device | No local copy there, and one could not be downloaded. |
| An off-site file refused as "a web page or plain text" | That address serves HTML, so it is refused on purpose. |
| *Test connection* says the storage refused to write | The keys can read but not write — uploads will fail the same way. |
| *Test connection* says the address "answered with a web page" | A proxy, a WAF or a catch-all page answered `200` for a path that is not your file. That is **not** public access — fix the public link address. |

## Privacy & security

- **It normally talks only to your storage** — no telemetry, no analytics. Two things can reach outside, and both are
  off by default: the optional off-site feature below (that same switch also decides whether “Upload all” touches
  off-site images), and the switch that lets “Upload all” read files on this computer. Turning either on is the consent.
- **One optional feature reaches other sites, and it never turns itself on** — off by default; enabling it is the
  consent, and the site list narrows it further. The request carries nothing beyond the file's address.
- **A web page is never stored** — `text/html` and other `text/*` answers are refused rather than uploaded.
- **The secret access key lives in the OS keychain**, never in `data.json`; the access key ID is stored there in the
  clear — it is an identifier, not a secret. File names are part of each object's key, so they show up in your
  provider's logs.

## How far it is verified

- **Automated:** signing, key and path derivation, settings, the index, the upload chain (byte-identical, one PUT,
  zero GETs), paste/drop decisions, canvas rewriting and every connection state — then a **mutation check** that
  breaks each rule on purpose and requires the suite to fail for that rule's own reason.
- **Real Obsidian 1.14.5 (Windows) against real MinIO:** a format matrix (images, audio, video, PDF, archives)
  checked down to the uploaded bytes; both canvas node kinds; offline audio/video/PDF; a round trip whose link
  opens **anonymously**; and with the bucket **private, then public**, the status light settling on *Private* /
  *Public* — 12 checks each way, five rounds of **Test connection** giving the same answer and leaving nothing
  behind in the bucket, plus a signed URL that returns 200 while the same address without a signature returns 403.
- **In-app scripts:** a CDP script drives **real Obsidian** (build fixtures → open the dialog → read the real DOM →
  assert → clean up). It checks 38 things (one command, chip counts equal the rows they open, a single header row
  with select-all in its first cell, tri-state select, six columns, button counts equal applicable items, the
  icon and grey tick on a dead row, the window closing itself when a run ends), and 18 more **after a real
  upload** (a bracketed file name, a repair run with zero PUTs, "already there" reported apart from "uploaded").
  It never confirms anything, so your vault and your bucket are untouched.
- **Phones:** Android, verified up to 1.1.2 — ⚠️ **no mobile regression since then**; try it on a small scale first.

Reproduce the storage checks with `npm run verify:real-storage`, and the connection probe with
`node scripts/verify-connection-probe.mjs`.

## Troubleshooting

Start with **Settings → Attachment Cloud Cache → Test connection**: its status light answers "can this vault reach
your storage, and can other people open my links?" without changing anything.

| What you see | What it usually is | What to do |
|---|---|---|
| Images stay blank, `403` in the console | The bucket is **private** and the note holds a direct link | Nothing to fix: with a private bucket the plugin keeps a local copy and shows that instead |
| Images blank **and** the status light says *Unreachable* | Endpoint / bucket / keys | Re-run Test connection, then re-check the endpoint (some providers need the region written into it) |
| The confirmation says some local files are "gone from this computer" | Those `file:///…` targets were deleted or moved (temp folders do this) | They are skipped. Open the note and fix those links — the plugin will not upload a file it cannot read |
| A command appears to do nothing | Two known causes: storage not configured yet (it says so), or the vault has a note that **cannot be read** | The cleanup command refuses to run in that case **on purpose** — it will not treat "unknown" as "unused" |
| After switching devices the images do not come back | The index records paths **on that device** | Copy the plugin folder **without** `.cache-index.json` (see Good to know) |
| A download seems stuck | Requests now time out (60 s for a download) and the object stays retryable | If it still hangs, open an issue with the console log |

## Upgrading

- **1.2.0 moved where copies live**: the old cache folder is gone; a copy is simply the file in your attachments
  folder. Nothing to migrate — the first render registers it.
- **The command panel is down to one command**: the older `Upload files your notes link to…`, `Upload off-site or
  local files…`, `Pick files to cache…`, `Upload attachments` and `Clean up attachments` are all gone.
  **Attachment manager** is now the only command: uploading and cleaning are filters plus batch actions inside its
  table, and the per-file list lives there (the “To clean up” filter holds what the cleanup command used to list).
  Uploading the whole vault in one go is the settings-page action **“Upload all attachments”** (one confirmation,
  no list).
- ⚠️ **Hotkeys are bound to command ids**, and this time the ids changed — shortcuts bound to the old commands stop
  working and have to be bound again to **Attachment manager**.
- Settings are additive: new keys get defaults, and unknown keys from older versions are ignored.

## Getting help

Open an issue: <https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/issues> — say what you saw, your
Obsidian version and which storage provider you use; the errors name the step that failed.
Working on the plugin? `npm install`, then `npm run dev` (watch build) or `npm test` (build + all suites).
Issues and pull requests are welcome.

## License

MIT — see [LICENSE](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/blob/main/LICENSE).
Use it, modify it, redistribute it (commercially too); keep the copyright notice.

---

<!-- lang:zh -->

# Attachment Cloud Cache（附件云端缓存）

<p>
  <a href="https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases"><img alt="release" src="https://img.shields.io/github/v/release/udarent/obsidian-plugins-attachment-cloud-cache?label=release&amp;sort=semver&amp;color=2f6feb" vspace="6"></a>
  <a href="https://obsidian.md"><img alt="Obsidian" src="https://img.shields.io/badge/dynamic/json?logo=obsidian&amp;color=483699&amp;label=Obsidian&amp;query=%24.minAppVersion&amp;url=https%3A%2F%2Fraw.githubusercontent.com%2Fudarent%2Fobsidian-plugins-attachment-cloud-cache%2Fmain%2Fmanifest.json" vspace="6"></a>
  <a href="https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/blob/main/LICENSE"><img alt="license: MIT" src="https://img.shields.io/github/license/udarent/obsidian-plugins-attachment-cloud-cache?color=97ca00" vspace="6"></a>
</p>

[English](#attachment-cloud-cache) · **简体中文**

**附件存在你自己的存储里，断网也能看。** 往笔记里粘贴一个文件：它上传到**你自己的** S3 兼容存储桶（Cloudflare R2、
AWS S3、MinIO、Backblaze B2、自建端点），笔记里留下一条可迁移的链接，文件本身留在库中作为本地副本。
**渲染读的就是这份副本，不走网络。**

[安装](#安装) · [版本发布](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases) · [反馈问题](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/issues) · 需要 Obsidian **1.13.0+**（[为什么](#环境要求)）

**目录** · [快速开始](#快速开始) · [为什么用它](#为什么用它) · [功能](#功能) · [环境要求](#环境要求) · [安装](#安装) · [设置](#设置) · [命令](#命令) · [需要注意的](#需要注意的) · [隐私与安全](#隐私与安全) · [已验证到什么程度](#已验证到什么程度) · [遇到问题](#遇到问题) · [许可](#许可)

![演示：往笔记里粘贴一张照片、一张图表和一个 PDF —— 各自上传到你的存储，笔记里各留一条链接；一条命令打开附件管理，筛选胶囊自带件数，勾上几行按钮就说明能作用于几件；随后把存储整个停掉，三件照常显示](https://raw.githubusercontent.com/udarent/obsidian-plugins-attachment-cloud-cache/main/docs/demo.gif)

*粘贴照片、图表和 PDF —— 各自上传，笔记里的链接被改写成远端地址；文件本身留在库里（**它就是本地副本**）。接着用**一条命令**打开「附件管理」：一张表管全库附件，筛选胶囊上就是件数，勾几行、按钮上的数字就是真正能作用于几件。把存储下线（就当断网）之后，三件照常显示 —— 画面上就是库里那几份副本。演示用的是临时库和本机 mock 存储。*

## 快速开始

1. **填好存储连接** —— 服务地址、存储桶、区域，以及一对密钥（也可以直接用 MinIO 的凭据文件导入）。
2. **点「测试连接」** —— 绿灯「公开访问」或蓝灯「私有访问」都表示可以用了。
3. **往笔记里粘贴一个文件** —— 它会上传、链接会被改写，文件留在库中作为本地副本。

## 为什么用它

只会上传的插件一断网就让笔记裂图；只会「本地化」的插件得先联网一次才管用。本插件两件都做 —— 文件进你的桶，
负责渲染的副本留在本地。

|  | 只上传 | 只本地化 | 本插件 |
| --- | --- | --- | --- |
| 断网时 | 打不开 | 联网一次之后可用 | **可用 —— 渲染走本地副本** |
| 换新设备 | 在线能看 | 得把所有文件重下一遍 | **副本按需自动补回** |
| vault 体积 | 小 | 每存一个文件就大一分 | **小 —— 副本是可丢弃的** |
| 原件归谁 | 第三方 | 归你，但只在本机 | **归你，在你自己的存储里** |

## 功能

- **任何 S3 兼容存储，任何类型的附件** —— 图片、音频、视频、PDF、压缩包、文档、没有扩展名的文件。
  Obsidian 能预览的插入为嵌入，其余插入为可点开的普通链接。
- **附件管理（一个弹窗管全库）** —— 六列表格（名称 / 位置 / 状态 / 引用 / 大小 / 操作）＋ 带件数的筛选胶囊
  ＋ 勾选后批量处理（上传 / 删除本地 / 改为本地引用 / 删除云端）；重命名只对单条生效。
- **附件怎么进来都行** —— 粘贴、拖入、手机相册或相机、分享到 Obsidian、从别处拷进库。
- **它会告诉你桶到底允许什么** —— 「测试连接」旁边一盏状态灯（公开 / 私有 / 连不上），可随时重测；
  不会为这件事改写任何一条链接。
- **同一个文件传两次只存一份** —— 对象 key 是文件名 + 完整内容哈希：一个地址、链接里用原名，
  多出来的那份本地副本会被清掉。
- **离线、多设备** —— 渲染走本地副本，换新设备时副本按需补回。画布引用同等算数，
  存量附件也能用一条命令搬完。
- **云端清理** —— 列出「本库上传过、已经没有笔记引用」的附件，只删你确认过的。
- **两个可选功能，默认都关** —— 站外文件按普通附件处理（可配站点名单）；本地副本上限
  （超限时按最久没用过的顺序清理）。

## 环境要求

- **Obsidian 1.13.0 或更新**，桌面端与移动端。
- **一个你自己控制的 S3 兼容存储桶**，以及一对访问密钥。
- **存储桶不必是公开的。** 只有当你把链接粘到别处时，公开读取才有意义；否则插件用你的密钥取回、
  靠本地副本显示。**测试连接** 会告诉你属于哪种情形。

## 安装

**在 Obsidian 里装：** 设置 → 第三方插件 → 浏览 → 搜 `Attachment Cloud Cache` → 安装并启用。

**手动安装：** 从[最新 release](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases/latest)
下载 `main.js`、`manifest.json`、`styles.css`，放进 `<vault>/.obsidian/plugins/attachment-cloud-cache/`
（⚠️ 目录名必须等于插件 id）。

## 设置

在 **设置 → Attachment Cloud Cache** 里（英文名见本文英文半）：

| 分组 | 设置项 | 说明 |
| --- | --- | --- |
| **存储连接** | **服务地址 · 存储桶 · 区域** | 你的存储在哪。存储桶名区分大小写；自建服务一般填 `us-east-1` 之类的占位值。 |
| | **访问密钥 ID · 秘密访问密钥** | 秘密密钥进系统钥匙串，绝不写进 `data.json`；**从凭据文件导入**会用 MinIO 的 JSON 填好这几栏。 |
| | **兼容模式** | Cloudflare R2、MinIO 与多数自建服务都要开着。 |
| | **公开链接地址（可选）** | 留空就用 `服务地址/存储桶/键`；用 CDN 或自己的域名时填这里。 |
| | **测试连接** | 一盏**状态灯**（检测中 / 公开 / 私有 / 无法访问）＋一个按钮：重测上传、读回、删除与「链接对外」，什么都不留，也**绝不改写**任何一条链接。 |
| **上传** | **新附件自动上传** | 默认开启；关闭后新文件只存在本地。 |
| | **站外文件也上传到云端** | 默认关闭；站点名单只筛**自动**那一路，手动挑选不受限制。 |
| | **同时上传本机文件** | 默认关闭、仅桌面：「上传全部附件」会按笔记里写的 `file:///` 路径去读这台电脑上的文件。 |
| | **上传全部附件** | 「把链接改回本地路径」的**反向**：一次确认，没有清单、不用勾选。 |
| | **把链接改回本地路径** | 把笔记里的链接改回指向库里的文件。**什么都不删**；没有副本的那些继续指向你的存储。 |
| **离线与本地副本** | **上传后如何处理本地副本** | **保留**（默认，可离线查看）或**上传后删掉**（省空间；离线看不到，PDF 也需要副本）。选「上传后删掉」时，「上传全部附件」会在传完后把已上传文件的本地副本一并清掉。 |
| | **自动下载缺失的本地副本** | 这台设备上还没有的云端文件会自动取回。选「不留副本」时不自动下载 —— 但桶不公开时始终会取回。 |
| | **本地副本上限（MB）· 占用空间** | `0` 表示不限制；超限时先删最久没用过的，且确认存储里还有那个对象才删。下面一行显示副本现在占了多少。 |
| **云端清理** | **附件不再被引用时** | 弹窗让我选（默认）/ 只给一条通知 / 什么都不做。清理永远需要你确认。 |
| **记录与排障** | **删除记录 · 排障日志** | 每次永久删除云端对象都会记一笔（那是事后唯一的记录）；排障日志把每个阶段的计数与耗时打进控制台，不改变任何行为。 |

## 命令

| 命令 | 做什么 |
| --- | --- |
| **附件管理** | **唯一的命令**。打开一个弹窗（桌面宽窗口、手机上是全屏）：一张**多列表格**（名称 / 位置 / 状态 / 引用 / 大小 / 操作）＋ 筛选（待清理 / 未上传 / 已上传 / 云端有本地无 / 没人引用，每个筛选上都写着有几项）＋ 勾选后批量处理（上传 / 删除本地 / 改为本地引用 / 删除云端）；重命名只对单条生效。**跑完会自己关掉**，结果用一条通知告诉你成了几个、跳过几个、失败几个。 |

 > **从 1.8 及更早版本升级**：原来那两条命令（**上传附件** / **清理附件**）已经取消，它们的能力变成 **附件管理** 里的筛选与动作。如果你给它们绑过快捷键，需要重绑到「附件管理」。

## 需要注意的

- **删掉的本地副本，下次打开笔记时会自己补回来**，用**原来的文件名**。前提是插件认得出那条链接是你自己的存储：
  **改过存储地址之后**，改动**之前**写下的链接在新设备上照常在线显示，但离线不显示、也不会被自动下载。
- **同一个文件只存一份** —— 可能被多篇笔记、多台设备共用；云端删除无法撤销，而清理只能看到**本设备**的引用。
- **`tiff`、`heic`、`ico` 插入的是普通链接** —— 宿主无法在嵌入里预览它们。
- **拖放文件的链接插在光标处，不是指针落点** —— 公开 API 里没有「指针坐标 → 编辑器位置」的映射。有意取舍。
- **本地副本索引会自愈** —— 启动后不久、以及之后定期摘掉指向「文件已经不在了」的记录；只改索引、绝不碰文件。
- **换设备：复制插件目录，但先删掉 `.cache-index.json`** —— 它记的是**这台设备**的副本在哪。秘密密钥根本不在目录里。

**常见故障**

| 现象 | 含义 |
| --- | --- |
| 社区目录说 *No appropriate version found.* | 你的 Obsidian 低于 1.13.0 —— 安装机制在拒绝，不是插件坏了。 |
| 链接自己打得开、别人打不开 | 连接状态是**私有访问**：桶拒绝匿名读。**测试连接** 会说明。 |
| 换台设备就裂 | 那台设备没有本地副本，也补不下来。 |
| 站外文件被以「返回的是网页或纯文本」拒收 | 那个地址回的是 HTML，所以刻意拒收。 |
| **测试连接** 说存储拒绝了写入 | 这把密钥能读不能写 —— 上传也会同样失败。 |
| **测试连接** 说那个地址「回的是一个网页」 | 代理、WAF 或兜底页对你的对象路径回了 `200`。这**不是**公开访问 —— 去改公开链接地址。 |

## 隐私与安全

- **默认只连你自己的存储** —— 不含遥测、统计。会伸到库外的只有两件事，而且都默认关闭：
  下面那个可选的站外功能（同一个开关也决定「上传全部附件」要不要碰站外图），
  以及「同时上传本机文件」那个开关（允许它按笔记里写的绝对路径读这台电脑）。打开任何一个就是同意。
- **有一个可选功能会访问其它站点，而且它不会自己启动** —— 默认关闭，打开它就是同意，站点名单再把范围收窄；
  请求里除文件地址本身不带任何其它内容。
- **网页永远不会被存下来** —— `text/html` 与其它 `text/*` 一律拒收，而不是传上去。
- **秘密访问密钥存在系统钥匙串里**，绝不写进 `data.json`；访问密钥 ID 会明文写进去 —— 它是标识符，不是秘密。
  文件名是对象 key 的一部分，所以会出现在你的存储服务商那边。

## 已验证到什么程度

- **自动化：** 覆盖签名、key 与路径推导、设置、本地副本索引、上传链路（字节一致、恰好 1 次 PUT、0 次 GET）、
  粘贴/拖放判定、画布改写，以及每一个连接状态 —— 之后还有一道**变异验证**：把每条规则故意改坏，
  并要求套件因**那条规则自己的原因**失败。
- **真实 Obsidian 1.14.5（Windows）、真实 MinIO：** 格式矩阵（图片、音频、视频、PDF、压缩包）逐项核对到上传字节；
  画布两类节点；离线预览；一次完整回环 —— 链接**匿名**能打开。把桶**先私有、再公开**各验一遍
  （每边 12 项）：状态灯分别落在「私有访问」/「公开访问」、连点五次「测试连接」结论一致且桶里不留东西；
  另外签名地址回 200 而同一地址不带签名回 403。
- **真机界面脚本：** 一个 CDP 脚本驱动**真实 Obsidian**：造数据 → 开弹窗 → 读真实 DOM → 逐条断言 → 删数据还原。
  它验 38 项（命令只有一条、筛选胶囊的件数＝点开后的行数、表头一行且全选在首格、三态全选、六列、按钮数字＝
  能作用的件数、失效行的图标与灰勾、跑完自动收窗），另有 18 项在**真上传**之后核对（括号文件名、重修零上传、
  「已存在」与「已上传」分开报）。它**不点确认**，所以不会动你的库或你的桶。
- **手机：** Android，验证到 1.1.2 —— ⚠️ **移动端此后没有再做真机回归**，请在手机上先小范围试。

存储侧的检查可用 `npm run verify:real-storage` 复现，连接探测用
`node scripts/verify-connection-probe.mjs`。

## 故障排查

先看 **设置 → Attachment Cloud Cache → 测试连接**：那盏状态灯回答的是「这个库连得上你的存储吗、别人打得开我的链接吗」，
全程不改任何东西。

| 你看到的 | 通常是什么 | 怎么办 |
|---|---|---|
| 图一直空着，控制台有 `403` | 桶是**私有**的，而笔记里写的是直链 | 不用修：私有桶下插件保留本地副本并用它显示 |
| 图空着，**且**状态灯是「无法访问」 | 服务地址 / 桶名 / 密钥 | 重跑一次「测试连接」，再核对地址（有些服务商要求把区域写进地址里） |
| 确认框说有几个本机文件「已经不在这台电脑上」 | 那些 `file:///…` 指向的文件被删或挪走了（临时目录经常这样） | 它们会被跳过。去笔记里把那几条链接改掉 —— 插件不会去传一个读不到的文件 |
| 点了命令像没反应 | 两种已知原因：还没配置存储（它会说），或者库里有一篇笔记**读不到** | 清理命令在这种情况会**故意**取消 —— 它不会把「不知道」当成「没人引用」 |
| 换设备之后图不显示 | 索引记的是**那台设备**上的路径 | 复制插件目录时**不要**带 `.cache-index.json`（见上面「需要注意的」） |
| 某次下载像卡住了 | 请求现在有上限（下载 60 秒），而且那个对象下次还能重试 | 若仍然卡住，带控制台日志提 issue |

## 升级 / 迁移

- **1.2.0 改了副本的位置**：不再有「缓存目录」，副本就是附件目录里那份文件。不需要迁移 —— 第一次显示时会登记。
- **命令面板只剩一条**：`上传笔记引用的文件…`、`上传站外或本机文件…`、`挑选要缓存的外链…`、`上传附件`、
  `清理附件` 都不在了。现在只有 **「附件管理」**：上传与清理是它那张表里的筛选与批量动作，逐行清单也在那里
  （「待清理」筛选给的就是过去清理命令列的那批候选）。想把整个库一次传上去，用设置页的
  **「上传全部附件」**（一次确认，没有清单）。
- ⚠️ **快捷键绑的是命令 id**，而这次 id 变了 —— 绑在旧命令上的快捷键会失效，需要重绑到「附件管理」。
- 设置只增不减：新键有默认值，旧版本留下的未知键会被忽略。

## 遇到问题

到 <https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/issues> 提 issue —— 请说清你看到的、你的
Obsidian 版本和用的哪家存储；插件的报错都写明了失败在哪一步。
想改插件本身？`npm install`，然后 `npm run dev`（监听构建）或 `npm test`（构建 + 全部套件）。欢迎提 issue 与 PR。

## 许可

MIT —— 见 [LICENSE](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/blob/main/LICENSE)。
可以用、可以改、可以再分发（商用也行）；保留版权声明即可。