/**
 * 声明式设置项 ↔ 插件设置之间的**绑定**（纯逻辑，不碰 DOM）。
 *
 * ## 为什么自己实现这层，而不是用框架的默认实现
 *
 * `PluginSettingTab` 的默认 `getControlValue` / `setControlValue` 会读写
 * `this.plugin.settings`，嵌套字段用点号键（`s3.endpoint`）表示。
 * 但"点号键是否被默认实现支持"这件事**没有写进类型定义**，也无法在本机验证
 * （跑不了真实的 Obsidian）。而绑定错了的症状是**设置存不进/读不回**，
 * 属于本项目最警惕的那类"静默失效"。
 *
 * 所以这里自己实现，代价是十几行，换来两件确定的东西：
 * ① 行为由我们能穷举的**纯函数**决定，可以用测试钉住；
 * ② 控件值与设置值不一致的那些字段（如"文本框里的字符串"对应"设置里的数组"）
 *    有一处**看得见**的转换表，而不是散在 `render` 回调里。
 *
 * ## 三个概念要分清
 *
 * - **键（key）**：`s3.endpoint` 这种点号路径，指向设置对象里的位置。
 * - **取（presentation）**：设置值 → 控件显示的值。多数是同值，`enabledExtensions` 要转成文本。
 * - **存（coercion）**：控件给的值 → 设置值。多数是同值，`enabledExtensions` 要解析成数组。
 *
 * ⚠️ 存进去的必须是**合法类型**：`settings.ts` 的合并逻辑会在下次加载时逐字段校验，
 * 类型不对就回落默认值。所以"控件是文本框、设置是数组"的字段若不在这里转换，
 * 用户的修改会在重启后被**静默重置**（表现为"改了没用"）。
 */

import { formatCacheLimitMb, formatExtensionList, parseCacheLimitMb, parseExtensionList } from "./settings-logic";

/** 把点号键切成路径段。`""` 与只含空段的键视为非法。 */
export function splitKey(key: unknown): string[] | null {
	if (typeof key !== "string") return null;
	const parts = key.split(".").map((p) => p.trim());
	if (parts.length === 0) return null;
	if (parts.some((p) => p === "")) return null;
	return parts;
}

/** 按点号键读取（路径不存在时返回 `undefined`，不抛错）。 */
export function readByKey(root: unknown, key: unknown): unknown {
	const parts = splitKey(key);
	if (!parts) return undefined;

	let node: unknown = root;
	for (const part of parts) {
		if (typeof node !== "object" || node === null) return undefined;
		node = (node as Record<string, unknown>)[part];
	}
	return node;
}

/**
 * 按点号键写入。返回是否成功。
 *
 * 路径中间缺失时**不创建**中间对象：那说明键写错了（或设置结构变了），
 * 此时"悄悄造一个中间对象"会把错误固化进 `data.json` —— 宁可什么都不做并返回 false。
 */
export function writeByKey(root: unknown, key: unknown, value: unknown): boolean {
	const parts = splitKey(key);
	if (!parts) return false;

	let node: unknown = root;
	for (const part of parts.slice(0, -1)) {
		if (typeof node !== "object" || node === null) return false;
		node = (node as Record<string, unknown>)[part];
	}
	if (typeof node !== "object" || node === null) return false;

	(node as Record<string, unknown>)[parts[parts.length - 1]] = value;
	return true;
}

/**
 * 设置值 → 控件值。
 *
 * 只列**需要转换**的字段；其余原样返回。
 */
const PRESENT: Record<string, (stored: unknown) => unknown> = {
	// 设置里是数组，文本框里是一行文本
	enabledExtensions: (stored) => formatExtensionList(stored),
	// 设置里是数字，文本框里是字符串
	cacheLimitMb: (stored) => formatCacheLimitMb(stored),
};

/**
 * 控件值 → 设置值。
 *
 * ⚠️ 这里决定"用户敲进去的东西最终以什么类型落进 `data.json`"。
 * 漏掉一个字段的转换 = 那个字段的修改会在重启后被静默重置。
 */
const COERCE: Record<string, (raw: unknown) => unknown> = {
	enabledExtensions: (raw) => parseExtensionList(raw),
	// ⚠️ 解析失败时退回 0（不限制）。正常走不到这里 —— `isWritableValue` 已经把
	// 看不懂的输入拦在外面了。但万一调用方没检查，退回"不限制"也比把一个**字符串**
	// 写进数字字段强：后者会在下次加载时被回落成默认值（同样是不限制），
	// 可用户会以为"我填的东西丢了"，且查不出原因。
	cacheLimitMb: (raw) => parseCacheLimitMb(raw) ?? 0,
};

/** 设置值 → 控件显示值。 */
export function toControlValue(key: unknown, stored: unknown): unknown {
	const convert = typeof key === "string" ? PRESENT[key] : undefined;
	return convert ? convert(stored) : stored;
}

/** 控件值 → 要写进设置的值。 */
export function fromControlValue(key: unknown, raw: unknown): unknown {
	const convert = typeof key === "string" ? COERCE[key] : undefined;
	return convert ? convert(raw) : raw;
}

/**
 * 该文本值是否**可以写进设置**。
 *
 * 用于少数"空值会导致功能静默失效"的字段：缓存目录为空 → 推不出缓存路径 →
 * 缓存永远不命中。这类字段宁可**不写**（保留原值），也不要写进一个坏值 ——
 * 写坏了要等用户下次重启才发现。
 *
 * 返回 `false` 时调用方应忽略这次修改。
 */
export function isWritableValue(key: unknown, value: unknown): boolean {
	if (typeof key !== "string") return false;
	if (typeof value !== "string") return true;

	switch (key) {
		case "cacheFolder":
		case "s3.region":
		case "s3.objectKeyTemplate":
			return value.trim() !== "";
		case "cacheLimitMb":
			// 解析不出来就**不写**（保留原值），而不是把用户的输入静默变成「不限制」——
			// 他刚敲了什么，框里就该留着什么。
			return parseCacheLimitMb(value) !== null;
		default:
			return true;
	}
}
