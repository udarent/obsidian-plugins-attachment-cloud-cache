<!-- lang:en -->

# Attachment Cloud Cache

<p>
  <a href="https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases"><img alt="release" src="https://img.shields.io/github/v/release/udarent/obsidian-plugins-attachment-cloud-cache?label=release&amp;sort=semver&amp;color=2f6feb" vspace="6"></a>
  <a href="https://obsidian.md"><img alt="Obsidian" src="https://img.shields.io/badge/dynamic/json?logo=obsidian&amp;color=483699&amp;label=Obsidian&amp;query=%24.minAppVersion&amp;url=https%3A%2F%2Fraw.githubusercontent.com%2Fudarent%2Fobsidian-plugins-attachment-cloud-cache%2Fmain%2Fmanifest.json" vspace="6"></a>
  <a href="https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/blob/main/LICENSE"><img alt="license: MIT" src="https://img.shields.io/github/license/udarent/obsidian-plugins-attachment-cloud-cache?color=97ca00" vspace="6"></a>
</p>

**English** · [简体中文](#attachment-cloud-cache附件云端缓存)

**Your attachments live in your own storage — and still render offline.** Paste a file: it uploads to **your**
S3-compatible bucket (Cloudflare R2, AWS S3, MinIO, Backblaze B2, self-hosted), the note keeps a portable link, and a
local copy — the file itself — stays in your vault to do the rendering. **Zero remote requests, always.**

[Install](#installation) · [Releases](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases) · [Report a problem](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/issues) · Requires Obsidian **1.13.0+** ([why](#requirements))

**Contents** · [Why](#why-use-it) · [Features](#features) · [Requirements](#requirements) · [Installation](#installation) · [Settings](#settings) · [Commands](#commands) · [Good to know](#good-to-know) · [Privacy](#privacy--security) · [Verification](#how-far-it-is-verified) · [Help](#getting-help) · [License](#license)

![Paste an image, a PDF and an audio clip into a note: each one uploads to your own storage, a copy of each stays in your vault, and all three still render after the storage goes offline](https://raw.githubusercontent.com/udarent/obsidian-plugins-attachment-cloud-cache/main/docs/demo.gif)

*Paste an image, a PDF and an audio clip → each uploads → the note keeps a link, each file stays as its own local copy. Then the storage is stopped, and all three still work.*

## Why use it

Upload-only plugins break your notes the moment you are offline; "localize" plugins only help *after* one online pass.
This does both — the file goes to your bucket, the copy that renders stays behind.

|  | Upload-only | Localize-only | This plugin |
| --- | --- | --- | --- |
| Offline | broken | after one online pass | **works — zero remote requests** |
| A new device | links work online | re-download everything | **copies back-filled on demand** |
| Vault size | small | grows with every file | **small — copies are disposable** |
| Who holds the original | a third party | you, but locally only | **you, in your own storage** |

## Features

- **Any S3-compatible storage, and any attachment type** — images, audio, video, PDF, archives, documents,
  extension-less files.
  What Obsidian can preview becomes an embed; everything else, a clickable link.
- **Any way in** — pasted, dropped, from your phone's gallery or camera, shared into Obsidian, or copied into the vault.
- **It tells you what your bucket actually allows** — public, private or unreachable, as a status light next to
  **Test connection**; re-checked on demand, and not a single link is rewritten for it.
- **The same file twice is one object.** The key is the file name plus its full content hash, so even `photo 1.png`
  beside `photo.png` is one image: one address, the original name in the link text, the extra copy cleaned up.
- **Offline and multi-device** — rendering always uses the local copy, and a new device back-fills copies on demand.
- **Canvas references count too**, and one command bulk-uploads what your notes already link.
- **Cloud cleanup** — lists the objects no note refers to, and deletes only what you confirm.
- **Two optional extras, both off by default** — off-site files treated as ordinary files (with a site list), and a
  local-copy limit that trims least-recently-used copies in the background.

## Requirements

- **Obsidian 1.13.0 or newer**, desktop and mobile.
- **An S3-compatible bucket you control**, plus an access key pair.
- **The bucket does not have to be public.** If you want links pasted elsewhere to open, allow anonymous reads (or
  set a public link address). If it is just for you, keep the bucket private: the plugin fetches objects with your keys
  and shows local copies — those links then only open where the plugin and your keys are. **Test connection** says
  which case you are in; the plugin picks the safe path from there.

## Installation

**From Obsidian:** Settings → Community plugins → Browse → search `Attachment Cloud Cache` → Install → Enable.

**Manually:** put `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases/latest) into
`<vault>/.obsidian/plugins/attachment-cloud-cache/` (⚠️ the folder name must equal the plugin id).

## Settings

In **Settings → Attachment Cloud Cache** (Chinese names in the [中文版](#attachment-cloud-cache附件云端缓存) below):

| Setting | What it does |
| --- | --- |
| **Endpoint · Bucket · Region** | Where your storage lives. The bucket name must match exactly (it is case-sensitive); `us-east-1` is the usual filler for self-hosted. |
| **Access key ID · Secret access key** | The secret goes into the OS keychain, never `data.json`. **Import from a credentials file** fills these in from MinIO's JSON and keeps no copy. |
| **Public link address (optional)** | Empty means a link is `endpoint/bucket/key`; that opens for other people only if the bucket lets anyone read it — the light on **Test connection** says which case you are in. Fill it in for a CDN or your own domain. |
| **Test connection** | A **status light** plus a button. The light shows *checking* / *public* / *private* / *unreachable* — a fact about your bucket, re-detected on every start and never persisted. The button re-checks it end to end (upload, read back, delete, and whether others can open your links) without keeping anything or rewriting a single link. |
| **Upload new attachments automatically** | On by default; off leaves new files local only. |
| **What happens to the local copy** | **Keep it** (default, offline works) or **delete it after uploading** (saves space): uploads and links still happen, but nothing renders offline — images, audio and video still show online, while PDFs need a copy. |
| **Local copy limit (MB) · Download missing local copies automatically** | `0` = no limit. Least-recently-used copies go first, and only after the object is confirmed to still be in your storage; they come back when next viewed. Auto-download is off in delete mode — except it always runs when the bucket is private, or nothing could be shown. |
| **Free up local space** | Deletes local copies of files your notes still link — **permanently, not to the trash**, so the space comes back at once. With a limit it trims only down to that limit. |
| **Revert links to local paths** | Points note links back at the files in your vault. **Nothing is deleted**; files with no local copy keep pointing at your storage. |
| **Upload files linked from other sites** | Off by default. The site list filters the **automatic** path only; picking files by hand is never restricted. |
| **Pick files to upload** | Tick individual files from other sites or from outside the vault (`file:///D:/…`); desktop only, and only the kinds a note can embed. |
| **When an attachment is no longer linked** | Ask (default) / notify / do nothing. Cleanup always needs your confirmation. |
| **Compatibility mode** | Advanced. Addresses objects as `endpoint/bucket/key`; keep it on for Cloudflare R2, MinIO and most self-hosted services. |

## Commands

| Command | What it does |
| --- | --- |
| **Show local copy usage** | What your local copies hold, and how much of it no note refers to any more — an estimate: nothing is removed before your storage is confirmed to still have the object. |
| **Upload attachments** | Lists what your notes link to (a thumbnail and a tick box per row), then uploads the ticked ones and rewrites those links. Your files stay where they are — that copy *is* the local copy. |
| **Upload external files…** | Lists files that live outside your vault (thumbnails, tick boxes, per-item progress); tick individual ones — on other sites, or on this computer — and only those are fetched. Picking them is the consent. |
| **Check for unreferenced attachments in the cloud…** | Everything this vault uploaded, minus everything still linked — a row with a thumbnail and a tick box each. The ticked ones then take your choice: keep them, delete only the local copy (to the trash), or delete the local copy and the stored object. Also how you re-run the automatic prompt if you dismissed it. |

## Good to know

- **A lost local copy comes back when you next view the note**, under its original file name. This needs the link to be
  recognised as yours: after you change the storage URL, links written *before* the change still work online on a new
  device, but never render offline and are never downloaded automatically.
- **Uploading one file twice stores one object**, so an object can be shared by several notes and devices — and a
  storage deletion cannot be undone. Cleanup sees **this device's** references only, and always asks first.
- **`tiff`, `heic` and `ico` are inserted as plain links, not embeds** — Obsidian cannot preview them in an embed, so a
  remote `![]()` would be a broken image.
- **A dropped file's link lands at the caret, not at the pointer** — no public API maps pointer coordinates to an
  editor position. Deliberate.
- **The local-copy index repairs itself** shortly after startup and periodically afterwards — it only ever edits the
  index, never a file.
- **Moving to another device: copy the plugin folder, but delete `.cache-index.json` first** — it records where *this*
  device keeps its copies. The secret access key is not in the folder at all.

**Common failures**

| Symptom | What it means |
| --- | --- |
| *No appropriate version found.* | Your Obsidian is older than 1.13.0 — the installer refusing, not a broken plugin. |
| Links open for you but not for others | Expected when the connection status is *private* (the bucket refuses anonymous reads). **Test connection** says which it is. |
| Broken on a second device | No local copy there, and it could not download one. |
| An off-site file refused as "a web page or plain text" | That address serves HTML, so it is refused on purpose. |
| *Test connection* says the storage refused to write | The keys can read but not write — uploads will fail the same way. Give them write permission on the bucket. |
| *Test connection* says the address "answered with a web page" | A proxy, a WAF or a catch-all page answered `200` for a path that is not your file. That is **not** public access — fix the public link address (it probably points somewhere else). |

## Privacy & security

- **It normally talks only to your storage** — no telemetry, no analytics, no requests outside your vault. ⚠️ The one
  exception is a **file outside your vault that you tick yourself** in "Pick specific files": reading it is something
  you asked for.
- **One optional feature reaches other sites, and it never turns itself on** — off by default; turning it on is the
  consent, and the site list narrows it further. The request carries nothing beyond the file's own address.
- **A web page is never stored** — `text/html` and other `text/*` answers are refused rather than uploaded.
- **The secret access key lives in the OS keychain**, never in `data.json`; the access key ID *is* written there (an
  identifier, and Obsidian's keychain accepts only lowercase IDs). File names are part of each object's key, so they
  show up in your storage provider's logs.

## How far it is verified

- **Automated tests** cover signing, key and path derivation, settings merging, the index, the upload chain
  (byte-identical, one PUT, zero GETs), paste/drop decisions and canvas rewriting — then a **mutation check** breaks
  each rule on purpose. An assertion that cannot fail is not an assertion.
- **Real Obsidian, real MinIO:** eight file types checked down to the uploaded bytes, both canvas node kinds, offline
  audio/video/PDF with the remote address never reaching an element, both cleanup entry points, and a full round trip
  whose link opens **anonymously**. Reproduce: `npm run verify:real-storage`.
- **Real phone:** Android has been run on a real device — the fixes for adding the same image twice came out of it.
  **Not verified:** iOS never ran on a device; non-ASCII object keys are tested but not run against a real provider.

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
AWS S3、MinIO、Backblaze B2、自建端点），笔记里留下一条可迁移的链接，渲染走**本地副本**（就是那份文件本身）。
**始终零远端请求。**

[安装](#安装) · [版本发布](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases) · [反馈问题](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/issues) · 需要 Obsidian **1.13.0+**（[为什么](#环境要求)）

**目录** · [为什么用它](#为什么用它) · [功能](#功能) · [环境要求](#环境要求) · [安装](#安装) · [设置](#设置) · [命令](#命令) · [需要注意的](#需要注意的) · [隐私与安全](#隐私与安全) · [已验证到什么程度](#已验证到什么程度) · [遇到问题](#遇到问题) · [许可](#许可)

![演示：往笔记里粘贴一张图片、一个 PDF 和一段音频 —— 它们各自上传到你的存储，文件留在库中作为本地副本；随后把存储整个停掉，三者仍然正常显示与播放](https://raw.githubusercontent.com/udarent/obsidian-plugins-attachment-cloud-cache/main/docs/demo.gif)

*粘贴图片、PDF 和音频 → 各自上传 → 笔记里各留一条链接，文件留在库中作为本地副本。随后把**存储整个停掉**，三者照常工作。*

## 为什么用它

只会上传的插件一断网就让笔记裂图；只会「本地化」的插件得先联网一次才管用。本插件两件都做 —— 文件进你的桶，
负责渲染的副本留在本地。

|  | 只上传 | 只本地化 | 本插件 |
| --- | --- | --- | --- |
| 断网时 | 打不开 | 联网一次之后可用 | **可用 —— 零远端请求** |
| 换新设备 | 在线能看 | 得把所有文件重下一遍 | **副本按需自动补回** |
| vault 体积 | 小 | 每存一个文件就大一分 | **小 —— 副本是可丢弃的** |
| 原件归谁 | 第三方 | 归你，但只在本机 | **归你，在你自己的存储里** |

## 功能

- **任何 S3 兼容存储，任何类型的附件** —— 图片、音频、视频、PDF、压缩包、文档、没有扩展名的文件。Obsidian 能
  预览的插入为嵌入，其余插入为可点开的普通链接。
- **附件怎么进来都行** —— 粘贴、拖入、手机相册或相机、分享到 Obsidian、从别处拷进库。
- **它会告诉你桶到底允许什么** —— 公开、私有还是连不上，「测试连接」旁边那盏灯一眼可见；可随时重测，
  而且不会为这件事改写任何一条链接。
- **同一个文件传两次只存一份。** 对象 key 里带文件名 + 完整内容哈希，所以哪怕 Obsidian 只能把新来的另存成
  `照片 1.png`，两份也认得出是同一张：一个地址、链接文字用原名、多出来的本地副本会被清掉。
- **离线、多设备** —— 渲染始终走本地副本，换新设备时副本按需补回。**副本就是你已经有的那份文件**。
- **画布引用同等算数**；存量附件一条命令搬完（只处理笔记引用着的文件）。
- **云端空间清理** —— 列出「本库没有笔记引用」的对象，只删你确认过的。
- **两个可选功能，默认都关** —— 站外文件按普通附件处理（可配站点名单）；本地副本上限（超限时后台按最近最少
  使用清理）。

## 环境要求

- **Obsidian 1.13.0 或更新**，桌面端与移动端。
- **一个你自己控制的 S3 兼容存储桶**，以及一对访问密钥。
- **存储桶不必是公开的。** 想让笔记里的链接粘到别的平台也能打开，就把桶设为允许匿名读取（或填一个公开访问
  前缀）。只想自己看也没问题：插件会用你的密钥取回对象、靠本地副本显示 —— 那种情况下链接只在装了本插件的地方
  能看；**测试连接** 会告诉你属于哪种情形，显示路径由它决定。

## 安装

**在 Obsidian 里装：** 设置 → 第三方插件 → 浏览 → 搜 `Attachment Cloud Cache` → 安装并启用。

**手动安装：** 从[最新 release](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases/latest)
下载 `main.js`、`manifest.json`、`styles.css`，放进 `<vault>/.obsidian/plugins/attachment-cloud-cache/`
（⚠️ 目录名必须等于插件 id）。

## 设置

在 **设置 → Attachment Cloud Cache** 里（英文名见本文英文半）：

| 设置项 | 说明 |
| --- | --- |
| **服务地址 · 存储桶 · 区域** | 你的存储在哪。存储桶名称必须完全一致（区分大小写）；自建服务一般填 `us-east-1` 之类的占位值。 |
| **访问密钥 ID · 秘密访问密钥** | 秘密密钥进系统钥匙串，绝不写进 `data.json`。**从凭据文件导入**会用 MinIO 的 JSON 填好这几栏，且不留副本。 |
| **公开链接地址（可选）** | 留空就用 `服务地址/存储桶/键`；这种链接要给别人打开，桶得允许任何人读取 —— 「测试连接」旁边那盏灯会告诉你属于哪种情形。用 CDN 或自己的域名时填这里。 |
| **测试连接** | 一盏**状态灯** ＋ 一个按钮。灯是**检测中 / 公开访问 / 私有访问 / 无法访问** —— 这是测出来的**事实，不是设置项**：每次启动重新测、从不落盘。按钮会把这件事端到端重测一遍（上传、读回、删除，以及别人能不能打开你的链接），什么都不留，也**绝不改写**任何一条链接。 |
| **新附件自动上传** | 默认开启；关闭后新文件只存在本地。 |
| **上传后如何处理本地副本** | **保留**（默认，可离线查看），或**上传后删掉**（省空间）：照常上传、照常改写链接，但离线什么都看不到 —— 图片、音频、视频仍能在线显示，PDF 仍需副本。 |
| **本地副本上限（MB） · 自动下载缺失的本地副本** | `0` 表示不限制。超限时按最久没用过的顺序清理，且确认存储里还有那个对象才删；下次看图会自动补回。选「不留副本」时自动下载不生效 —— 但桶不公开时始终会取回，否则什么都显示不出来。 |
| **释放本地空间** | 清掉笔记仍引用着的附件的本地副本 —— **永久删除、不进回收站**，空间立刻释放。设了上限时只清到上限为止。 |
| **把链接改回本地路径** | 把笔记里的链接改回指向库里那份文件。**什么都不删**；没有本地副本的那些继续指向你的存储。 |
| **站外文件也上传到云端** | 默认关闭。站点名单只筛**自动**那一路；手动挑选不受限制。 |
| **手动选择要上传的文件** | 勾选具体的站外文件或库外本机文件（`file:///D:/…`）；仅桌面端，且只收能嵌进笔记的那几类。 |
| **附件不再被引用时** | 弹窗让我选（默认）/ 只给一条通知 / 什么都不做。清理永远需要你明确确认。 |
| **兼容模式** | 高级。按「地址/桶/键」寻址；Cloudflare R2、MinIO 与多数自建服务都要开着。 |

## 命令

| 命令 | 做什么 |
| --- | --- |
| **查看本地副本占用** | 本地副本占了多少、其中多少已经没有笔记引用了 —— 这是**估算**：真正删除前会先确认你的存储里仍然有这个对象。 |
| **上传附件** | 列出笔记里引用着的附件（**每条带缩略图与勾选框**），只上传你勾中的那些并改写链接。文件**留在原地** —— 那份就是本地副本。 |
| **上传外部文件…** | 列出**库外**的文件（缩略图 + 勾选框 + 逐项进度）：别处服务器上的、或你这台电脑上的，勾中的才会被取回 —— 勾选本身就是同意。 |
| **检查未被引用的云端附件…** | 候选 = 本库上传过的、减去仍被笔记或画布引用的 —— 每条带缩略图与勾选框。勾中的按你选的那一档处理：保留 / 只删本地副本（进回收站）/ 连本地带云端一起删。那次自动询问被误关之后，也从这里重新要一次。 |

## 需要注意的

- **删掉的本地副本，下次打开笔记时会自己补回来**，用**原来的文件名**。前提是插件认得出那条链接是你自己的存储：
  **改过存储地址之后**，改动**之前**写下的链接在新设备上照常在线显示，但离线不显示、也不会被自动下载。
- **同一个文件传两次只存一份** —— 一个对象可能被多篇笔记、多台设备共用，而云端删除无法撤销。清理只能看到
  **本设备**的引用，且永远先问你一次。
- **`tiff`、`heic`、`ico` 插入的是普通链接，不是嵌入** —— 宿主无法在嵌入里预览它们，写 `![]()` 只会得到一个坏图。
- **拖放文件的链接插在光标处，不是指针落点** —— 公开 API 里没有「指针坐标 → 编辑器位置」的映射。有意取舍。
- **本地副本索引会自愈** —— 启动后不久、以及之后定期摘掉指向「文件已经不在了」的记录；**只改索引、绝不碰文件**。
- **换设备：把插件目录复制过去，但先删掉 `.cache-index.json`** —— 它记的是**这台设备**的副本在哪。秘密访问密钥根本不在目录里。

**常见故障**

| 现象 | 含义 |
| --- | --- |
| 社区目录说 *No appropriate version found.* | 你的 Obsidian 低于 1.13.0 —— 安装机制在拒绝，不是插件坏了。 |
| 链接自己打得开、别人打不开 | 连接状态是**私有访问**时的正常表现（桶拒绝匿名读，或者没填公开前缀）。想让链接在别处也能打开，就去存储那边开匿名读或配公开前缀；**测试连接** 会明确报出这一条。 |
| 换台设备就裂 | 那台设备没有本地副本，也补不下来。 |
| 站外文件被以「返回的是网页或纯文本」拒收 | 那个地址回的是 HTML，所以刻意拒收。 |
| **测试连接** 说存储拒绝了写入 | 这把密钥能读不能写 —— 上传也会同样失败。给它桶的写权限。 |
| **测试连接** 说那个地址「回的是一个网页」 | 代理、WAF 或兜底页对你的对象路径回了 `200`。这**不是**公开访问 —— 去改公开链接地址（多半指到别处了）。 |

## 隐私与安全

- **默认只连你自己的存储** —— 不含遥测、统计，也不会向 vault 之外发请求。⚠️ 唯一例外是**你自己在「挑选要缓存的文件」里勾中**的库外本机文件（例如 `file:///D:/…` 的截图）：读它是你要求的动作。
- **有一个可选功能会访问其它站点，而且它不会自己启动** —— 默认关闭，打开它就是同意，站点名单再把范围收窄；
  请求里除文件地址本身不带任何其它内容。
- **网页永远不会被存下来** —— `text/html` 与其它 `text/*` 一律拒收，而不是传上去。
- **秘密访问密钥存在系统钥匙串里**，绝不写进 `data.json`；**访问密钥 ID 会**写进去（它是标识符，而且 Obsidian
  的钥匙串只接受小写 ID）。文件名是对象 key 的一部分，所以会出现在你的存储服务商那边。

## 已验证到什么程度

- **自动化测试**覆盖签名、key 与路径推导、设置合并、本地副本索引、上传链路（字节一致、恰好 1 次 PUT、0 次 GET）、
  粘贴/拖放判定与画布改写 —— 之后还有一道**变异验证**：把每条规则故意改坏。不会失败的断言等于没有断言。
- **真实 Obsidian、真实 MinIO：** 八种类型的文件逐项核对到上传字节；画布两类节点；音频、视频、PDF 离线预览，
  且**远端地址从未落进任何元素**；云端清理两条入口；一次完整回环 —— 链接**匿名**能打开。
  可用 `npm run verify:real-storage` 复现。
- **真手机：** Android 已在真机上跑过 —— 重复添加同一张图的修复就是它逼出来的。
  **未验证：** iOS 从未在真机上跑过；含非 ASCII 字符的对象 key 有测试，但没在真实服务商上跑过。

## 遇到问题

到 <https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/issues> 提 issue —— 请说清你看到的、你的
Obsidian 版本和用的哪家存储；插件的报错都写明了失败在哪一步。
想改插件本身？`npm install`，然后 `npm run dev`（监听构建）或 `npm test`（构建 + 全部套件）。欢迎提 issue 与 PR。

## 许可

MIT —— 见 [LICENSE](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/blob/main/LICENSE)。
可以用、可以改、可以再分发（商用也行）；保留版权声明即可。
