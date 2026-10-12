import { runMutations } from "./lib/mutate.mjs";
import { runExternalCacheSuite } from "./lib/external-cache-suite.mjs";

/**
 * 变异验证：站外文件搬进自己存储（`src/core/external-cache.ts`）。
 *
 * 每一条打掉的都是"不报错但会害人"的行为。其中三条后果最重，值得单独说明：
 * - 不拦回环地址 ⇒ 笔记里一条链接就能让插件去请求 `127.0.0.1`（别人机器上的探测原语）；
 * - 改写失败却报成功 ⇒ 用户以为搬好了，笔记其实还指向站外，而下次不会再问；
 * - 读不到原文却不早退 ⇒ 后面 `modify` 会把笔记**整文件覆盖**（用户丢的是笔记）。
 *
 * ⚠️ 1.2.0 起执行器**不再复核功能开关**（那个开关只管自动那一路；显式工具的同意
 * 来自"用户勾了它"），也**不再对站外破例保留本地副本** —— 所以那两条锚点随之删除，
 * 换成"别把破例加回来"这一条。
 */
await runMutations({
	source: "src/core/external-cache.ts",
	entries: ["src/core/external-cache", "src/s3/client", "src/cache/index"],
	suite: runExternalCacheSuite,
	mutations: [
		{
			// 后果：笔记里一条 `http://127.0.0.1/...` 就能让插件去请求本机（或云元数据端点）。
			name: "★ 不再拦回环/链路本地地址（把内网探测发出去）",
			from: '\t\tif ((deps.blockedHost ?? isBlockedHost)(host)) return { ...base, status: "refused" };\n',
			to: "\t\t// 变异：不拦本地地址\n",
			expect: "回环",
		},
		{
			// 后果：图已进存储但链接没改，却报「成功」⇒ 用户以为搬好了，
			// 而笔记仍指向站外。半成品被伪装成完成品，也没有任何提示。
			name: "★ 改写失败却报告成功（半成品被伪装成完成品）",
			from: '\t\t\tsay("cached-no-rewrite", { error: describeError(error) });\n\t\t\treturn { ...uploaded, status: "cached-no-rewrite", error };',
			to: '\t\t\treturn { ...uploaded, status: "cached" };',
			expect: "谎报",
		},
		{
			// 后果：防盗链回的 HTML 页被当成附件上传 ⇒ 用户存储里多了一个网页文件，
			// 笔记里的链接指向它，图还是显示不出来。
			name: "★ 不校验内容类型（把防盗链的 HTML 页当附件传上去）",
			from: '\tif (!isAttachmentResponse({ contentType, url })) {\n\t\treturn { status: "not-attachment", detail: mimeFromContentType(contentType) || "(没有类型头)" };\n\t}\n',
			to: "\t// 变异：不校验内容类型\n",
			expect: "not-attachment",
		},
		{
			// 后果：一条笔记里挂个几 GB 的文件就能把内存打满（`requestUrl` 一次返回整个 body）。
			name: "★ 不校验大小（超大文件照下载照上传）",
			from: '\tif (bytes.byteLength > maxBytes) {\n\t\treturn { status: "too-large", detail: String(bytes.byteLength) };\n\t}\n',
			to: "\t// 变异：不校验大小\n",
			expect: "上限",
		},
		{
			// 后果：读不到原文却继续走 ⇒ 后面 `modify` 会把笔记**整文件覆盖**成空内容。
			// 这是本模块最不能犯的错：用户丢的是笔记。
			name: "★ 读不到原文却不早退（后面会整文件覆盖，可能清空笔记）",
			from: '\t\t} catch (error) {\n\t\t\tsay("no-note", { host });\n\t\t\treturn { ...base, status: "no-note", error };\n\t\t}',
			to: '\t\t} catch {\n\t\t\toriginal = "";\n\t\t}',
			expect: "no-note",
		},
		{
			// 后果：**把 1.2.0 取消的那个破例加回来** —— `localCopy: "trash"` 的用户
			// 手动缓存一张站外图，本地却莫名多出一份副本；而他自己选的就是"库里不留副本"。
			// （这一档本来就是"关闭缓存"，离线可用在那一档里不成立。）
			name: "★ 对站外又破例保留本地副本（trash 档下仍留副本）",
			from: "\t\t\t\tsettings,\n",
			to: '\t\t\t\tsettings: { ...settings, localCopy: "keep" },\n',
			expect: "trash 档下不留本地副本",
		},
		{
			// 后果：本存储的 URL 也走这条链 ⇒ 把自己的图重新下载再上传一遍，
			// 而本该由回退下载静默处理。
			name: "★ 不再拦本存储的 URL（把自己的图下载再传一遍）",
			from: '\t\tif (keyFromUrl(url, settings.s3)) return { ...base, status: "refused" };\n',
			to: "\t\t// 变异：不识别本存储\n",
			expect: "本存储",
		},
	],
});
