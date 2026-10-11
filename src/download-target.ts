/**
 * 回退下载的**落点与命名**（1.3.0 / D-17，「取消缓存目录」）。
 *
 * ## 它取代了什么
 *
 * 此前回退下载的目标是 `cachePathFor(key)`：缓存目录 + 对象 key —— 路径是
 * **推导出来的确定值**，好处是"索引丢了也推得出、永远不会撞名"，代价是用户看到的
 * 文件名是 `<哈希>.png` 或 `<名字>-<哈希>.png`，且文件不在附件目录里。
 *
 * 取消缓存目录之后，副本就是**附件目录里那份本来的文件**，于是落点必须回答两个
 * 新问题：**叫什么**（用户能认出来）与**撞名怎么办**（不覆盖用户的东西）。
 *
 * ## 三层命名（"尽量用原始文件名"的兑现方式）
 *
 * 1. **索引条目的 `sourceName`** —— 上传时记下的原始文件名，保真度最高；
 * 2. **`displayNameForKey(key)`** —— C2 之后 key 自带名字（`报告-<哈希>.pdf`），
 *    哪怕这一档没有索引条目（「不留副本」）也能反推出 `报告.pdf`；
 * 3. **key 本身** —— C2 之前上传的老对象就是 `<哈希>.<扩展名>`：取不到名字时
 *    如实用它（难看，但**绝不硬猜**，也不会因此写不出副本）。
 *
 * ## 撞名：先比内容，再按 Windows 的规矩加序号
 *
 * ⚠️ 顺序是**先比内容哈希**，不是直接加序号 —— 否则每次渲染一张"本地已有一份
 * 同样内容"的图，都会多出一个 `名字-2`（同一个对象反复下载会堆出一串序号文件）。
 * 内容相同 ⇒ 复用现有的那份（零网络、零新文件）。
 *
 * 内容不同 ⇒ `名字 1.ext`、`名字 2.ext`…（与粘贴落盘那条路的 `uniqueVaultPath`
**同一约定**：库里只该有一套编号规则）。
 * 两代 key 都带完整 64 位哈希（老 key 是 `<哈希>.ext`，C2 是 `<名字>-<哈希>.ext`），
 * 所以"比内容"这一步**永远有依据**；只有用户自定义了不含 `{hash}` 的模板时取不到
 * 哈希，那时按"内容不同"处理（宁多加一个序号，不覆盖已有的）。
 *
 * ## 出错方向（与 doc 里那条纪律一致）
 *
 * `exists` / `hashOf` 抛错时按**"已占用且内容不同"**处理 ⇒ 走向序号分支。
 * 与 `core/download.ts` 的 `exists`（出错返 false ⇒ 去下载）看似相反，其实同向：
 * 两者都倒向"**不动已有的文件**"，因为多一个序号文件可恢复、覆盖用户的东西不可恢复。
 */

import { displayNameForKey, hashFromKey, sanitizeFilename } from "./object-key";

/**
 * 撞名时最多试几个序号。
 *
 * 到顶还撞（那意味着同一目录里有几十个同名文件）就不再往下试了：改用时间戳兜底。
 * ⚠️ 有个上界是刻意的 —— 没有它，一个病态的目录会让这里变成无限循环
 * （每次 `exists` 都返回 true 时循环不终止，而它跑在渲染路径上）。
 */
const MAX_SUFFIX_ATTEMPTS = 50;

/**
 * 序号写成 `名字 1.ext`、`名字 2.ext`……
 *
 * ⚠️ 与 `vault-files.ts` 的 `uniqueVaultPath`（粘贴落盘那条路）**同一约定**。
 * 两处各造一套（例如这里用 `名字-2.ext`）会让同一次撞名在两种入口下产生两种名字，
 * 用户看到的是"同一个库里有两套编号规则"，而这类不一致不会报错。
 */
function withSuffix(stem: string, ext: string, n: number): string {
	return `${stem} ${n}${ext}`;
}

/** 这个名字"有实在内容"吗（全是空白/点/下划线的不算）。与 `sanitizeFilename` 的兜底判据同源。 */
function hasSubstance(raw: unknown): boolean {
	return typeof raw === "string" && /[^\s._]/.test(raw.trim());
}

/**
 * 这次下载该用什么文件名（**不含目录**）。
 *
 * 三级兜底见模块头。返回值永远是一个可安全落进 vault 的单个文件名
 * （过了 `sanitizeFilename`：无分隔符、无 `..`、非空、长度受限）。
 */
export function localNameForKey(key: unknown, sourceName?: unknown): string {
	if (hasSubstance(sourceName)) return sanitizeFilename(typeof sourceName === "string" ? sourceName.trim() : "");

	const parsed = displayNameForKey(key);
	if (hasSubstance(parsed)) return sanitizeFilename(parsed);

	return sanitizeFilename(typeof key === "string" ? key : "");
}

export interface DownloadTargetInput {
	/** 对象 key（上层判过非空）。 */
	key: string;
	/** 索引条目的原始文件名（没有条目时留空）。 */
	sourceName?: unknown;
	/** 落点目录（vault 相对；空串 = vault 根目录）。 */
	folder: string;
	/** "这个路径被占用了吗"。**抛错按"占用"处理**（见模块头）。 */
	exists: (path: string) => Promise<boolean>;
	/** 读一个已存在文件的内容哈希；读不到返回 `null`（按"内容不同"处理）。 */
	hashOf: (path: string) => Promise<string | null>;
}

export type DownloadTargetPlan =
	/** 落到一个空位（新文件）。 */
	| { kind: "new"; path: string }
	/**
	 * 目标路径上已经有一份**同内容**的文件 ⇒ 复用它（不下载、不新建）。
	 * 调用方要把它登记进索引 —— 否则每次渲染都会重新走一遍这个判定。
	 */
	| { kind: "reuse"; path: string };

function joinPath(folder: string, name: string): string {
	// 归一：反斜杠、首尾斜杠、以及**空段**（`a//b` 这种设置值照样能用）。
	// 与 `object-key.ts` 的 `sanitizeKey` 同一条纪律：路径里的空段在真实文件系统上
	// 往往"看起来能用"，却会让索引里记的路径与渲染时拼出来的路径对不上。
	const clean =
		typeof folder === "string"
			? folder
					.replace(/\\/g, "/")
					.split("/")
					.filter((segment) => segment !== "" && segment !== ".")
					.join("/")
			: "";
	return clean ? `${clean}/${name}` : name;
}

/** 拆成"主干 + 扩展名"（点在开头不算扩展名，与 `sanitizeFilename` 同一条判据）。 */
function splitName(name: string): { stem: string; ext: string } {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: "" };
}

async function looksOccupied(probe: (path: string) => Promise<boolean>, path: string): Promise<boolean> {
	try {
		return await probe(path);
	} catch {
		// 探针出错 ⇒ 当作"占用"。多一个序号文件是可恢复的小浪费，
		// 覆盖用户已有的文件是不可恢复的事故。
		return true;
	}
}

async function readHash(probe: (path: string) => Promise<string | null>, path: string): Promise<string | null> {
	try {
		const value = await probe(path);
		return typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : null;
	} catch {
		return null;
	}
}

/**
 * 算出这次下载的落点。
 *
 * **不发任何网络请求**，只问两个探针（存在性 / 内容哈希）—— 网络只发生在真正
 * 下载那一步，这样"要不要下"与"下到哪"是两件可以分别验证的事。
 */
export async function planDownloadTarget(input: DownloadTargetInput): Promise<DownloadTargetPlan> {
	const name = localNameForKey(input.key, input.sourceName);
	const keyHash = hashFromKey(input.key);
	const { stem, ext } = splitName(name);

	let candidate = joinPath(input.folder, name);
	for (let attempt = 0; attempt < MAX_SUFFIX_ATTEMPTS; attempt += 1) {
		if (!(await looksOccupied(input.exists, candidate))) return { kind: "new", path: candidate };

		// 内容相同 ⇒ 复用（同一个对象在同一个目录里只留一份）
		if (keyHash) {
			const existing = await readHash(input.hashOf, candidate);
			if (existing === keyHash) return { kind: "reuse", path: candidate };
		}

		// ⚠️ 候选也要过同一套判据（占用 + 同内容复用）：只试"空位"而跳过内容比较，
		// 会在目录里已经有 `名字 1.ext`（同内容）时白白多写一份
		candidate = joinPath(input.folder, withSuffix(stem, ext, attempt + 1));
	}

	// 序号试到顶（病态目录）：用时间戳兜底，绝不再往下试
	return { kind: "new", path: joinPath(input.folder, `${stem} ${Date.now()}${ext}`) };
}
