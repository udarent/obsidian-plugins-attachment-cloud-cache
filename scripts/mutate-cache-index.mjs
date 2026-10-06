import { runMutations } from "./lib/mutate.mjs";
import { runCacheIndexSuite } from "./lib/cache-index-suite.mjs";

/**
 * 变异验证：缓存索引。
 *
 * 两条主线：
 * 1. **容错加载**必须真的容错（坏输入降级而不是抛错）—— 它读失败的时刻是插件启动；
 * 2. **查表归一化**不能过头也不能不够：
 *    - 不够 → 渲染时按 URL 找不到本地副本，离线静默失效；
 *    - 过头（把路径也小写）→ 把两个不同的对象当成同一个，图显示成错的。
 */
await runMutations({
	source: "src/cache/index.ts",
	suite: runCacheIndexSuite,
	mutations: [
		{
			name: "缺少 key 的记录被当成有效（留下一条永远对不上远端的条目）",
			from: '\tconst key = pickString(raw.key).trim();\n\tif (!key) return null;',
			to: "\tconst key = pickString(raw.key).trim();",
			expect: "缺 key 的记录无法使用",
		},
		{
			name: "缺少 cachePath 的记录被当成有效（找不到本地副本）",
			from: '\tconst cachePath = pickString(raw.cachePath).trim();\n\tif (!cachePath) return null;',
			to: "\tconst cachePath = pickString(raw.cachePath).trim();",
			expect: "缺 cachePath 的记录无法使用",
		},
		{
			name: "数值字段不再校验（负数 / NaN / 字符串都进统计）",
			from: "return typeof value === \"number\" && Number.isFinite(value) && value >= 0 ? value : fallback;",
			to: "return value;",
			expect: "缺失字段应补安全默认值",
		},
		{
			// ⚠️ 刻意**不**写成 `return value;` —— 那样 `pickString(undefined)` 会返回 undefined，
			// 紧接着的 `.trim()` 直接抛 TypeError，套件以崩溃收场，
			// 报错就说不清"到底是哪条规则坏了"。改成"放过非 null 的一切"后，
			// 断言能以"非字符串 URL 应归空串"这句话点出问题。
			name: "字符串字段不再校验（对象/数组流下去，后续拼接出 [object Object]）",
			from: 'return typeof value === "string" ? value : fallback;',
			to: "return value === undefined || value === null ? fallback : value;",
			expect: "非字符串 URL 应归空串",
		},
		{
			name: "key 不再 trim（纯空白的 key 会被当成有效记录）",
			from: "const key = pickString(raw.key).trim();",
			to: "const key = pickString(raw.key);",
			expect: "纯空白的 key 等同缺失",
		},
		{
			name: "遍历顺序不再排序（落盘内容随插入顺序变化，diff 噪音 + 测试偶发失败）",
			from: "return [...this.entries.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));",
			to: "return [...this.entries.values()];",
			expect: "必须按 key 排序",
		},
		{
			name: "remove 永远返回 true（调用方无法知道其实没删掉）",
			// ⚠️  现在走 （entries 与 byUrl 两个视图一起维护，
			// 否则换域名后会在派生映射里留下指向已消失条目的幽灵记录）。
			from: "\tremove(key: string): boolean {\n\t\treturn this.erase(key);",
			to: "\tremove(key: string): boolean {\n\t\tthis.entries.delete(key);\n\t\treturn true;",
			expect: "重复删除应返回 false",
		},
		{
			name: "pruneMissing 不再真的删除（索引持续指向不存在的文件）",
			from: "\t\t\t\tthis.erase(entry.key);\n\t\t\t\tremoved.push(entry.key);",
			to: "\t\t\t\tremoved.push(entry.key);",
			expect: "留下的应是本地确实存在的那条",
		},
		{
			name: "URL 比较退回逐字相等（尾斜杠/域名大小写一变就找不到缓存）",
			// ⚠️  现在走 O(1) 的派生映射（渲染路径上每张图都会调它）。
			from: "\t\treturn this.byUrl.get(target);",
			to: "\t\treturn [...this.entries.values()].find((entry) => entry.remoteUrl === url);",
			expect: "尾斜杠差异不应影响命中",
		},
		{
			name: "URL 比较忽略主机（⭐ 把别人的图当成自己的缓存）",
			from: "return `${scheme}://${authority}${path}`;",
			to: "return `${scheme}://${path}`;",
			expect: "不同主机不应命中",
		},
		{
			name: "URL 归一化把整串小写（路径大小写敏感 → 两个对象被当成同一个）",
			from: "const path = slash === -1 ? \"\" : rest.slice(slash).replace(/\\/+$/, \"\").replace(/\\/{2,}/g, \"/\");",
			to: "const path = (slash === -1 ? \"\" : rest.slice(slash).replace(/\\/+$/, \"\").replace(/\\/{2,}/g, \"/\")).toLowerCase();",
			expect: "路径大小写**是**敏感的",
		},
		{
			name: "坏条目被静默丢弃（无从知道索引里少了东西）",
			from: '\t\t\t\tskipped.push({ reason: "缺少 key 或 cachePath（该条目无法使用）", raw });\n\t\t\t\tcontinue;',
			to: "\t\t\t\tcontinue;",
			expect: "应记录 4 条被丢弃的条目",
		},
		{
			name: "顶层结构不对时抛错（插件启动直接失败，用户连设置页都进不去）",
			from: 'skipped: [{ reason: "顶层结构不是数组，也没有 entries 数组", raw: value }],',
			to: 'skipped: (() => {\n\t\t\t\t\tthrow new Error("坏的索引结构");\n\t\t\t\t})(),',
			expect: "必须**降级为空索引**",
		},
		{
			name: "重复 key 取后出现的那条（哪条是真的取决于文件顺序）",
			from: "\t\t\tif (seen.has(entry.key)) {",
			to: "\t\t\tif (false) {",
			expect: "应保留**先出现**的那条",
		},
		{
			name: "落盘结构不再带版本号（将来无法判断要不要迁移）",
			from: "return { version: CACHE_INDEX_VERSION, entries: this.toArray() };",
			to: "return { entries: this.toArray() };",
			expect: "带版本号",
		},
	],
});
