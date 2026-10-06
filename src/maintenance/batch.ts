/**
 * 批量上传：挑选候选文件（**纯判定**）。
 *
 * ## 这个功能补的是哪个洞
 *
 * 插件是后来才装的，而用户库里早就有几百张本地附件。没有这一条，
 * "上传到自己的图床"只对**新粘贴**的图成立 —— 老图永远是本地的。
 *
 * ## 谨慎的地方：这是唯一会改动**用户笔记**的功能
 *
 * 上传本身不碰笔记；但要让老图真正"搬到图床"，笔记里的本地链接必须换成远端
 * 链接 —— 那一步会重写用户的 `.md` 文件。所以选候选时**宁少不多**：
 *
 * - 只挑**扩展名在启用清单里**的（用户已经声明过"这些才是要处理的图"）；
 * - 跳过**已经在索引里**的（同一个 key = 同一份内容，重复上传没有意义，
 *   而且会让"哪些是新的"变得难以解释）；
 * - 跳过尺寸为 0 的（多半是同步中的占位文件，读出来是空的 ——
 *   上传一个空文件比跳过更糟：远端会多一个坏对象）。
 */

import type { PluginSettings } from "../types";
import type { CacheIndex } from "../cache/index";
import { isExtensionEnabled } from "../settings";

/** 库内文件的最小形状。 */
export interface VaultFileLike {
	path: string;
	extension?: string;
	stat?: { size?: number } | null;
}

export interface CandidateOptions {
	settings: PluginSettings;
	/** 已在索引里的 key 也算"处理过" —— 但候选文件的 key 要上传后才知道， */
	/** 所以这里按**路径**排除：索引记着某个副本的路径就是它。 */
	index: CacheIndex;
}

export interface CandidateSelection {
	/** 要上传的文件路径。 */
	paths: string[];
	/** 被跳过的原因统计（让用户看得见"为什么只传了 N 个"）。 */
	skipped: { reason: string; count: number }[];
}

/** 挑出要批量上传的文件。 */
export function selectUploadCandidates(files: readonly VaultFileLike[], options: CandidateOptions): CandidateSelection {
	const paths: string[] = [];
	const reasons = new Map<string, number>();
	const bump = (reason: string) => reasons.set(reason, (reasons.get(reason) ?? 0) + 1);

	for (const file of files) {
		if (!file || typeof file.path !== "string" || file.path.trim() === "") {
			bump("路径为空");
			continue;
		}

		const extension = String(file.extension ?? "").replace(/^\./, "");
		if (!isExtensionEnabled(extension, options.settings)) {
			bump("扩展名不在启用清单里");
			continue;
		}

		// 尺寸为 0：多半是同步中的占位文件。传上去会得到一个坏对象，
		// 而"跳过它、等下次"没有任何损失。
		if (typeof file.stat?.size === "number" && file.stat.size <= 0) {
			bump("文件为空（可能是同步中的占位）");
			continue;
		}

		// 索引里已经有指向这个路径的副本 ⇒ 它已经被处理过了。
		if (options.index.findByCachePath(file.path)) {
			bump("已经在缓存索引里");
			continue;
		}

		paths.push(file.path);
	}

	return {
		paths,
		skipped: [...reasons].map(([reason, count]) => ({ reason, count })),
	};
}
