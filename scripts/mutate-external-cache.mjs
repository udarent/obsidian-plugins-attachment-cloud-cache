import { runMutations } from "./lib/mutate.mjs";
import { runExternalCacheSuite } from "./lib/external-cache-suite.mjs";

/**
 * 变异验证：站外图搬进自己存储（`src/core/external-cache.ts`）。
 *
 * 每一条打掉的都是"不报错但会害人"的行为。其中三条后果最重，值得单独说明：
 * - 不复核同意 ⇒ **未经同意就下载并上传别人的图**（红线破了）；
 * - 不拦回环地址 ⇒ 笔记里一张图就能让插件去请求 `127.0.0.1`；
 * - 改写失败却报成功 ⇒ 用户以为搬好了，笔记其实还指向站外，而下次不会再问。
 */
await runMutations({
	source: "src/core/external-cache.ts",
	entries: ["src/core/external-cache", "src/s3/client", "src/cache/index"],
	suite: runExternalCacheSuite,
	mutations: [
		{
			// 后果：用户关掉功能后（或在询问与执行之间关掉），**仍然照下载照上传**。
			// 这是红线本身：未获同意前不得把站外字节写进 vault。
			name: "★ 执行期不复核同意（功能关了也照下载照上传）",
			from: '\t\tif (!settings.externalImageCache) return { ...base, status: "refused" };\n',
			to: "\t\t// 变异：不复核开关\n",
			expect: "功能关着",
		},
		{
			// 后果：笔记里一条 `http://127.0.0.1/...` 就能让插件去请求本机（或云元数据端点）。
			name: "★ 不再拦回环/链路本地地址（把内网探测发出去）",
			from: "\t\tif ((deps.blockedHost ?? isBlockedHost)(host)) return { ...base, status: \"refused\" };\n",
			to: "\t\t// 变异：不拦本地地址\n",
			expect: "回环",
		},
		{
			// 后果：图已进存储但链接没改，却报「成功」⇒ 用户以为搬好了，
			// 而笔记仍指向站外，且站点记忆已 allow —— 不会再问第二次。半成品被伪装成完成品。
			name: "★ 改写失败却报告成功（半成品被伪装成完成品）",
			from: '\t\t\tsay("cached-no-rewrite", { error: describe(error) });\n\t\t\treturn { ...uploaded, status: "cached-no-rewrite", error };',
			to: '\t\t\treturn { ...uploaded, status: "cached" };',
			expect: "谎报",
		},
		{
			// 后果：防盗链回的 HTML 页被当成图片上传 ⇒ 用户图床里多了一个网页文件，
			// 笔记里的链接指向它，图还是显示不出来。
			name: "★ 不校验内容类型（把防盗链的 HTML 页当图片传上去）",
			from: "\tif (!isImageResponse({ contentType, url, imageExtensions })) {\n\t\treturn { status: \"not-image\", detail: mimeFromContentType(contentType) || \"(没有类型头)\" };\n\t}\n",
			to: "\t// 变异：不校验内容类型\n",
			expect: "not-image",
		},
		{
			// 后果：一条笔记里挂个几 GB 的文件就能把内存打满（`requestUrl` 一次返回整个 body）。
			name: "★ 不校验大小（超大文件照下载照上传）",
			from: "\tif (bytes.byteLength > maxBytes) {\n\t\treturn { status: \"too-large\", detail: String(bytes.byteLength) };\n\t}\n",
			to: "\t// 变异：不校验大小\n",
			expect: "上限",
		},
		{
			// 后果：读不到原文却继续走 ⇒ 后面 `modify` 会把笔记**整文件覆盖**成空内容。
			// 这是本模块最不能犯的错：用户丢的是笔记。
			name: "★ 读不到原文却不早退（后面会整文件覆盖，可能清空笔记）",
			from: '\t\t} catch (error) {\n\t\t\tsay("no-note", { host });\n\t\t\treturn { ...base, status: "no-note", error };\n\t\t}',
			to: "\t\t} catch {\n\t\t\toriginal = \"\";\n\t\t}",
			expect: "no-note",
		},
		{
			// 后果：`localCopy: "trash"` 的用户点了「缓存」，结果本地没留副本 ⇒
			// 这条路径的全部意义（离线可见）消失，而症状完全不可见（只在断网时才发现）。
			name: "★ trash 不再被改成 cache（用户点了「缓存」却在本地什么都没留）",
			from: '\treturn action === "trash" ? "cache" : action;',
			to: "\treturn action;",
			expect: "trash",
		},
		{
			// 后果：本存储的 URL 也走这条链 ⇒ 把自己的图重新下载再上传一遍，
			// 而本该由回退下载静默处理。
			name: "★ 不再拦本存储的 URL（把自己的图下载再传一遍）",
			from: "\t\tif (keyFromUrl(url, settings.s3)) return { ...base, status: \"refused\" };\n",
			to: "\t\t// 变异：不识别本存储\n",
			expect: "本存储",
		},
	],
});
