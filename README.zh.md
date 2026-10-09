# 中文说明已并入 README.md

中文全文现在与英文放在**同一个文件**里 —— 因为 Obsidian 的插件市场页只读 `README.md`
这一个文件名、不会按界面语言切换（从 `obsidian.asar` 里反解出来的取件逻辑就是
`raw.githubusercontent.com/<仓库>/HEAD/README.md`，文件名硬编码、零语言参数）。

👉 **[前往 README.md 的中文版](./README.md#attachment-cloud-cache附件云端缓存)**

这个文件保留下来只是**指路牌**，免得指向它的老链接 404。护栏 `npm run check:readme`
会盯着它：一旦有人把中文全文写回这里（或让它长出 `##` 章节），检查就变红。
