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
  set a public URL prefix). If it is just for you, keep the bucket private: the plugin fetches objects with your keys
  and shows local copies — those links then only open where the plugin and your keys are. **Test connection** reports
  which of the two you have, and which path the plugin takes.

## Installation

**From Obsidian:** Settings → Community plugins → Browse → search `Attachment Cloud Cache` → Install → Enable.

**Manually:** put `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases/latest) into
`<vault>/.obsidian/plugins/attachment-cloud-cache/` (⚠️ the folder name must equal the plugin id).

## Settings

In **Settings → Attachment Cloud Cache** (Chinese names in the [中文版](#attachment-cloud-cache附件云端缓存) below):

| Setting | What it does |
| --- | --- |
| **Endpoint · Bucket · Region** | Where your storage lives (`us-east-1` is the usual filler for self-hosted). |
| **Access key ID · Secret access key** | The secret goes into the OS keychain, never `data.json`. **Import from a credentials file** fills these in from MinIO's JSON and keeps no copy. |
| **Public URL prefix** | Optional. Empty means links use `endpoint/bucket/key`; those only work for other people if the bucket allows anonymous reads (see the row below). |
| **Who can open the links in your notes** | **Automatic (detect)** by default — the plugin probes your storage once and picks a path; **Public read** if you want links to keep working after you paste them elsewhere, **Internal access only** to keep the bucket private (links then open only with this plugin and your keys). Detection that fails or times out is treated as *internal*, so images are still fetched instead of turning into broken images. Switching this **never rewrites a link in your notes** — the URL stays byte-identical, and nothing is moved or deleted in your bucket. |
| **Test connection** | One signed request, then one **credential-free** request to the address your links would use. The second half needs one **real object** to point at: in a brand-new vault nothing has been uploaded yet, so it says there is no link to check — upload one file and test again. The first half (keys + bucket) works from the start. |
| **Upload new attachments automatically** | On by default; off leaves new files local only. |
| **Where the local copy goes** | **Keep the file where it is (offline works)** (default) or **Delete the local file after uploading (offline unavailable)**. With the second, uploads and link rewriting still happen, but nothing is fetched back, so **nothing works offline**. If your bucket is not publicly readable, that mode still shows **images, audio and video**: the renderer gets a **short-lived signed URL** instead (plain image-host behaviour — nothing on disk, nothing cached offline). PDFs still need a local copy, since the built-in viewer only opens vault files. |
| **Free up local space** | Clears local copies of attachments still linked from a note — deleted **for good, not trashed**, so the space comes back at once. With a limit set it trims down **to that limit** only; copies no note links to are left to the unreferenced-attachment cleanup (they may need removing from your storage too). |
| **Revert links to local paths** | Points note links back at the files in your vault instead of your storage. **Nothing is deleted** — cloud objects and local files stay as they are; only the links change. Uploaded files that no longer have a local copy are left pointing at your storage (rewriting them would only make broken links). Use it when you stop using the plugin.
| **Local copy limit (MB) · Download missing copies** | `0` = no limit. Least-recently-used copies are trimmed first, and only after confirming the object is still in your storage. Auto-download stays off while "delete" is selected. |
| **Handle files from other sites like ordinary files** | Off by default. On, an off-site file is downloaded, uploaded and its link rewritten exactly like a local paste — the copy setting included. **Which sites to handle** (`All` / `All except the ones listed` / `Only the ones listed`) filters the **automatic** path only; picking files by hand is never restricted. `example.com` also matches `img.example.com`. |
| **Pick specific files** | Tick individual off-site files; only those are fetched. Works whether or not the switch above is on. **Files outside your vault** (`file:///D:/…`, e.g. a chat-app screenshot) are listed here too, and go through the same chain — desktop only, and only the kinds that can be embedded in a note (image/audio/video/PDF). |
| **When an attachment is no longer linked** | Once an uploaded file loses its last link from any note or canvas: ask (default) / just show a notice / do nothing. Cleanup always needs your explicit confirmation — this only decides whether you are told, and how. |
| **Compatibility mode** | Advanced. Addresses objects as `endpoint/bucket/key`: keep it on for Cloudflare R2, MinIO and most self-hosted services. |

## Commands

| Command | What it does |
| --- | --- |
| **Show local copy usage** | What your local copies hold, and how much of it no note refers to any more — an estimate: nothing is removed before your storage is confirmed to still have the object. |
| **Upload attachments** | Lists what your notes link to (a thumbnail and a tick box per row), then uploads the ticked ones and rewrites those links. Your files stay where they are — that copy *is* the local copy. |
| **Cache external files…** | Lists files that live outside your vault (thumbnails, tick boxes, per-item progress); tick individual ones — on other sites, or on this computer — and only those are fetched. Picking them is the consent. |
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
| Links open for you but not for others | Expected if you chose *Internal access only* (or the bucket refuses anonymous reads). **Test connection** says which it is. |
| Broken on a second device | No local copy there, and it could not download one. |
| An off-site file refused as "a web page or plain text" | That address serves HTML, so it is refused on purpose. |

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
Working on the plugin? `npm install`, then `npm run dev` (watch build) or `npm test` (build + all suites). MIT licensed.

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
  能看，**测试连接** 会如实报出这两者的差别。

## 安装

**在 Obsidian 里装：** 设置 → 第三方插件 → 浏览 → 搜 `Attachment Cloud Cache` → 安装并启用。

**手动安装：** 从[最新 release](https://github.com/udarent/obsidian-plugins-attachment-cloud-cache/releases/latest)
下载 `main.js`、`manifest.json`、`styles.css`，放进 `<vault>/.obsidian/plugins/attachment-cloud-cache/`
（⚠️ 目录名必须等于插件 id）。

## 设置

在 **设置 → Attachment Cloud Cache** 里（英文名见本文英文半）：

| 设置项 | 说明 |
| --- | --- |
| **服务地址 · 存储桶 · 区域** | 你的存储在哪（自建服务填 `us-east-1` 之类的占位值即可）。 |
| **访问密钥 ID · 秘密访问密钥** | 秘密密钥进系统钥匙串，绝不写进 `data.json`。**从凭据文件导入**会用 MinIO 的 JSON 填好这些，且不留副本。 |
| **公开访问前缀** | 可留空。留空就用 `服务地址/存储桶/键`；这种链接要给别人打开，桶得允许匿名读取（见下一行）。 |
| **笔记里的链接谁打得开** | 默认**自动（探测后决定）**：插件匿名探一次你的存储，据此选路。**公开读取** = 链接粘到别的平台仍能打开；**仅内部访问** = 桶保持私有，链接只在装了本插件、有密钥的地方能看。探测失败或超时按内部访问处理，所以图照样会被取回、不会变成坏图。切换这一项**不会改写笔记里的任何链接** —— 地址一字不变，桶里也不会搬迁或删除任何东西。 |
| **测试连接** | 先发一次签名请求，再**不带凭据**请求一次「你笔记里会写的那条地址」。后半段得有一个**真实对象**可指：全新库里还没上传过任何东西，它会如实说「没有链接可检查」—— 先传一个文件再测。前半段（密钥 + 桶）随时可用。 |
| **新增附件自动上传** | 默认开启；关闭后新文件只存在本地。 |
| **本地副本的处理** | 留在附件目录（默认，**离线可用**），或**不留本地副本（等于关闭缓存，离线不可用）** —— 后者就是上传后把那份文件删掉：照常上传、照常改写链接，但不取回副本，所以**离线什么都看不到**。⚠️ 若存储不可公开读取，这一档仍然能看**图片、音频与视频**：改给一条**短时签名地址**（就是图床的用法 —— 磁盘不留文件、离线仍看不到）。PDF 仍需本地副本（内置查看器只打开库内文件）。 |
| **释放本地空间** | 清掉笔记里仍引用着的附件本地副本 —— **永久删除、不进回收站**，空间立刻释放。设了上限时只清**到上限为止**（不会全清）；没有任何笔记引用的副本留给「没人引用的附件」那条清理 —— 那些可能要连云端对象一起处理。 |
| **把链接改回本地路径** | 把笔记里的链接改回指向库里那份文件（不再指向你的存储）。**什么都不删** —— 云端对象与本地文件都原样留着，只有链接会变。本地副本已经不在的那些会继续指向你的存储（改回去只会变成坏链）。准备停用这个插件时用它。
| **本地副本上限（MB） · 缺本地副本时自动下载** | `0` 表示不限制。超限时按最近最少使用清理，且只有确认你的存储里仍有那个对象之后才会删。选「删除」时自动下载不生效。 |
| **站外文件按普通附件处理** | 默认关闭。打开后，站外文件会被下载、上传并改写链接 —— 与粘贴一张本地附件完全一样（副本那一档也一样适用）。**处理哪些站点**（`所有站点` / `除名单外` / `仅名单内`）只筛**自动**那一路；手动挑选不受限制。写 `example.com` 也会命中 `img.example.com`。 |
| **挑选要缓存的文件** | 勾选具体的站外文件，只有勾中的会被取。开关关着也能用。**库外的本机文件**（`file:///D:/…`，比如聊天软件的截图）也在这里出现，走同一条链 —— 仅桌面端，且只收能嵌进笔记的那几类（图 / 音 / 视频 / PDF）。 |
| **附件没人引用时** | 某个已上传的附件失去笔记或画布里的最后一条引用之后：弹窗问我（默认）/ 只给一条通知 / 什么都不做。清理永远需要你明确确认 —— 这一项只决定要不要告诉你、用哪种方式。 |
| **兼容模式** | 高级。按「地址/桶/键」寻址：Cloudflare R2、MinIO 与多数自建服务都要开着。 |

## 命令

| 命令 | 做什么 |
| --- | --- |
| **查看本地副本占用** | 本地副本占了多少、其中多少已经没有笔记引用了 —— 这是**估算**：真正删除前会先确认你的存储里仍然有这个对象。 |
| **上传附件** | 列出笔记里引用着的附件（**每条带缩略图与勾选框**），只上传你勾中的那些并改写链接。文件**留在原地** —— 那份就是本地副本。 |
| **缓存外部文件（可挑选）…** | 列出**库外**的文件（缩略图 + 勾选框 + 逐项进度）：别处服务器上的、或你这台电脑上的，勾中的才会被取回 —— 勾选本身就是同意。 |
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
| 链接自己打得开、别人打不开 | 桶不是公开的（或者没填公开前缀）。这是「仅内部访问」的正常表现；想让链接在别处也能打开，见「笔记里的链接谁打得开」。**测试连接** 会明确报出这一条。 |
| 换台设备就裂 | 那台设备没有本地副本，也补不下来。 |
| 站外文件被以「返回的是网页或纯文本」拒收 | 那个地址回的是 HTML，所以刻意拒收。 |

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
想改插件本身？`npm install`，然后 `npm run dev`（监听构建）或 `npm test`（构建 + 全部套件）。MIT 许可。
