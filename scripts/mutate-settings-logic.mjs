import { runMutations } from "./lib/mutate.mjs";
import { runSettingsUiSuite } from "./lib/settings-ui-suite.mjs";

/**
 * 变异验证：设置界面的纯逻辑（`src/ui/settings-logic.ts`）。
 *
 * ⚠️ 套件同时覆盖 bindings 与 credentials，所以 `entries` 要把三个模块都带上；
 * 而套件里把 logic 的断言排在**最前**，正是为了让本文件的每个变异
 * 都因 logic 自己的原因失败，而不是先炸在 bindings 上（那会报出与变异点无关的原因）。
 *
 * 这里守的都是"界面显示得对不对"：
 * 用户敲的扩展名有没有被正确理解、不该显示的字段有没有出现、选项里有没有假的、
 * 以及连不上时的提示有没有指向正确的下一步。
 */
await runMutations({
	source: "src/ui/settings-logic.ts",
	entries: ["src/ui/settings-logic", "src/ui/settings-bindings", "src/s3/credentials"],
	suite: runSettingsUiSuite,
	mutations: [
		// ── 扩展名解析（已删除）──
		//
		// ⚠️ 这里原本有四条变异，锚在"扩展名列表的解析/格式化"上。那个设置项
		//（以及它的两个纯函数）在 1.1.0 被删除（需求 R15：**附件**类型不再要白名单），
		// 于是换成了**同一类后果**的三条 —— 它们同样是"不报错、只把用户带错路"的缺陷：
		// 界面上出现假选项、公开链接的文案 key 拼错。
		// ⚠️ 1.7.0：原第三条（"401 不再归为拒绝匿名访问"）**搬到 `mutate-link-access.mjs`** ——
		// 那个归类随访问方式的判定一起搬去了 `link-access.ts`（现在它同时是一条判定，
		// 见那边的文件头）。锚在已搬走的代码上只会"找不到目标"，那是假绿。
		{
			// 后果：下拉里多出一个**从不生效**的值（假选项），用户选了它以为行为变了，
			// 实际什么都没发生 —— 界面上能选的必须与类型清单完全一致。
			name: "★ 站点名单那一档的选项里混进一个未实现的值（界面上出现假选项）",
			from: "\tfor (const value of EXTERNAL_SITE_MODES) options[value] = labelOf(value);",
			to: '\tfor (const value of [...EXTERNAL_SITE_MODES, "always"]) options[value] = labelOf(value);',
			expect: "选项集合必须与 EXTERNAL_SITE_MODES 完全一致",
		},
		{
			// 后果：文案 key 拼错 ⇒ 界面上直接显示成 `public_ok` 这样的键名，
			// 用户既看不懂也不知道该做什么。
			name: "公开链接的文案 key 前缀被改（界面显示成 key 本身）",
			from: "\treturn `testPublic_${kind}`;",
			to: "\treturn `public_${kind}`;",
			expect: "每类都要有文案 key",
		},

		// ── 条件显示 ──
		// ⚠️ 1.2.0（D-17）：这里原本有一条锚点钉在 `shouldShowCacheFolder`
		//（"选「移入缓存」才显示缓存目录"）。那个函数与它守的字段**一起被删掉了**，
		// 于是锚点也**删掉** —— 锚在已删代码上的变异只会"找不到目标"（假绿）。
		{
			// 后果：又退回旧规则（只认 "cache" 档）⇒ 「原地保留」档的上限**看不见却仍在后台生效**，
			// 那正是 P7：一个用户不知道存在的开关在删他的副本。
			name: "★ 上限又变成只在「移入缓存」档显示（P7 复发：看不见的开关在删副本）",
			from: "export function shouldShowCacheLimit(action: unknown): boolean {\n\treturn !isCacheDisabled(action);\n}",
			to: 'export function shouldShowCacheLimit(action: unknown): boolean {\n\treturn action === "cache";\n}',
			expect: "原地保留档**也要显示**",
		},
		{
			// 后果：又退回 1.2.2 的旧口径（只在「不留副本」档显示）⇒ **设了上限的用户找不到手动入口**，
			// 只能干等后台那一轮（它每 10 分钟才看一次、还带 60 s 节流与 10 分钟宽限）。
			// ⭐ 这正是用户 2026-10-15 报的那个缺口："设置上限 500，想清理，却发现没有入口"。
			name: "★ 又只认「不留副本」档（设了上限却没有手动入口）",
			from: '\treturn localCopyCleanupTarget(action, cacheLimitMb).kind !== "none";',
			to: '\treturn isCacheDisabled(action);',
			expect: "保留副本档设了上限也要显示",
		},
		{
			// 后果（与上一条相反的错向）：没有目标也把按钮摆出来 —— 用户按下去，
			// 流程那一侧会**什么都不做**（`kind === "none"` 直接返回），
			// 界面上表现成"按钮点了没动静"，与"功能坏了"完全一样。
			name: "★ 没有目标也显示（按钮点了没动静）",
			from: '\treturn mb > 0 ? { kind: "limit", mb } : { kind: "none" };',
			to: '\treturn { kind: "limit", mb };',
			expect: "不限量时不该显示",
		},
		{
			// 后果：坏上限（无穷大 / 非数）被当成"有目标" ⇒ 目标变成一个够不着的数，
			// 按钮永远显示、而"已经在上限以内"这条永远不成立。
			name: "★ 坏上限被读成「有目标」",
			from: "\t\ttypeof cacheLimitMb === \"number\" && Number.isFinite(cacheLimitMb) ? Math.floor(cacheLimitMb) : 0;",
			to: "\t\ttypeof cacheLimitMb === \"number\" ? Math.floor(cacheLimitMb) : 0;",
			expect: "无穷大的上限不算",
		},
		{
			// 后果：目标不再"按档位"给 ⇒ 「不留副本」档会用**遗留的上限数字**当目标
			//（那一档上限那行是隐藏的，用户看不到它，更不知道它在生效）——
			// 于是"不留副本"清完却还留着一批，而界面上没有任何解释。
			name: "★ 目标不按档位给（「不留副本」档误用遗留的上限数字）",
			from: '\tif (isCacheDisabled(action)) return { kind: "all" };\n',
			to: "",
			expect: "不留副本档要显示",
		},

		// ── 选项生成 ──
		{
			name: "选项里混进未实现的 ask（界面上出现一个从不生效的选项）",
			from: "\tfor (const value of LOCAL_COPY_ACTIONS) options[value] = labelOf(value);",
			to: '\tfor (const value of [...LOCAL_COPY_ACTIONS, "ask"]) options[value] = labelOf(value);',
			expect: "选项集合必须与 LOCAL_COPY_ACTIONS 完全一致",
		},
		// ── 链接可访问性（1.7.0）──
		{
			// 后果：刚启动那一下（`checking`）被显示成"私有"或"公开" ⇒ 界面在**还不知道**
			// 的时候报了一个具体结论。状态那一项是用户唯一能看到的事实来源，不许猜。
			name: "★ 每个状态都套同一句文案（刚启动就报出假结论）",
			from: "\treturn `connectionStatus_${state}`;",
			to: '\treturn "connectionStatus_private";',
			expect: "每个状态都要有文案 key：checking",
		},
		{
			// 后果：私有被涂成红色 ⇒ 用户以为连接坏了，跑去改一个**正当**配置
			//（只给自己用是合理用法，只是链接对外是死的）。
			name: "★ 私有被涂成错误（把正当配置显示成故障）",
			from: '\t\tcase "private":\n\t\t\t// 私有是**正当选择**（只给自己用）：既不是错误，也不是警告\n\t\t\treturn "accent";',
			to: '\t\tcase "private":\n\t\t\t// 私有是**正当选择**（只给自己用）：既不是错误，也不是警告\n\t\t\treturn "error";',
			expect: "私有不是警告也不是错误",
		},
		{
			// 后果：**又把实现细节倒给用户** —— 正常（公开 / 私有）时多出一行
			// 「存储拒绝匿名访问…」，用户看到的是我们怎么测的，而不是结论。
			// 用户 2026-10-18 明确要求去掉这一段。
			name: "★ 正常结论也解释一遍（把实现细节倒给用户）",
			from: '\treturn kind !== "ok" && kind !== "forbidden";',
			to: "\treturn true;",
			expect: "★ 公开已由灯说明，不再解释一遍",
		},
		{
			// 后果：**同一句话说两遍** —— 结果里先说「别人也能打开」，再补一句「公开访问」。
			// 用户 2026-10-18 明确报过的冗余（提示里出现了两次公开访问）。
			name: "★ 结论报了两次（已说「别人也能打开」还补一句「公开访问」）",
			from: '\treturn kind === "missing" || kind === "webpage" || kind === "unstable" || kind === "other";',
			to: "\treturn true;",
			expect: "★ 已说「别人也能打开」，别再补一句「公开访问」",
		},
		{
			// 后果：黄灯被读成"警告 / 待处理" ⇒ 用户去改一个**正当**配置（桶私有），
			// 改完反而把链接暴露出去。用户 2026-10-18 明确要求换掉黄色，别改回去。
			name: "★ 私有又用回黄色（把「正当配置」显示成「待处理」）",
			from: '\t\tcase "private":\n\t\t\t// 私有是**正当选择**（只给自己用）：既不是错误，也不是警告\n\t\t\treturn "accent";',
			to: '\t\tcase "private":\n\t\t\t// 私有是**正当选择**（只给自己用）：既不是错误，也不是警告\n\t\t\treturn "warn";',
			expect: "私有不是警告也不是错误",
		},
		// ⚠️ 这里原有两条锚在 `coherentLocalCopy` 上的变异（"私有+不留副本被放行"、
		// "坏副本策略被读成 trash"）。那个函数 1.7.0 当天**下架**：用户问「仅内部就必须下载吗？
		// 不能像图床那样只存在 S3？」⇒ 那个组合不再是矛盾，改走预签名地址。
		// 锚在已删代码上只会"找不到目标"（假绿）⇒ 两条一起删掉，判据转到 `link-access.ts`。

		// ── 失败归类 ──
		{
			name: "404 被归成别的原因（用户会去查网络，而实际是桶名写错了）",
			from: '\t\t\treturn "bucketMissing";',
			to: '\t\t\treturn "network";',
			expect: "404 归为桶不存在",
		},
		{
			name: "未知失败类型被吞掉（该提示的不提示）",
			from: '\t\tdefault:\n\t\t\treturn "other";',
			to: '\t\tdefault:\n\t\t\treturn "auth";',
			expect: "其它 4xx 归入 other",
		},
		{
			name: "文案 key 的前缀被改（界面会显示成 key 本身而不是提示）",
			from: "\treturn `testFail_${kind}`;",
			to: "\treturn `failure_${kind}`;",
			expect: "每类失败都要有文案 key",
		},

		// ── 秘密访问密钥的钥匙串槽位名 ──
		{
			// 后果：槽位名里出现大写/非法字符 ⇒ `setSecret` **直接抛错**，
			// 秘密存不进去，而用户看到的只是"凭据被拒"。
			// 这正是最初那个缺陷的形态（密钥 ID 不允许大写），所以值得钉住。
			name: "★ 槽位名不再净化（非法字符会让 setSecret 直接抛错）",
			from: '\t\t.toLowerCase()\n\t\t.replace(/[^a-z0-9]/g, "");',
			to: "\t\t;",
			expect: "生成的槽位名必须只含小写字母、数字、短横线",
		},
		{
			// 后果：每次保存都换一个新槽位名 ⇒ 旧秘密被孤儿化，
			// 设置页那个框还是满的（从钥匙串读回的），但读取用的名字变了 ——
			// 表现为"凭据被拒"，而一切看起来都配好了。
			name: "★ 已有槽位名被丢弃、每次重新生成（旧秘密被孤儿化）",
			from: '\tconst trimmed = String(existing ?? "").trim();\n\tif (trimmed !== "") return trimmed;',
			to: '\tconst trimmed = String(existing ?? "").trim();\n\tvoid trimmed;',
			expect: "已有槽位名要原样沿用",
		},
		{
			// 后果：纯空白的槽位名被当成有效 ⇒ 拿一个空白名字去 getSecret/setSecret，
			// 秘密永远取不回来（而设置里那个字段看起来"有值"）。
			name: "纯空白的槽位名被当成有效",
			from: '\tconst trimmed = String(existing ?? "").trim();',
			to: '\tconst trimmed = String(existing ?? "");',
			expect: "纯空白的槽位名视同没有",
		},
		{
			// 后果：桶私有被涂成红色 ⇒ 用户以为"连接坏了"，去改根本没坏的东西。
			name: "★ 桶私有被当成错误而不是提示（语气误导）",
			from: '\t\tcase "forbidden":\n\t\t\treturn "warn";',
			to: '\t\tcase "forbidden":\n\t\t\treturn "error";',
			expect: "桶私有 = 提示，不是错误",
		},
		{
			// 后果：某一档从下拉里消失 ⇒ 用户**关不掉**那个自动弹出的询问。
			// 这一项存在的全部意义就是"能关掉它"，而"界面上选不到"与"代码不支持"
			// 看起来完全一样（功能静默不可达）。
			name: "★ 「无人引用的附件」少一档选项（关不掉那个自动询问）",
			from: "\tfor (const value of ORPHAN_ASK_MODES) options[value] = labelOf(value);",
			to: '\tfor (const value of ORPHAN_ASK_MODES) if (value !== "never") options[value] = labelOf(value);',
			// ⚠️ 实测先红的是**集合比对**那条（不是下面那句专门写给 `never` 的），
			// 因为"少一个取值"这件事首先表现为集合不一致。按纪律如实写这一条。
			expect: "选项集合必须与 ORPHAN_ASK_MODES 完全一致",
		},
		{
			// 后果：网络不通被说成"写入被拒" ⇒ 用户去查密钥的写权限，而真正坏的是网络。
			// 两件事的修法完全不同，而这句话是"探针回路跑不起来"时唯一的信息来源。
			name: "★ 网络失败被说成「存储拒绝写入」（把人引去查权限）",
			from: '\tif (kind === "network") return "testFail_network";',
			to: '\tif (kind === "network") return "testFail_probeWrite";',
			expect: "网络不通仍然说网络",
		},
		{
			// 后果：读不回来被说成"写入被拒" ⇒ 用户去查写权限，而上传是好的、坏的是**读**
			// （私有桶取副本 / 离线渲染全用它）。两段的修法不同，结论也必须是两句话。
			name: "★★ 读不回来被说成「写入被拒」（把人引去查错的那一边）",
			from: '\treturn step === "write" ? "testFail_probeWrite" : "testFail_probeRead";',
			to: '\treturn "testFail_probeWrite";',
			expect: "读不回来要说成「读取权限」",
		},
	],
});
