import { runMutations } from "./lib/mutate.mjs";
import { runLinkAccessSuite } from "./lib/link-access-suite.mjs";

/**
 * 变异验证：连接状态判定（`src/link-access.ts`）。
 *
 * 2026-10-18 起这里守的是**探测出来的事实**（不再是用户选的档）：
 * 状态 ⇒ 显示路径、自动探测 ⇒ 状态、回路实测 ⇒ 状态，以及"地址与状态无关"。
 *
 * 这一层判错的两种后果**都不报错**、也都在用户看不见的地方：
 * - 该按私有却按公开 ⇒ 私有桶的用户**一屏坏图**（`<img>` 的 403 不弹提示）；
 * - 该按公开却按私有 ⇒ 每张图白下载一遍（移动端流量），而用户不知道可以省掉。
 *
 * ⚠️ 套件把"状态 × 本地副本 ⇒ 显示路径"那张表排在**最前**，所以显示路径类的变异
 * 会撞在那张表上；后面几组各自撞在自己的断言上。
 */
await runMutations({
	source: "src/link-access.ts",
	entries: ["src/link-access", "src/s3/client"],
	suite: runLinkAccessSuite,
	mutations: [
		{
			// 后果：明明匿名就能读到，却按私有处理 ⇒ 每张图都要先下载一遍才显示。
			// 不报错、图也看得见，只是白花流量 —— 最容易被当成"这插件本来就慢"。
			name: "★ 公开状态也走内部手段（每张图白下载一遍）",
			from: '\tif (state === "public") return "remote-url";',
			to: '\tif (state === "checking") return "remote-url";',
			expect: "状态 public + 本地副本 keep ⇒ remote-url",
		},
		{
			// 后果：初值变成"假定公开" ⇒ 私有桶在首轮探测回来之前就是一屏坏图
			//（1.6.0 的病）。这是**降级方向**的错，代价与"多下一次"完全不对称。
			name: "★★ 初值假定公开（私有桶启动时一屏坏图）",
			from: 'export const INITIAL_CONNECTION_STATE: ConnectionState = "checking";',
			to: 'export const INITIAL_CONNECTION_STATE: ConnectionState = "public";',
			expect: "★ 加载初值必须是 checking",
		},
		{
			// 后果：匿名明明能读，状态却记成私有 ⇒ 后面每张缺副本的图都白下载。
			name: "★ 自动探测：匿名可读却记成私有（白下载）",
			from: '\tswitch (probe?.kind) {\n\t\tcase "ok":\n\t\t\treturn "public";',
			to: '\tswitch (probe?.kind) {\n\t\tcase "ok":\n\t\t\treturn "private";',
			expect: "匿名读得到 ⇒ 公开",
		},
		{
			// 后果：拒绝匿名却记成公开 ⇒ 私有桶的用户看到一屏坏图，而控制台只有一条 403。
			name: "★ 自动探测：拒绝匿名却记成公开（私有桶一屏坏图）",
			from: '\t\tcase "forbidden":\n\t\t\treturn "private";',
			to: '\t\tcase "forbidden":\n\t\t\treturn "public";',
			expect: "拒绝匿名 ⇒ 私有",
		},
		{
			// 后果：404（公开前缀可能写错）被当成"私有"的证据 ⇒ 状态在"公开/私有"之间乱翻，
			// 用户看到的是"时好时坏"，而真正该改的是前缀。
			name: "★ 404 被当成结论（状态在公开/私有之间乱翻）",
			from: "\t\tdefault:\n\t\t\treturn previous;",
			to: '\t\tdefault:\n\t\t\treturn "private";',
			expect: "404 不改判（沿用上一次）",
		},
		{
			// 后果：签名读明明失败了，却因为"匿名说私有"就记成私有 ⇒ 界面绿着，
			// 而那张图根本取不回来（私有桶不取回本地副本就什么都看不到）。
			name: "★★ 回路：签名读失败仍记成私有（图取不回来而界面说正常）",
			from: '\t\t\treturn input.signedReadOk ? "private" : "unreachable";',
			to: '\t\t\treturn "private";',
			expect: "★ 匿名与签名都取不到 ⇒ 无法访问",
		},
		{
			// 后果：匿名读得到也被判成私有 ⇒ 与第一条同病，但发生在**用户点按钮**那条路上：
			// 界面上会显示"私有访问"，而链接其实是公开的。
			name: "★ 回路：匿名读得到却判成私有（界面说私有，链接其实公开）",
			from: '\tswitch (input.anonymous.kind) {\n\t\tcase "ok":\n\t\t\treturn "public";',
			to: '\tswitch (input.anonymous.kind) {\n\t\tcase "ok":\n\t\t\treturn "private";',
			expect: "★ 匿名读得到 ⇒ 公开",
		},
		{
			// 后果：私有 + 不留副本 又被当成"取回本地" ⇒ 为了显示一张图，往用户库里
			// 写一个他说过不要的文件 —— 而用户要的是图床式（磁盘不落文件）。
			name: "★★ 私有 + 不留副本 又变回「下载」（往用户库里写他说过不要的文件）",
			from: '\treturn isCacheDisabled(settings.localCopy) ? "signed-url" : "local-copy";',
			to: '\treturn isCacheDisabled(settings.localCopy) ? "local-copy" : "local-copy";',
			expect: "状态 private + 本地副本 trash ⇒ signed-url",
		},
		{
			// 后果：公开状态也要签名 ⇒ 多一次签名开销，且地址带上了有效期（不该出现在公开桶上）。
			name: "★ 「该不该签」的判据不看状态（公开桶也去签名）",
			from: '\treturn displayPathFor(settings, state) === "signed-url";',
			to: '\treturn displayPathFor(settings, "private") === "signed-url";',
			expect: "公开 ⇒ 用远端地址，不签名",
		},
		{
			// 后果：403（桶私有）被归到"其它"⇒ 提示从"桶拒绝匿名访问"退化成含糊的
			// "无法判断"，而真正该做的是"开公开读或配公开前缀"。指向了错的下一步。
			name: "★ 403 不再归为「拒绝匿名访问」（提示退化成含糊的「无法判断」）",
			from: '\tif (status === 401 || status === 403) return "forbidden";',
			to: '\tif (status === 401) return "forbidden";',
			expect: "403 = 拒绝匿名",
		},
		{
			// 后果：探测实现抛错时把异常放出去 ⇒ 设置页那一片反馈被吞掉，
			// 而用户此刻最需要的恰恰是"下一步改哪儿"。
			name: "★ 探测抛错时不再兜住（设置页的反馈会被异常吞掉）",
			from:
				'\t} catch {\n' +
				'\t\t// 探测实现自己抛错（传输层、解析、权限……）：一律当"到不了"。\n' +
				'\t\treturn { kind: "unreachable", status: null, at: now() };\n' +
				"\t}",
			to: "\t} catch (error) {\n\t\tthrow error;\n\t}",
			expect: "探测实现抛错必须收敛成 unreachable",
		},
		{
			// 后果：超时被当成"连不上"⇒ 用户被引去查地址（很可能是对的），
			// 而真正的问题是网络慢。两件事的修法不同。
			name: "超时不再标出来（用户被引去查一个没坏的地址）",
			from: '\t\t\treturn { kind: "unreachable", status: null, at: now(), timedOut: true };',
			to: '\t\t\treturn { kind: "unreachable", status: null, at: now() };',
			expect: "超时要能标出来",
		},
		{
			// 后果：探测试的**不是**笔记里那条地址 ⇒ "测试说公开、链接却是另一个域名"，
			// 那种分叉只在用户把链接发出去之后才暴露。
			name: "★ 探测与写入不同源（测的是另一个地址）",
			from: "\t\treturn publicUrlFor(address, cleanKey);",
			to: '\t\treturn publicUrlFor({ ...address, publicUrlBase: "" }, cleanKey);',
			expect: "探测的必须是真写进笔记的那条地址",
		},
	],
});
