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
			// ⚠️ 期望记的是**实测先红的那条**。原来这里是 `attachmentFolder`，
			// 但那个字段已改用 `pathValue()`（它自己判类型），于是先红的是仍在用
			// `textValue()` 的 s3 字段。变异本身没变，只是它现在照亮的断言换了。
			expect: "s3.endpoint 收到类型不对的值",
		},
		{
			// ⚠️ 同理：`cacheFolder` 已改用 `pathValue()`（归一后为空会回落默认），
			// 所以这条变异现在照的是仍在用 `requiredTextValue()` 的 s3 字段 ——
			// 它守的性质（"为空会直接不可用的字段不接受空串"）没有变。
			name: "非空字符串不再拒绝空串（会直接不可用的字段被清空）",
			from: 'return (raw, fallback) => (typeof raw === "string" && raw.trim() !== "" ? raw : fallback);',
			to: 'return (raw, fallback) => (typeof raw === "string" ? raw : fallback);',
			expect: "s3.region 为",
		},
		{
			name: "枚举不再校验（非法值直接生效）",
			from: "return (raw, fallback) => (allowed.includes(raw as T) ? (raw as T) : fallback);",
			to: "return (raw, fallback) => raw as T;",
			// ⚠️ 实测先红的是"逐字段筛坏值"那一轮里的**类型一致性**断言（`null` 输入下
			// `externalImageDefault` 必须与默认值同类型）。1.2.0（D-17）之后 `localCopy`
			// 有自己的读取器，不再是 `oneOfValue` 的用户 ⇒ 那条更具体的"非法枚举应回落默认"
			// 不再由这个变异照亮，先说话的换成了它。
			expect: "类型应与默认值一致",
		},
		// ⚠️ 1.2.0（D-17）：这里原本有**三条**锚点，全部指向 `pathValue` ——
		// 两条钉它的归一那一行（`cacheFolder` 与 `attachmentFolder` 当时共用这个读取器），
		// 一条钉它的 `required` 分支。`cacheFolder` 随缓存目录被删、`required` 分支随之
		// 没有调用方 ⇒ 前两条**收敛成一条**（见下面"用户填的路径"那条），后一条**删掉**。
		// 留着锚在已删代码上的变异只会"找不到目标" —— 那是假绿。

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
			// 变成"秘密字段也能进设置" ⇒ 旧 data.json 里的明文秘密会被**保留**下来，
			// 于是它跟着 vault 一起同步、备份、分享出去。
			//
			// ⚠️ 这里打的是 `secretAccessKey`（秘密），**不是** `accessKeyId`：
			// 后者现在本来就该在字段表里（它是标识符，且钥匙串的 ID 不允许大写、
			// 装不下它 —— 详见 types.ts 的文件头）。拿它当变异目标会变成无意义的空操作。
			name: "★ 秘密字段被允许进入 s3 配置（旧配置里的明文秘密会被保留并随 vault 同步出去）",
			// ⚠️ 锚点原先钉在 `objectKeyTemplate` 那一行上，而 1.2.0 把它从字段表里删了 ⇒
			// 改钉字段表的**结尾**（效果一样：往表里塞一个不该存在的字段）。
			from: "\tforcePathStyle: boolValue(),\n};",
			to: "\tforcePathStyle: boolValue(),\n\tsecretAccessKey: textValue(),\n};",
			expect: "合并结果不得保留凭据字段",
		},

		{
			// 后果：**升级永远不触发** ⇒ 用户的 key 形状变了却没人告诉他，
			// 而且遗留值一直躺在 data.json 里（“设置里看不见、文件里还在”）。
			// 这类缺陷没有任何报错，只表现为“某天桶里的命名悄悄变了”。
			name: "★ 遗留 key 模板不再被识别（升级静默不触发，用户不会知道命名变了）",
			from: 'return Object.prototype.hasOwnProperty.call(rawS3, "objectKeyTemplate");',
			to: "return false;",
			expect: "带模板的旧设置应被识别",
		},

		// ── 默认值本身 ──
		{
			name: "寻址方式默认反了（默认 virtual-host → R2 直接用不了）",
			from: "\tforcePathStyle: true,",
			to: "\tforcePathStyle: false,",
			expect: "默认应为 path-style",
		},
		{
			name: "默认不再保留本地副本（离线可用的前提没了）",
			from: '\tlocalCopy: "keep" as LocalCopyAction,',
			to: '\tlocalCopy: "trash" as LocalCopyAction,',
			expect: "本地副本默认应",
		},
		{
			// 后果：本地副本的处置不再受枚举约束，而是原样透传 ⇒ 一个手改过
			// data.json、或旧版本遗留的值会一路流到处置判定里，
			// 表现成"上传后本地副本的行为不是我选的那个"。
			// ⚠️ 1.2.0（D-17）：这条路现在同时管两件事 —— **枚举校验**与**遗留值折叠**
			// 都在 `localCopyValue` 里，换成 `textValue()` 之后两条规则一起消失。
			name: "★ localCopy 的读取不再校验也不再折叠（坏值与遗留值原样透传）",
			from: "\tlocalCopy: localCopyValue(),",
			to: "\tlocalCopy: textValue(),",
			// ⚠️ 实测先红的是**早**在 4 节的那条"非法枚举应回落默认"（`localCopy` 是它举的例子），
			// 而不是 4c 节新加的折叠断言 —— 换成 `textValue()` 之后枚举这一层先塌，
			// 折叠那条根本轮不到发言。两条规则在同一处实现，红哪条取决于顺序，故照实记。
			expect: "非法枚举应回落默认",
		},
		{
			// ⭐ 后果：折叠**跟着默认值走**。今天默认恰好也是 `keep`，所以症状为零；
			// 可一旦默认换成别的档，存着 `"cache"` 的老用户就会被静默搬到那个档去 ——
			// 而这个字段决定"上传后本地文件还在不在"（搬错档会让人丢文件）。
			// ⚠️ 这一条的门牙是 4c 节那条**反向断言**（"折叠不能跟着默认值走"）：
			// 少了它，"把折叠删掉"在默认值仍为 keep 时看不出任何差别。
			name: "★ 遗留值不再折叠（改为跟着默认值走 ⇒ 默认档一变，老用户被静默搬档）",
			from: '\t\tif (raw === LEGACY_LOCAL_COPY) return "keep";',
			to: "\t\t// 变异：不折叠，交给下面的默认回落",
			expect: "折叠不能跟着默认值走",
		},
		{
			// ⚠️ 锚点钉在 `s3BlockOf` 的**那一行**上（1.2.0 把"怎么读 s3 段"收敛成了一处）：
			// 坏掉它，合并逻辑与遗留键识别会**一起**失效 —— 所以红的是第一条 s3 往返断言。
			name: "s3 子对象不再从 data.s3 读（整块配置读不出来）",
			from: "return isPlainRecord(raw.s3) ? raw.s3 : {};",
			to: "return {};",
			expect: "s3.bucket 必须能往返",
		},
		{
			// 后果：用户粘进来的反斜杠/双斜杠路径被**逐字**落进 data.json 并拼进 vault 路径 ⇒
			// 生成 vault 里不存在的层级，症状是"文件不在预期的地方"，与那次粘贴看不出关系。
			name: "★ 用户填的路径不再归一（反斜杠/双斜杠逐字落盘）",
			from: "\t\treturn normalizePath(raw.trim());",
			to: "\t\treturn raw.trim();",
			expect: "附件目录要归一",
		},
	],
});
