import { runMutations } from "./lib/mutate.mjs";
import { runLocalFileSuite } from "./lib/local-file-suite.mjs";

/**
 * 变异验证：**「本机文件」（`file:///D:/…`）的解析、判定与读取**（`src/local-file.ts`）。
 *
 * 守的三件事（与套件头一一对应）：
 * - **形态解析**别认错 —— 认错一个就会去读**一份别的文件**（驱动整个"不该读的东西没被读"的前提）；
 * - ⭐ **扩展名闸门**别放宽 —— 用户 2026-10-15 选了"不加目录白名单"，同意落在"逐份勾选"上，
 *   于是这道闸门是唯一还站着的技术边界：它一放宽，"勾中一张图"就变成"勾中任意文件"
 *   （而另一端是"把本机文件传进一个可能公开读的桶"）；
 * - **平台与安全阀**别丢 —— 手机端不认、超上限不读进来、文件不在就报"不在"。
 *
 * ⚠️ **有意不设锚点的一处**：`readLocalFileBytes` 里那句 `if (!info.isFile())`。
 * 去掉它结果**一样**（对目录调 `fs.readFile` 在 Windows/macOS 上都抛 EISDIR ⇒ 同样落到
 * `unreadable`），所以任何锚点都只会报"漏过（测试无牙）"—— 那是**假绿发生器**。
 * 它留着是因为它在别的平台上确实能拦住"设备文件/管道"这类不该读的东西，
 * 而那种场景本机测不出来。**别为了让变异好看而给它编一条断言。**
 *
 * ⚠️ 还有一处**测不出来**的性质，写在套件第 5 节里（源码形状断言）：`node:fs` 必须是
 * **函数内 `import()`**。顶层导入会让**手机端整个插件加载失败**，而那种失败在 Node 下
 * 照常工作 ⇒ 套件测不出来，只能查源码形状。
 *
 * 断言套件与正式测试共用（`lib/local-file-suite.mjs`）。
 */
await runMutations({
	source: "src/local-file.ts",
	entries: ["src/local-file", "src/vault-files"],
	suite: runLocalFileSuite,
	mutations: [
		{
			// 后果：`file:///D:/…` 解析成 `/D:/…`（多一个前导斜杠）⇒ 去读一个**不存在的路径**，
			// 用户看到的是"文件不在了"，而文件明明在那儿（最难查的一类）。
			name: "★ 盘符前那个多余的斜杠没去掉（解析出的路径不存在）",
			from: "\tif (/^\\/[a-z]:[\\\\/]/i.test(rest)) rest = rest.slice(1);",
			to: "\tif (false) rest = rest.slice(1);",
			expect: "三斜杠写法要落到盘符路径",
		},
		{
			// 后果：`file:///D:/x.png` 变成 `//D:/x.png` —— 那是 UNC 形状，指向一台名为 `D:` 的主机。
			name: "★ 三斜杠只削掉一层（把本机路径当成了 UNC）",
			from: "\t\trest = rest.slice(2);",
			to: "\t\trest = rest.slice(1);",
			expect: "三斜杠写法要落到盘符路径",
		},
		{
			// 后果：中文路径不再解码 ⇒ 读到的是 `%E4%BC%81…` 那个**字面文件名**，真实文件读不到。
			name: "★ 百分号编码不再解码（中文路径的截图读不到）",
			from: "\t\treturn decodeURIComponent(value);",
			to: "\t\treturn value;",
			expect: "百分号编码的中文要解一次",
		},
		{
			// 后果：解码失败时返回空串 ⇒ 那个路径整条作废（用户看到"文件不在"，而它在）。
			// 正确的方向是"按原样用"：`100%.png` 这种带裸 % 的目录名是合法的。
			name: "★ 解码失败时不再退回原值（带裸 % 的路径被当成不存在）",
			from: "\t} catch {\n\t\treturn value;\n\t}",
			to: '\t} catch {\n\t\treturn "";\n\t}',
			expect: "解不动就按原样用",
		},
		{
			// 后果：手机端也去认 `file:///D:/…` ⇒ 读不到（移动端没有这个路径）却要先走一趟，
			// 而且清单里会出现一堆点不动的候选。
			name: "★ 平台判据丢了（手机端也去读本机绝对路径）",
			from: '\tif (!input.isDesktop) return { action: "ignore", reason: "仅桌面端（手机拿不到本机绝对路径）" };',
			to: '\tif (false) return { action: "ignore", reason: "仅桌面端（手机拿不到本机绝对路径）" };',
			expect: "手机端拿不到本机绝对路径",
		},
		{
			// ⭐⭐ 后果：**唯一站着的技术边界没了** —— 用户勾中一张截图，插件却肯去读
			// 同一目录下的任意文件（`.txt` / `.zip` / `id_rsa`），并把它传进用户的存储
			// （而桶可能是公开读的）。这是本功能最重的一条。
			name: "★★ 扩展名闸门放宽（勾中一张图 = 勾中任意文件）",
			from: "\tif (!isEmbeddable(ext)) {",
			to: "\tif (false) {",
			expect: "不放行",
		},
		{
			// 后果：先量大小这一步丢了 ⇒ 一份几 GB 的文件被整个读进内存（这个上限要防的正是它）。
			name: "★ 不先量大小（几 GB 的文件直接读进内存）",
			from: '\t\tif (info.size > maxBytes) return { status: "too-large", size: info.size };',
			to: '\t\tif (false) return { status: "too-large", size: info.size };',
			expect: "超过上限 ⇒ 不读进来",
		},
		{
			// 后果：文件被挪走/删掉与"读不了"混成一个结局 ⇒ 用户看到的是一句泛泛的失败，
			// 而这一类恰恰最常见、也最容易自己修（重新截一张 / 改一下链接）。
			name: "★ 文件不在与读不了混成一类（最常见的失败说不清原因）",
			from: '\t\tif (code === "ENOENT") return { status: "missing" };',
			to: '\t\tif (false) return { status: "missing" };',
			expect: "文件不在了单独一个结局",
		},
	],
});
