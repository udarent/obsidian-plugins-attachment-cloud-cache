import { runMutations } from "./lib/mutate.mjs";
import { runLinkAccessSuite } from "./lib/link-access-suite.mjs";

/**
 * 变异验证：访问方式判定（`src/link-access.ts`）。
 *
 * 这一层判错的两种后果**都不报错**、也都在用户看不见的地方：
 * - 该走内部却走了公开 ⇒ 私有桶的用户**一屏坏图**（`<img>` 的 403 不弹提示）；
 * - 该走公开却走了内部 ⇒ 每张图白下载一遍（移动端流量），而用户不知道可以省掉。
 *
 * 所以每条规则（每个探测结果 → 一条路径、两条闸门、探测的失败收敛）都要能被单独打坏。
 * ⚠️ 套件把"探测结果 → 路径"那张表排在**最前**：这样绝大部分变异都以
 * "那张表里的某一行"失败，而不是先炸在别的断言上、报出一个与变异点无关的原因。
 */
await runMutations({
	source: "src/link-access.ts",
	entries: ["src/link-access", "src/s3/client"],
	suite: runLinkAccessSuite,
	mutations: [
		{
			// 后果：明明匿名就能读到，却按私有处理 ⇒ 每张图都要先下载一遍才显示。
			// 不报错、图也看得见，只是白花流量 —— 最容易被当成"这插件本来就慢"。
			name: "★ 探测到匿名可读也按私有处理（每张图白下载一遍）",
			from: '\t\tcase "ok":\n\t\t\treturn { access: "public", reason: "probePublic" };',
			to: '\t\tcase "ok":\n\t\t\treturn { access: "private", reason: "probePublic" };',
			expect: "auto 档下探测结果 ok 应走 public",
		},
		{
			// 后果：桶明明是私有的，却按公开处理 ⇒ 缺副本的图不再被取回，
			// 用户看到一屏坏图，而控制台里只有一条 403。这正是这一版要修的病。
			name: "★ 探测到拒绝匿名仍按公开处理（私有桶一屏坏图）",
			from: '\t\tcase "forbidden":\n\t\t\treturn { access: "private", reason: "probeForbidden" };',
			to: '\t\tcase "forbidden":\n\t\t\treturn { access: "public", reason: "probeForbidden" };',
			expect: "auto 档下探测结果 forbidden 应走 private",
		},
		{
			// 后果：探测不出来时落到**假定公开** ⇒ 私有桶 + 离线 / 超时时回到坏图，
			// 而"探测失败"恰恰是最常见的一种状态（没有对象可试时也是它）。
			name: "★★ 探测不出来时假定公开（降级方向反了：私有桶回到坏图）",
			from: '\t\t\treturn { access: "private", reason: probe?.kind === "unknown" ? "probeUnknown" : "probeUnreachable" };',
			to: '\t\t\treturn { access: "public", reason: probe?.kind === "unknown" ? "probeUnknown" : "probeUnreachable" };',
			expect: "auto 档下探测结果 unreachable 应走 private",
		},
		{
			// 后果：用户显式选了「仅内部访问」，探测说可匿名读就改按公开 ⇒ **替用户决定
			// "这些图可以给外人看"**。这是隐私方向的错，比多下一次严重得多。
			name: "★★ 探测结果压过用户的显式选择（替用户把图改成对外可见）",
			from: '\tif (safeMode === "public") return { access: "public", reason: "explicitPublic" };\n\tif (safeMode === "private") return { access: "private", reason: "explicitPrivate" };',
			to: '\tif (safeMode === "public") return { access: "public", reason: "explicitPublic" };\n\tif (safeMode === "private" && probe?.kind === "ok") return { access: "public", reason: "explicitPrivate" };\n\tif (safeMode === "private") return { access: "private", reason: "explicitPrivate" };',
			expect: "★ 用户选内部时，探测说可匿名读也按内部",
		},
		{
			// 后果：手改过 / 写坏的档位值被当成公开 ⇒ 又一次"替用户把图对外"。
			name: "★ 坏档位值被读成公开（手改 data.json 就静默对外）",
			from: '\tconst safeMode: LinkAccessMode = isLinkAccessMode(mode) ? mode : "auto";',
			to: '\tconst safeMode: LinkAccessMode = isLinkAccessMode(mode) ? mode : "public";',
			expect: "认不出来的档位按 auto 处理",
		},
		{
			// 后果：私有 + 不留副本 又被当成"取回本地" ⇒ 为了显示一张图，往用户库里
			// 写一个他说过不要的文件 —— 而用户要的是图床式（磁盘不落文件）。
			name: "★★ 私有 + 不留副本 又变回「下载」（往用户库里写他说过不要的文件）",
			from: '\treturn isCacheDisabled(settings.localCopy) ? "signed-url" : "local-copy";',
			to: '\treturn isCacheDisabled(settings.localCopy) ? "local-copy" : "local-copy";',
			expect: "私有 + 不留副本 ⇒ 预签名地址",
		},
		{
			// 后果：公开读取也被当成"只能靠内部手段"⇒ 每张图都要下载或签名，
			// 而桶本来就允许匿名读（白花流量 + 多一层过期窗口）。
			name: "★ 公开读取也走内部手段（每张图白下载/白签名一遍）",
			from: '\tif (resolveAccess(settings.linkAccess, probe).access === "public") return "remote-url";',
			to: "\t// 变异：不认公开读取",
			expect: "公开读取下就是远端地址",
		},
		{
			// 后果：该不该签的判据反了 ⇒ 私有+不留副本时**不签**（图床式失效，回到坏图），
			// 而私有+保留副本时反倒去签（弃用更能离线可用的本地副本）。
			name: "★ 「该不该签」的判据反了（图床式失效，且弃用本地副本）",
			from: '\treturn displayPathFor(settings, probe) === "signed-url";',
			to: '\treturn displayPathFor(settings, probe) === "local-copy";',
			expect: "私有 + 不留副本 ⇒ 该签",
		},
		{
			// 后果：私有存储下不再强制取回 ⇒ 用户关掉「自动下载」时**什么都看不到**，
			// 而界面上没有任何解释（那个开关的本意是省流量）。
			name: "★ 私有存储不再强制取回（关掉自动下载时图全都不显示）",
			from: '\treturn displayPathFor(settings, probe) === "local-copy";',
			to: "\treturn false;",
			expect: "私有访问下必须取回",
		},
		// ⚠️ 原第二条（"「不留副本」被下载需求推翻"）的锚点随 `requiresLocalCopy` 重构消失了：
		// 那个"压过一切"的判断现在**就在** `displayPathFor` 里（`isCacheDisabled` 决定走预签名）。
		// 它守的语义没有丢 —— 上面的"私有 + 不留副本 又变回「下载」"就是它的新形态。
		{
			// 后果：401 被归到"其它"⇒ 设置页那句提示从"桶拒绝匿名访问"退化成含糊的
			// "无法判断"，用户不知道下一步该开公开读还是改前缀。
			// ⚠️ 这条锚点 1.7.0 从 `mutate-settings-logic.mjs` 搬来（归类跟着判定一起搬了家）。
			name: "401 不再归为「拒绝匿名访问」（提示退化成含糊的「无法判断」）",
			from: '\tif (status === 401 || status === 403) return "forbidden";',
			to: '\tif (status === 403) return "forbidden";',
			expect: "401 同理",
		},
		{
			// 后果：403（桶私有）被归到"其它"⇒ 提示从"桶拒绝匿名访问"退化成含糊的
			// "无法判断"，而真正该做的是"开公开读或配公开前缀"。指向了错的下一步。
			// ⚠️ 与上一条锚在同一行、方向相反 —— 归类的两侧都要能抓住（实测过只测一侧
			// 会让"顺手把 403 摘出去"漏过）。这条 1.7.0 从 `mutate-settings-logic.mjs` 搬来。
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
