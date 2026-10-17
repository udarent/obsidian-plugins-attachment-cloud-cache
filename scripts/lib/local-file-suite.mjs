/**
 * 「本机文件」（`file:///D:/…`）的纯判定与读取断言套件（与变异验证共用）。
 *
 * 这一层最要紧的三条：
 * 1. **形态解析**：真机上见得到的几种写法都要认（三斜杠 / `file:/` / `file:D:` / UNC /
 *    百分号编码的中文），而"不是绝对路径"的一律不认 —— 认错一个就会去读一份**别的文件**；
 * 2. ⭐ **扩展名闸门**：不加目录白名单是用户定的（同意落在"逐份勾选"上），
 *    于是这道闸门是唯一还站着的技术边界 —— 它一放宽，"勾中一张图"就变成"勾中任意文件"；
 * 3. ⚠️ **平台判据**：非桌面一律 ignore（手机拿不到本机绝对路径）。
 *
 * ⚠️ 读取那一段用**真磁盘**（写一份临时文件再读）—— 替身化的 `fs` 测不出
 * "先 stat 再 readFile""ENOENT 与别的失败分开"这些正是要守的性质。
 */

import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** 固定目录 + 清空复用（见手册「测试提速」：每轮新建目录在 Windows 上最贵）。 */
const SANDBOX = join(tmpdir(), "acc-local-file");

export async function runLocalFileSuite(mod) {
	const { localPathFromUrl, decideLocalFile, localFileExists, isMissingError, localThumbCandidates, readLocalFileBytes, DEFAULT_LOCAL_FILE_MAX_BYTES } = mod;

	// ============================================================
	// 1. 形态解析：认得的写法
	// ============================================================
	{
		assert.equal(
			localPathFromUrl("file:///D:/企业微信文件/WXWork/企业微信截图_17907591882999.png"),
			"D:/企业微信文件/WXWork/企业微信截图_17907591882999.png",
			"★ 三斜杠写法要落到盘符路径（盘符前那个多余的斜杠必须去掉）"
		);
		assert.equal(
			localPathFromUrl("file:/D:/a/b.png"),
			"D:/a/b.png",
			"★ 单斜杠写法（别的工具导出常见）同样是绝对路径"
		);
		assert.equal(localPathFromUrl("file:D:/a/b.png"), "D:/a/b.png", "★ 没有斜杠的写法也要认");
		assert.equal(
			localPathFromUrl("file:////server/share/报告.pdf"),
			"//server/share/报告.pdf",
			"★ UNC：保留 // 前缀（改成盘符形状会指到完全不同的地方）"
		);
		assert.equal(
			localPathFromUrl("file://server/share/report.pdf"),
			"//server/share/report.pdf",
			"★ UNC 的两斜杠写法同样保留 //"
		);
		assert.equal(
			localPathFromUrl("file:///D:/%E4%BC%81%E4%B8%9A/%E5%9B%BE.png"),
			"D:/企业/图.png",
			"★ 百分号编码的中文要解一次"
		);
		assert.equal(
			localPathFromUrl("file:///D:/100%25.png"),
			"D:/100%.png",
			"★ 编码过的百分号解成裸 %（这才是那个文件名本身）"
		);
		assert.equal(
			localPathFromUrl("file:///D:/a/100%.png"),
			"D:/a/100%.png",
			"⚠️ 解不动就按原样用 —— 别因为一个裸 % 拒掉一份本来能读的文件"
		);
		assert.equal(localPathFromUrl("FILE:///D:/a/b.png"), "D:/a/b.png", "协议名大小写不敏感");
	}

	// ============================================================
	// 2. 形态解析：一律不认的（认错就会去读别的文件）
	// ============================================================
	{
		assert.equal(localPathFromUrl("https://a.com/x.png"), null, "★ http(s) 归站外那条链管");
		assert.equal(localPathFromUrl("D:/a/b.png"), null, "★ 裸本机路径不是 URL（本模块只认 file: 写法）");
		assert.equal(localPathFromUrl("file:a/b.png"), null, "★ 相对路径不得认（会读到「当前目录」里去了）");
		assert.equal(localPathFromUrl("file:///a/b.png"), null, "★ 没有盘符也不是 UNC ⇒ 不是绝对路径");
		assert.equal(localPathFromUrl("file:///D:/a/b\u0000.png"), null, "★ 空字节：下游 fs 必抛，在这里断掉");
		assert.equal(localPathFromUrl(""), null, "空串");
		assert.equal(localPathFromUrl(undefined), null, "缺值");
		assert.equal(localPathFromUrl(42), null, "非字符串");
	}

	// ============================================================
	// 3. ⭐ 判定：桌面 + 能嵌进笔记的那几类才放行
	// ============================================================
	{
		const desktop = { src: "file:///D:/a/图.png", isDesktop: true };
		const ok = decideLocalFile(desktop);
		assert.equal(ok.action, "read", "★ 桌面 + 图片 ⇒ 可以读");
		assert.equal(ok.path, "D:/a/图.png", "读的就是解析出来的那个路径");
		assert.equal(ok.name, "图.png", "★ 文件名取末段（对象 key 与本地副本的名字都从它来）");
		assert.equal(ok.ext, "png", "扩展名");
		assert.equal(ok.contentType, "image/png", "内容类型按扩展名给（上传要用）");

		// 能嵌进笔记的四类都放行（另加一条反例：PDF 也算附件）
		for (const [src, ext] of [
			["file:///D:/a/歌.mp3", "mp3"],
			["file:///D:/a/片.mp4", "mp4"],
			["file:///D:/a/文.pdf", "pdf"],
		]) {
			const decision = decideLocalFile({ src, isDesktop: true });
			assert.equal(decision.action, "read", `${ext} 属于可嵌入的那几类`);
			assert.equal(decision.ext, ext, `${ext} 的扩展名要如实取到`);
		}

		// ⭐ 闸门：不在那几类里的一律不放行
		for (const src of [
			"file:///D:/a/secret.txt",
			"file:///D:/a/包.zip",
			"file:///D:/a/程序.exe",
			"file:///D:/a/id_rsa",
		]) {
			const decision = decideLocalFile({ src, isDesktop: true });
			assert.equal(decision.action, "ignore", `★★ 不放行：${src}（扩展名是唯一站着的边界）`);
		}

		// ⚠️ 平台：非桌面一律不读（这是本项目第一次做平台判断）
		const onMobile = decideLocalFile({ src: "file:///D:/a/图.png", isDesktop: false });
		assert.equal(onMobile.action, "ignore", "★ 手机端拿不到本机绝对路径 ⇒ 不认");
		assert.ok(
			onMobile.reason.includes("桌面"),
			`★ 原因要指向平台（用户得知道这不是他做错了什么）：${onMobile.reason}`
		);

		// ⚠️ 「不归我管」与「归我管但这次不读」必须分得开：不是 file: 的地址整个交给站外那一半，
		// 而"是 file: 但不读"是本模块自己的结论。合成一个动作，调用方就得自己再写一遍
		// "这串是不是 file:" —— 那是"同一条判据写两处"的开始。
		const notFile = decideLocalFile({ src: "https://a.com/x.png", isDesktop: false });
		assert.equal(notFile.action, "not-mine", "★ 不是 file: 的地址整个不归本模块管（交给站外那一半）");
		assert.equal(
			decideLocalFile({ src: "file:///D:/a/图.png", isDesktop: false }).action,
			"ignore",
			"★ 而「是 file:、但这次不读」是本模块的结论 —— 两者必须区分得开"
		);
	}

	// ============================================================
	// 4. 读取：真磁盘（先 stat 再 readFile / 缺文件与读不了分开）
	// ============================================================
	{
		await rm(SANDBOX, { recursive: true, force: true });
		await mkdir(SANDBOX, { recursive: true });
		try {
			const file = join(SANDBOX, "图.png");
			await writeFile(file, Buffer.from([1, 2, 3, 4, 5]));

			const read = await readLocalFileBytes(file);
			assert.equal(read.status, "ok", "★ 读得动");
			assert.equal(read.bytes.length, 5, "字节数如实");
			assert.equal(read.name, "图.png", "★ 名字取末段（给上游用）");
			assert.equal(read.ext, "png", "★ 扩展名也一起给（别再让上游自己切一遍）");

			// 上限：**先量后读**（否则一份大文件会被整个读进内存）
			const capped = await readLocalFileBytes(file, { maxBytes: 4 });
			assert.equal(capped.status, "too-large", "★ 超过上限 ⇒ 不读进来");
			assert.equal(capped.size, 5, "把真实大小报出来（好让文案说得出「多大」）");

			const missing = await readLocalFileBytes(join(SANDBOX, "没有这个文件.png"));
			assert.equal(missing.status, "missing", "★ 文件不在了单独一个结局（值得一句具体的话）");

			// 目录：不是普通文件 ⇒ 读不了（而不是 "missing" —— 它确实在那儿）
			const dirRead = await readLocalFileBytes(SANDBOX);
			assert.equal(dirRead.status, "unreadable", "★ 目录不是「文件不在了」");

			// 默认上限存在（安全阀）—— 数值与执行器那份同值，但**不是同一份定义**
			assert.equal(
				DEFAULT_LOCAL_FILE_MAX_BYTES,
				32 * 1024 * 1024,
				"默认上限是 32 MB（与站外那份同值，刻意各留一份定义）"
			);

			// ⭐⭐ 「还在不在」的探测：**只有"确实没有这条路"才算"不在"**（2026-10-16 用户实测报的）
			// —— 那份 `D:/企业微信文件/…/企业微信截图_…png` 就在磁盘上（74909 字节），
			// 而清单里说它「已经找不到了」。当时的实现把**所有**异常都吞成 `false`。
			// ⇒ 判据与 `readLocalFileBytes` **同一份**：`ENOENT` / `ENOTDIR` ⇒ `false`；
			// **其余一律抛出去**（它们是"这台机器上读不到"，不是"这张图没了"）。
			// ⚠️ 分类说不清却硬说"不在"，代价是**用户被误导** —— 他会以为链接坏了，
			// 甚至去删笔记里那条引用。
			assert.equal(await localFileExists(file), true, "★ 存在的文件 ⇒ true");
			assert.equal(
				await localFileExists(join(SANDBOX, "没有这个文件.png")),
				false,
				"★ 真的没有这条路 ⇒ false（ENOENT）"
			);
			assert.equal(await localFileExists(SANDBOX), false, "★ 路径是个目录 ⇒ false（不是普通文件）");
			assert.equal(
				await localFileExists(join(file, "后面还有一段")),
				false,
				"★ 路径中间那一段不是目录 ⇒ false（ENOTDIR）"
			);
			// ⭐⭐ "说不清的那一类（权限 / 路径过长 / 设备不可用）**不许**被当「不在」"这条判据，
			// **不能**靠"造一个非 ENOENT 的 stat 失败"来测：Windows 上超长路径照样报 `ENOENT`
			//（实测：`assert.rejects` 当场失败）⇒ 那种场景本来就跨平台不稳定。
			// ⇒ 改测**纯判据本身**：`isMissingError` ——"哪些 `fs` 错误算「这份文件确实不在」"，
			// 它是一处定义（`localFileExists` 与 `readLocalFileBytes` 共用），可以穷举。
			// ⚠️ 用户 2026-10-16 实测报的那件事（"文件明明在却说找不到"）正是"把读不到当不在"：
			// 权限 / 被占用 / 路径过长 / 设备不可用 都会被 `stat` 抛出来，而它们**不是**"没了"。
			for (const code of ["ENOENT", "ENOTDIR"]) {
				assert.equal(isMissingError({ code }), true, `★ ${code} = 确实没有这条路`);
			}
			for (const [label, error] of [
				["权限不足", { code: "EACCES" }],
				["被占用", { code: "EBUSY" }],
				["路径过长", { code: "ENAMETOOLONG" }],
				["设备不可用", { code: "ENODEV" }],
				["看不出来历的错", new Error("whatever")],
				["连 error 都不是", null],
			]) {
				assert.equal(isMissingError(error), false, `★★ 「${label}」不是「不在」—— 别把读不到当不在`);
			}		} finally {
			await rm(SANDBOX, { recursive: true, force: true });
			const left = await readdir(tmpdir()).catch(() => []);
			assert.ok(
				!left.includes("acc-local-file"),
				"★ 自己的临时目录要清干净（别在 %TEMP% 里留垃圾）"
			);
		}
	}

	// ============================================================
	// 4b. ⭐⭐ 缩略图**候选**：库外文件那条路的地址形式（D-45）
	//
	// 用户 2026-10-16 **第二次**报同一件事（「列表上有对应文件了，但是预览看不到」）：
	// `file:///D:/…` 在宿主里**画不出来**（Chromium 拒绝从 `app://` 原点的页面加载
	// `file://` 子资源），而宿主**自己**的本地文件前缀（`Platform.resourcePathPrefix`：
	// 移动端 `file:///`、桌面 `app://random-id/`）才是它认的形式。
	// ⇒ 判据只有这一处（`local-file.ts::localThumbCandidates`），穷举也放这里。
	// ============================================================
	{
		assert.deepEqual(
			localThumbCandidates({ url: "file:///D:/a/b.png", path: "D:/a/b.png", prefix: "app://vault/" }),
			["app://vault/D:/a/b.png", "file:///D:/a/b.png"],
			"★★ 宿主自己的前缀优先、原文兜底（画不出来的是原文那一形态）"
		);
		assert.deepEqual(
			localThumbCandidates({ url: "file:///C:/a.png", path: "C:/a.png", prefix: "file:///" }),
			["file:///C:/a.png"],
			"★ 候选要去重（移动端那个前缀正好就是 `file:///`，两条会完全相同）"
		);
		assert.deepEqual(
			localThumbCandidates({ url: "file:///D:/a.png", path: null, prefix: "app://vault/" }),
			["file:///D:/a.png"],
			"★ 解析不出路径时只剩原文这一条（不抛错、也不给空串）"
		);
		assert.deepEqual(
			localThumbCandidates({ url: "file:///D:/a.png", path: "D:/a.png", prefix: null }),
			["file:///D:/a.png"],
			"★ 拿不到前缀时同理（宿主没给就退回原文）"
		);
		assert.deepEqual(localThumbCandidates({ url: "  ", path: null, prefix: null }), [], "什么都给不出 ⇒ 空数组");
		assert.deepEqual(localThumbCandidates({ url: null, path: undefined, prefix: 1 }), [], "非字符串不抛错");
	}

	// ============================================================
	// 5. ⚠️ **产物形状**：`node:fs` 必须在**函数体**里取
	//
	// 这一条不是行为断言，而是**源码形状**断言 —— 因为它是套件**测不出来**的那种性质：
	// 产物是 CJS 单文件，顶层 `import "node:fs/promises"` 会被编译成模块加载期的 `require`，
	// 于是在**手机端**（没有那个 Node 内置模块）**整个插件都加载失败** ——
	// 而套件跑在 Node 下，源码形状怎么写它都能过。
	// ⇒ 这种性质只能查源码形状（与 `check-injected-snippets` 那类静态门禁同一个思路，
	// 只是这条只对一个文件成立，不值得开一条门禁）。
	// ============================================================
	{
		const here = dirname(fileURLToPath(import.meta.url));
		const source = await readFile(join(here, "..", "..", "src", "local-file.ts"), "utf8");
		assert.deepEqual(
			source.match(/^import[^;]*from\s*["']node:/gm) ?? [],
			[],
			"★★ 不许顶层 import node:* —— 那会让手机端**整个插件**加载失败（不是这一个功能不可用）"
		);
		// ⚠️⚠️ 这两条**曾经是假绿的**（2026-10-16 发现）：原来断言的是源码里含
		// `await import("node:fs/promises")` —— 而那句**只出现在注释里**了（真机上动态
		// `import()` 被宿主的协议白名单拒，早已换成 `require`）。⇒ 断言"找得到某个字符串"
		// 的形式，在字符串**被别的用途复用**（注释、文档）时会静静地失效，
		// 而它看起来一直在跑。⇒ 改成问**那件事本身**：取 fs 的那句是不是 `require`、
		// 以及它**不在顶层**（顶层 require 会让手机端整个插件加载失败）。
		assert.ok(
			source.includes('require("node:fs/promises")'),
			"★ 取 fs 必须在**函数体内**（真机实测：动态 `import()` 被宿主的协议白名单拒）"
		);
		assert.ok(
			!/^require\(/m.test(source),
			"★★ 不许在**顶层** require —— 那会让手机端**整个插件**加载失败（不是这一个功能不可用）"
		);
	}

	return { cases: 5 };
}
