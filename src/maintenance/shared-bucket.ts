/**
 * R25 共享桶：**跨库引用判据**（占用法则 ＋ 删除期守卫 ＋ 声明写入）。
 *
 * ## 它解决的问题
 *
 * 候选生成是纯本地的（台账 − 本库引用），零网络、可离线作答。但"本库看不见"不等于
 * "没人用" —— 别的设备、共用同一个桶的另一个库可能还在引用它。所以**删除之前**必须
 * 去桶里问一次：`_acc/v1/` 下各设备写的引用声明里，还有没有这个 hash。
 *
 * ## 三条纪律
 *
 * 1. **声明只否决不确认**：它只能把"能删"变成"不能删"，永远不会把"不能删"变成"能删"。
 *    进候选的前提是本设备台账里有它 —— 别人的对象、第三方工具传的对象根本进不了候选。
 * 2. **读不到就不出候选**：`_acc/` 不存在（首次使用 / 旧版）或任何一份声明读不出来，
 *    整轮放弃。把"没读到"当成"没人引用"是这一层唯一不可接受的错。
 * 3. **执行期还要再看一眼**：批量删除可能跑很久，期间别的设备写入了新声明 ⇒
 *    每 N 个重算一次指纹（数量 ＋ key 摘要 ＋ 最新 `LastModified`），一变就停剩余批次。
 *
 * ⚠️ 本模块只有**一份**占用判据：`occupantsOtherThan`。界面上"这条还能不能删"与
 * 执行时"这一条删不删"都必须调它 —— 写两遍必然一处硬一处软（见项目纪律）。
 */

import type {
	DeclarationEntry,
	DeclarationFailure,
	DeclarationIo,
	DeclarationRef,
	DeclarationState,
} from "../s3/declaration";
import {
	applyDeclarationSteps,
	loadDeclarations,
	loadDeviceState,
	planUpdates,
	scanDeclarations,
} from "../s3/declaration";

/** 一份身份：哪个库的哪台设备。 */
export interface SelfIdentity {
	readonly vault: string;
	readonly device: string;
}

/** 谁在引用某个 hash。 */
export interface Occupant {
	readonly vault: string;
	readonly device: string;
}

/** hash → 引用它的设备。 */
export type Occupancy = ReadonlyMap<string, readonly Occupant[]>;

/**
 * 从桶里读到的声明建"占用表"。
 *
 * 同一设备可能有多份文件（`head` ＋ 若干段）⇒ 这里取**并集**。
 * 并集是**多保护**的方向（同一 hash 在 head 里删掉、旧段里还留着时，仍算被占用），
 * 而精确消歧（同 hash 取段序号最大）在写端由 `mergeRefs` 负责 —— 读端宁可多保护一次。
 */
export function occupancyOf(entries: readonly DeclarationEntry[]): Occupancy {
	const table = new Map<string, Occupant[]>();
	const seen = new Set<string>();
	for (const entry of entries) {
		const who = `${entry.vault}/${entry.device}`;
		for (const hash of Object.keys(entry.declaration.refs)) {
			const slot = `${who}|${hash}`;
			if (seen.has(slot)) continue;
			seen.add(slot);
			const list = table.get(hash);
			const occupant: Occupant = { vault: entry.vault, device: entry.device };
			if (list) list.push(occupant);
			else table.set(hash, [occupant]);
		}
	}
	return table;
}

/**
 * 该 hash 被**别人**引用的情况（自己那份不算）。
 *
 * ⚠️ 为什么排除自己：本设备自己的引用已经在本库引用快照里了（候选生成那一步就扣掉了）。
 * 若把"自己还引用着"也算成占用，那么"某笔记删了引用、但声明还没同步减掉"的短暂窗口里，
 * 这个对象就永远删不掉 —— 而用户看到的会是"我明明没在用了，它一直躺在待清理里"。
 */
export function occupantsOtherThan(
	occupancy: Occupancy,
	hash: string,
	self: SelfIdentity
): readonly Occupant[] {
	const list = occupancy.get(hash);
	if (!list || list.length === 0) return [];
	return list.filter((occupant) => !(occupant.vault === self.vault && occupant.device === self.device));
}

/** 一批 hash 里，哪些被别的设备占着（键＝hash，值＝占用者）。 */
export function occupiedByOthers(
	occupancy: Occupancy,
	hashes: Iterable<string>,
	self: SelfIdentity
): Map<string, readonly Occupant[]> {
	const denied = new Map<string, readonly Occupant[]>();
	for (const hash of hashes) {
		const others = occupantsOtherThan(occupancy, hash, self);
		if (others.length > 0) denied.set(hash, others);
	}
	return denied;
}

// ─────────────────────────── 删除期守卫 ───────────────────────────

/**
 * 删除开始前的结论。
 *
 * `ok: false` 的三种原因要给**完全不同的话**：
 * - `no-declaration`：桶里没有声明（首次使用 / 别的设备都是旧版）⇒ 提醒"还没启用共享桶保护"；
 * - `failed` / `corrupt` / `unstable` / `too-many`：读到了但不可信 ⇒ 说清是权限、网络还是形状。
 * ⚠️ 两种都不许说成"没人引用"。
 */
export type GuardStart =
	| {
			readonly ok: true;
			readonly isDenied: (hash: string) => boolean;
			readonly occupantsOf: (hash: string) => readonly Occupant[];
			readonly declarationCount: number;
	  }
	| { readonly ok: false; readonly reason: "no-declaration" | DeclarationFailure; readonly detail: string };

/** 检查点结论。`failed` 与 `changed` 一样要停，只是话不同。 */
export type GuardCheckpoint = "same" | "changed" | "failed";

/**
 * 删除期守卫。**由接线层构造一次、整批共用**：声明只读一遍，与候选数量无关。
 */
export interface CleanupGuard {
	begin: () => Promise<GuardStart>;
	checkpoint: () => Promise<GuardCheckpoint>;
}

/**
 * 造一个守卫（真实 I/O 由调用方注入）。
 *
 * `begin` 读全桶声明；`checkpoint` 只重算**指纹**（不重读内容）：既然是"数量 ＋ key 摘要 ＋
 * 最新 LastModified"，任何一次写入都会让它变，而它比逐个重读便宜得多。
 */
export function createSharedBucketGuard(options: {
	readonly io: DeclarationIo;
	readonly self: SelfIdentity;
}): CleanupGuard {
	const { io, self } = options;
	let occupancy: Occupancy | null = null;
	let baseline = "";

	return {
		begin: async (): Promise<GuardStart> => {
			const load = await loadDeclarations(io);
			if (!load.ok) {
				return { ok: false, reason: load.reason, detail: load.detail };
			}
			// ⚠️ 一份声明都没有 ⇒ 不是"没人引用"，是"没有可用的跨库声明"
			if (load.entries.length === 0) {
				return { ok: false, reason: "no-declaration", detail: "" };
			}
			occupancy = occupancyOf(load.entries);
			baseline = load.fingerprint;
			const table = occupancy;
			return {
				ok: true,
				isDenied: (hash: string) => occupantsOtherThan(table, hash, self).length > 0,
				occupantsOf: (hash: string) => occupantsOtherThan(table, hash, self),
				declarationCount: load.files.length,
			};
		},
		checkpoint: async (): Promise<GuardCheckpoint> => {
			const scan = await scanDeclarations(io);
			if (!scan.ok) return "failed";
			return scan.fingerprint === baseline ? "same" : "changed";
		},
	};
}

// ─────────────────────────── 声明写入 ───────────────────────────

/** 声明写入的结果。失败的方向永远是"这一批别传"，不是"照传但没保护"。 */
export type DeclarationWriteResult =
	| { readonly ok: true; readonly steps: number }
	| { readonly ok: false; readonly reason: "read-failed" | "write-failed"; readonly detail: string };

export interface DeclarationWriteOptions {
	readonly io: DeclarationIo;
	readonly self: SelfIdentity;
	/** 时钟（测试要能固定）。 */
	readonly now?: () => Date;
}

/**
 * 把一批**新增**引用写进本设备的声明。
 *
 * ## 顺序是安全边界
 *
 * 调用方必须在 **PUT 对象之前**调它（`ingest` / 批量上传都如此）：
 * 先有声明、后有对象 ⇒ 最坏情况是"声明里有一个还不存在的 hash"（无害，删不掉东西）；
 * 反过来（先 PUT、后写声明）就有一段时间对象**没有任何保护**，而清理恰好在这时跑，
 * 就会把它判成孤儿删掉。
 *
 * 读不到现状（`loadDeviceState` 返回 `null`）⇒ **不写**，返回 `read-failed`。
 * ⚠️ 不能退化成"当成空的现状"：那会覆盖掉 head 里已有的几百条引用，
 * 那些对象从此失去保护。
 */
export async function declareRefs(
	options: DeclarationWriteOptions,
	adds: Readonly<Record<string, DeclarationRef>>,
	removes: readonly string[] = []
): Promise<DeclarationWriteResult> {
	const { io, self } = options;
	const now = (options.now ?? (() => new Date()))().toISOString();

	const state: DeclarationState | null = await loadDeviceState(io, self.vault, self.device);
	if (!state) return { ok: false, reason: "read-failed", detail: "" };

	let steps;
	try {
		steps = planUpdates({ vault: self.vault, device: self.device, state, adds, removes, now });
	} catch (error) {
		return { ok: false, reason: "write-failed", detail: messageOf(error) };
	}
	try {
		const done = await applyDeclarationSteps(io, steps);
		return { ok: true, steps: done };
	} catch (error) {
		return { ok: false, reason: "write-failed", detail: messageOf(error) };
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
