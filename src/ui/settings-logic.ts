/**
 * 设置界面的**纯逻辑**（不碰 DOM）。
 *
 * 与 `editor-hooks` 同样的理由分开：这些判断决定"界面显示什么"以及
 * "存进去的是什么"，都属于**翻错了不会报错、只会长期困惑**的那类。
 * 拆成纯函数才能穷举，也才能在不用真实 Obsidian 的情况下验证。
 */

import type { LocalCopyAction } from "../types";
import { LOCAL_COPY_ACTIONS } from "../types";

/**
 * 下拉选项：由**类型清单**生成 `{取值: 文案}`（正是 `SettingDropdownControl.options` 的形状）。
 *
 * 从清单生成而不是手写，是为了让"界面上能选的值"与"类型允许的值"只有一处定义 ——
 * 将来加一个取值，它自动出现在界面上；漏了也不会出现"选了但类型不认"的组合。
 */
export function localCopyOptions(labelOf: (value: LocalCopyAction) => string): Record<string, string> {
	const options: Record<string, string> = {};
	for (const value of LOCAL_COPY_ACTIONS) options[value] = labelOf(value);
	return options;
}

/**
 * 解析用户输入的扩展名清单。
 *
 * **逗号、顿号、空格、换行都当分隔符** —— 用户会怎么敲是不确定的：
 * 从别处粘过来常见的是换行或顿号，而手敲通常是逗号。与其在校验里报错
 * 让用户猜格式，不如都收下。
 *
 * 归一化与 `settings.ts` 的 `textListValue` **保持同一套规则**
 * （去空白、去前导点、转小写、按出现顺序去重、丢空串）——
 * 两处不一致会导致"界面显示的和实际生效的不一样"。
 */
export function parseExtensionList(text: unknown): string[] {
	if (typeof text !== "string") return [];
	const out: string[] = [];
	for (const piece of text.split(/[,，、;；\s]+/)) {
		const normalized = piece.trim().toLowerCase().replace(/^\./, "");
		if (normalized === "") continue;
		if (!out.includes(normalized)) out.push(normalized);
	}
	return out;
}

/** 把清单渲染回输入框的文本（逗号 + 空格分隔，便于阅读与继续编辑）。 */
export function formatExtensionList(list: unknown): string {
	if (!Array.isArray(list)) return "";
	return list.filter((x): x is string => typeof x === "string" && x.trim() !== "").join(", ");
}

/**
 * 「缓存目录」这一项要不要显示。
 *
 * ⚠️ 这是消除"矛盾配置"的**界面侧**手段：只有选了「移入缓存」，
 * 缓存目录才有意义。留着它可见会让用户以为改它有用 ——
 * 而实际上 `planLocalCopy` 在其余两种取值下根本不会用到它。
 * 看不见的字段不会产生矛盾。
 */
export function shouldShowCacheFolder(action: unknown): boolean {
	return action === "cache";
}

/**
 * 「测试连接」失败的归类。
 *
 * 不直接把 `error.message` 抛给用户：那是给排查用的（可能带一屏 XML），
 * 而这里要给的是**下一步做什么**。所以先归类，再取对应文案。
 *
 * 按 `.kind` 判而不是按 `instanceof`：这个函数要在没有真实 `S3Error` 实例的
 * 测试里也能用，而 `kind` 正是 `errors.ts` 已经定好的稳定契约。
 */
export type ConnectionFailureKind = "auth" | "bucketMissing" | "network" | "throttled" | "server" | "other";

export function classifyConnectionFailure(error: unknown): ConnectionFailureKind {
	const kind =
		typeof error === "object" && error !== null && "kind" in error
			? (error as { kind?: unknown }).kind
			: undefined;

	switch (kind) {
		case "auth":
			return "auth";
		case "notFound":
			// `headBucket` 把 404 处理成 `{exists:false}`，所以走到这里的 404
			// 只可能来自别处；仍归为"桶不存在"最贴近用户的处置动作。
			return "bucketMissing";
		case "network":
			return "network";
		case "throttled":
			return "throttled";
		case "server":
			return "server";
		default:
			return "other";
	}
}

/** 归类 → 文案 key。 */
/**
 * 把"已记住的站点"整理成给用户看的文本（**纯函数**，便于穷举）。
 *
 * 单独成函数而不是写在 `render` 回调里，理由与这个文件里其它几个一样：
 * 这种"值 → 给人看的一行字"的翻译最容易写错（漏了空态、把两个决定搞反），
 * 而它写在渲染回调里就**没有办法断言**。
 *
 * 每一行都是 `站点 — 决定`。用 `allow`/`deny` 之外的东西当标签（由调用方传入已翻译的文案），
 * 因为用户看不懂 `allow`。
 */
export function describeRememberedSites(
	records: readonly { host: string; decision: string }[],
	labels: { allow: string; deny: string; empty: string }
): string {
	if (records.length === 0) return labels.empty;
	return records
		.map((record) => `${record.host} — ${record.decision === "allow" ? labels.allow : labels.deny}`)
		.join("\n");
}

export function connectionFailureKey(kind: ConnectionFailureKind): string {
	return `testFail_${kind}`;
}
