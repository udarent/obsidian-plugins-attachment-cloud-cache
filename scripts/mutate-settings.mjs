import { runMutations } from "./lib/mutate.mjs";
import { runSettingsSuite } from "./lib/settings-suite.mjs";

/**
 * 变异验证：设置模块。
 *
 * ## 这一版针对的是"字段表"设计
 *
 * 实现从"逐个字段手写合并"改成了**一张字段表 + 按表遍历**。这带来两个变化：
 *
 * 1. **漏字段从"运行期静默"变成了"编译期报错"**：字段表用映射类型标注，
 *    往 `PluginSettings` 加字段却忘了加进表里，`tsc` 直接不过。
 *    这比测试兜住更强 —— 所以变异脚本**不再**需要"漏一个字段"这种用例
 *    （它现在连编译都过不去，压根到不了运行期）。
 * 2. 剩下要守的是**每个读取函数本身**：会不会把坏值透传、会不会把空值当合法、
 *    会不会把未知字段带进来。
 *
 * ## `expect` 的取法
 *
 * 都是**实测下来真正先红的那条断言**，不是"应该会报那句"。设置套件里
 * 断言顺序决定了这一点：更早的宽泛断言会永久剥夺后面具体规则的发言权，
 * 那样变异验证就退化成了"看有没有红"。
 */
await runMutations({
	source: "src/settings.ts",
	suite: runSettingsSuite,
	mutations: [
		// ── 读取函数：坏值必须回落 ──
		{
			name: "布尔读取把坏值透传（`enabled: \"yes\"` 直接生效）",
			from: 'return (raw, fallback) => (typeof raw === "boolean" ? raw : fallback);',
			to: "return (raw, fallback) => raw;",
			expect: "s3.forcePathStyle 非布尔应回落默认",
		},
		{
			name: "字符串读取把非字符串透传（undefined 漏进设置）",
			from: 'return (raw, fallback) => (typeof raw === "string" ? raw : fallback);',
			to: "return (raw, fallback) => (raw === undefined ? fallback : raw);",
			expect: "attachmentFolder 收到类型不对的值",
		},
		{
			name: "非空字符串不再拒绝空串（cacheFolder 被清空 → 缓存静默失效）",
			from: 'return (raw, fallback) => (typeof raw === "string" && raw.trim() !== "" ? raw : fallback);',
			to: 'return (raw, fallback) => (typeof raw === "string" ? raw : fallback);',
			expect: "cacheFolder 为",
		},
		{
			name: "枚举不再校验（非法值直接生效）",
			from: "return (raw, fallback) => (allowed.includes(raw as T) ? (raw as T) : fallback);",
			to: "return (raw, fallback) => raw as T;",
			expect: "非法枚举应回落默认",
		},
		{
			name: "扩展名列表不再过滤非字符串（脏值进列表）",
			from: '\t\t\tif (typeof item !== "string") continue;',
			to: "\t\t\t// 变异：不过滤非字符串",
			expect: "脏元素必须被**过滤掉**",
		},
		{
			name: "扩展名列表接受空数组（一个都没勾 = 什么都不处理）",
			from: "return cleaned.length === 0 ? [...fallback] : cleaned;",
			to: "return cleaned;",
			expect: "空数组等于",
		},

		// ── ⭐ 字段被真的读进来（"存得进读不出"）──
		{
			name: "单个字段永远取默认值（经典的「存得进读不出」）",
			from: "\tautoUpload: boolValue(),",
			to: "\tautoUpload: (_raw, fallback) => fallback,",
			expect: "设置项 autoUpload 必须能往返持久化",
		},
		{
			name: "s3 子对象里的字段永远取默认值",
			from: "\tbucket: textValue(),",
			to: "\tbucket: (_raw, fallback) => fallback,",
			expect: "s3.bucket 必须能往返",
		},
		{
			name: "整个合并退化成「只返回默认值」（所有设置都读不出来）",
			from: "\t\tout[key] = spec[key](raw[key as string], fallback[key]);",
			to: "\t\tout[key] = fallback[key];",
			expect: "必须能往返持久化",
		},

		// ── ⭐ 未知字段与凭据 ──
		{
			name: "未知字段被带进来（脏数据在 data.json 里累积）",
			from: "\t\t...readFields(SETTINGS_SPEC, raw, rest as Omit<PluginSettings, \"s3\">),",
			// 只污染**顶层**：把 raw 直接摊进来。s3 那一路仍然走字段表，
			// 所以不会被"丢弃凭据"那条更早的断言抢先 —— 每个缺陷才能各报各的原因。
			to: "\t\t...raw,\n\t\t...readFields(SETTINGS_SPEC, raw, rest as Omit<PluginSettings, \"s3\">),",
			expect: "未知的顶层字段不应被保留",
		},
		{
			name: "凭据字段被允许进入 s3 配置（违反 SecretStorage 约束）",
			from: "\tobjectKeyTemplate: requiredTextValue(),\n};",
			to: "\tobjectKeyTemplate: requiredTextValue(),\n\taccessKeyId: textValue(),\n};",
			expect: "不得保留凭据字段",
		},

		// ── 默认值本身 ──
		{
			name: "寻址方式默认反了（默认 virtual-host → R2 直接用不了）",
			from: "\tforcePathStyle: true,",
			to: "\tforcePathStyle: false,",
			expect: "默认应为 path-style",
		},
		{
			name: "默认不再把本地副本移入缓存（离线可用的前提没了）",
			from: '\tlocalCopy: "cache" as LocalCopyAction,',
			to: '\tlocalCopy: "trash" as LocalCopyAction,',
			expect: "本地副本默认应",
		},
		{
			// 后果：本地副本的处置不再受枚举约束，而是原样透传 ⇒ 一个手改过
			// data.json、或旧版本遗留的值会一路流到处置判定里（那一层只认三个取值），
			// 表现成"上传后本地副本的行为不是我选的那个"。
			name: "★ localCopy 的枚举校验被去掉（坏值原样透传）",
			from: "\tlocalCopy: oneOfValue(LOCAL_COPY_ACTIONS),",
			to: "\tlocalCopy: textValue(),",
			expect: "非法枚举应回落默认",
		},
		{
			name: "s3 子对象不再从 data.s3 读（整块配置读不出来）",
			from: "\tconst rawS3 = isPlainRecord(raw.s3) ? raw.s3 : {};",
			to: "\tconst rawS3 = {};",
			expect: "s3.bucket 必须能往返",
		},
	],
});
