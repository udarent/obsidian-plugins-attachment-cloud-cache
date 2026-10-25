/**
 * R25 共享桶：**引用声明的纯逻辑**（布局 / 合并 / 写计划 / 压缩 / 指纹）。
 *
 * 它回答三件事，**都不碰网络**：
 * 1. 声明放在哪 —— `_acc/v1/<vault>/<device>/head.json` ＋ `seg-NNNN.json`；
 * 2. 读端怎么合并 —— `head` ＋ 所有段，**同一 hash 取段序号最大**，`head` 当最新；
 * 3. 一次变更要写几个文件 —— 新增追加 head、满 500 封存、**改/减引用定位重写那一段**、
 *    条件满足时压缩。
 *
 * ## 为什么声明是"状态"而不是"日志"
 *
 * 读它的人（别的设备、别的库）只需要回答一个问题：**这个 hash 还有人引用吗**。
 * 若声明是追加日志，每个读端都得处理墓碑与压缩 —— 任何一边漏一条就会把**别人还在用的
 * 对象**判成"没人引用"，而那个后果是删除、不可恢复。所以这里选"每个 hash 只出现在
 * 一个段里"，改动＝重写那一段。代价是一次减引用 1 GET ＋ 1 PUT（段 ≤500 条约 50KB），
 * 比"读端出一次错就删掉数据"便宜得多。
 *
 * ## 三条不许省的不变量
 *
 * 1. **段号单调递增、从不重编号** —— 读端靠"同 hash 取序号最大"消歧，重编号会让这条失效；
 * 2. **段变空写成空 `refs` 占位、不删文件** —— 段号连续是压缩与排序的前提；
 * 3. **压缩先写新段、再删旧段** —— 反过来会有一瞬间"声明里少了若干 hash"，
 *    正好有人在这时清理，就会删掉仍被引用的对象。
 *
 * ⚠️ 这里只做纯函数：I/O 由调用方执行。这样每条规则都能被套件穷举、也都能挂变异锚点。
 *
 * ⚠️ 移动端：**不许** import 任何 Node 内置模块（`check:mobile-api` 会红）；
 * 指纹用的是自家的 `sha256Pure`（同步、无 `node:crypto`、也不依赖 `crypto.subtle`）。
 */

import { hexEncode, sha256Pure, utf8Bytes } from "./hash";

/** 声明前缀。**以下划线开头**：与对象命名空间隔开；`v1` 是格式版本。 */
export const DECLARATION_ROOT = "_acc/v1";

/** 一个段的容量。500 条 ≈ 50KB —— 这就是"每次上传只多写一份声明"的成本上限。 */
export const SEGMENT_LIMIT = 500;

/**
 * `vaultId` / `deviceId` 的形状。
 *
 * ⚠️ 它同时是一道**防前缀逃逸**的闸：这两个值会拼进对象 key，一旦允许 `/` 或 `..`
 * 就能把声明写到别的前缀去。所以宁可比生成端更严 —— 不合法一律返回空串（由调用方报错）。
 */
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isSafeId(value: unknown): value is string {
	return typeof value === "string" && SAFE_ID.test(value);
}

// ─────────────────────────────── 布局 ───────────────────────────────

/** `_acc/v1/<vault>`（不含末尾斜杠）；任一段非法就给空串。 */
export function vaultPrefix(vaultId: string): string {
	if (!isSafeId(vaultId)) return "";
	return `${DECLARATION_ROOT}/${vaultId}`;
}

/** `_acc/v1/<vault>/<device>`；任一段非法就给空串。 */
export function devicePrefix(vaultId: string, deviceId: string): string {
	if (!isSafeId(vaultId) || !isSafeId(deviceId)) return "";
	return `${vaultPrefix(vaultId)}/${deviceId}`;
}

export function headKey(vaultId: string, deviceId: string): string {
	const prefix = devicePrefix(vaultId, deviceId);
	return prefix === "" ? "" : `${prefix}/head.json`;
}

/** 段序号固定 4 位补零（`seg-0007.json`）；超过 9999 自然变 5 位，解析端一起认。 */
export function segmentKey(vaultId: string, deviceId: string, seq: number): string {
	const prefix = devicePrefix(vaultId, deviceId);
	if (prefix === "" || !Number.isInteger(seq) || seq < 1) return "";
	return `${prefix}/seg-${String(seq).padStart(4, "0")}.json`;
}

/** 段文件名里的序号；`head.json` 与任何别的形状都返回 `null`。 */
export function segmentNumber(key: string): number | null {
	const match = /(?:^|\/)seg-(\d{4,})\.json$/.exec(key);
	if (!match) return null;
	const seq = Number(match[1]);
	return Number.isInteger(seq) && seq >= 1 ? seq : null;
}

export function isHeadKey(key: string): boolean {
	return /(?:^|\/)head\.json$/.test(key);
}

/** 是不是我们认的两种声明文件之一（用来过滤 `ListObjectsV2` 的结果）。 */
export function isDeclarationKey(key: string): boolean {
	return isHeadKey(key) || segmentNumber(key) !== null;
}

// ─────────────────────────────── 形状 ───────────────────────────────

/** 一条引用：`name` 用来恢复显示名，`ext` 判类型，`addedAt` 给封存排序一个确定依据。 */
export interface DeclarationRef {
	readonly name: string;
	readonly ext: string;
	readonly addedAt: string;
}

/**
 * 一份声明 = **本库当前引用的对象集合**（状态，不是日志）。
 *
 * ⚠️ `refs` 的键是**内容哈希**，不是 key —— 声明与 key 形状解耦，
 * 所以"统一对象名"换 key 时声明一个字都不用动。
 */
export interface Declaration {
	readonly v: 1;
	readonly vault: string;
	readonly device: string;
	readonly updatedAt: string;
	readonly refs: Readonly<Record<string, DeclarationRef>>;
}

export function emptyDeclaration(vaultId: string, deviceId: string, now: string): Declaration {
	return { v: 1, vault: vaultId, device: deviceId, updatedAt: now, refs: {} };
}

const HASH_KEY = /^[0-9a-f]{64}$/;

/**
 * 解析一份声明。**任何一处不合法就整份返回 `null`**（调用方据此"不出候选"）。
 *
 * ⚠️ 为什么不"跳过坏条目、保留好条目"：坏条目可能正是**唯一还引用某个对象的证据**，
 * 扔掉它等于把那个对象暴露成"没人引用"。整份不可用 ⇒ 这一轮不判、不删，方向是安全的。
 */
export function parseDeclaration(text: string): Declaration | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const source = raw as Record<string, unknown>;
	if (source.v !== 1) return null;
	if (!isSafeId(source.vault) || !isSafeId(source.device)) return null;
	if (typeof source.updatedAt !== "string") return null;
	const refs = source.refs;
	if (!refs || typeof refs !== "object" || Array.isArray(refs)) return null;

	const cleaned: Record<string, DeclarationRef> = {};
	for (const [hash, value] of Object.entries(refs as Record<string, unknown>)) {
		if (!HASH_KEY.test(hash)) return null;
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const entry = value as Record<string, unknown>;
		if (typeof entry.name !== "string" || entry.name === "") return null;
		if (typeof entry.ext !== "string") return null;
		if (typeof entry.addedAt !== "string") return null;
		cleaned[hash] = { name: entry.name, ext: entry.ext, addedAt: entry.addedAt };
	}
	return { v: 1, vault: source.vault, device: source.device, updatedAt: source.updatedAt, refs: cleaned };
}

// ─────────────────────────────── 读端合并 ───────────────────────────────

export interface SegmentState {
	readonly number: number;
	readonly decl: Declaration;
}

export interface DeclarationState {
	readonly head: Declaration | null;
	readonly segments: readonly SegmentState[];
}

/** `head` 在"谁的条目更新"这件事上永远最大（它只会比已封存的段新）。 */
const HEAD_SEQUENCE = Number.MAX_SAFE_INTEGER;

/**
 * 合并成本库的引用集合。
 *
 * 规则只有一条：**同一 hash 取序号最大的那条**（`head` 当最大）。
 * 它专门用于消化"压缩中途"这种短暂重复 —— 先写新段、后删旧段，中间必然有一小段时间
 * 同一个 hash 同时存在于新旧两处。
 */
export function mergeRefs(state: DeclarationState): Map<string, DeclarationRef> {
	const best = new Map<string, { seq: number; ref: DeclarationRef }>();

	const consider = (hash: string, ref: DeclarationRef, seq: number): void => {
		const prev = best.get(hash);
		// 序号大的赢；相等时后到者赢（同一段内不可能重复，这里只为确定性地兜底）
		if (prev !== undefined && prev.seq > seq) return;
		best.set(hash, { seq, ref });
	};

	for (const segment of [...state.segments].sort((a, b) => a.number - b.number)) {
		for (const [hash, ref] of Object.entries(segment.decl.refs)) consider(hash, ref, segment.number);
	}
	if (state.head) {
		for (const [hash, ref] of Object.entries(state.head.refs)) consider(hash, ref, HEAD_SEQUENCE);
	}

	const merged = new Map<string, DeclarationRef>();
	for (const [hash, value] of best) merged.set(hash, value.ref);
	return merged;
}

// ─────────────────────────────── 写计划 ───────────────────────────────

export type DeclarationStep =
	| { readonly kind: "write"; readonly key: string; readonly decl: Declaration }
	| { readonly kind: "delete"; readonly key: string };

export interface PlanInput {
	readonly vault: string;
	readonly device: string;
	/** 现状（读不到就用 `{ head: null, segments: [] }`：首次写）。 */
	readonly state: DeclarationState;
	/** 新增 / 更新的引用（同名 hash 出现即为**改名**，走"定位重写那一段"）。 */
	readonly adds?: Readonly<Record<string, DeclarationRef>>;
	/** 要减掉的引用（hash）。不存在就忽略 —— 这个操作必须幂等。 */
	readonly removes?: readonly string[];
	readonly now: string;
}

interface MutableSegment {
	number: number;
	refs: Record<string, DeclarationRef>;
}

/** 段内条目按 `addedAt` 升序、同值按 hash 字典序 —— 封存切块必须确定。 */
function compareEntries(a: [string, DeclarationRef], b: [string, DeclarationRef]): number {
	if (a[1].addedAt !== b[1].addedAt) return a[1].addedAt < b[1].addedAt ? -1 : 1;
	return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function nextSegmentNumber(segments: readonly SegmentState[]): number {
	let max = 0;
	for (const segment of segments) if (segment.number > max) max = segment.number;
	return max + 1;
}

/**
 * **压缩是否该发生**（只看段数与空段数，不看内容）。
 *
 * 两个触发条件各对应一种浪费：空段（删光了却留着文件）与"段数远超内容量"
 * （历史上频繁增删留下的碎片）。它**只动本设备自己那份**，别人的声明一个字都不碰。
 */
export function compactionDue(state: DeclarationState): boolean {
	const segCount = state.segments.length;
	if (segCount === 0) return false;
	let live = 0;
	let empty = 0;
	for (const segment of state.segments) {
		const size = Object.keys(segment.decl.refs).length;
		live += size;
		if (size === 0) empty += 1;
	}
	if (empty >= 2) return true;
	return segCount > Math.ceil(live / SEGMENT_LIMIT) + 2;
}

/**
 * 把一组变更翻译成**要写/要删哪些文件**。
 *
 * 顺序是契约：**所有 write 在前，所有 delete 在后**（压缩要先写新段再删旧段）。
 * 返回值里不含"读"：调用方先按现状读好再传进来。
 *
 * 出错方向：`vault` / `device` 不合法 ⇒ **抛错**（不能静默不写：那等于什么都没保护）。
 */
export function planUpdates(input: PlanInput): DeclarationStep[] {
	const { vault, device, state, now } = input;
	const prefix = devicePrefix(vault, device);
	if (prefix === "") throw new Error(`声明的 vault/device 不合法：${vault} / ${device}`);
	// 现状克隆（不改进参）
	const headRefs: Record<string, DeclarationRef> = state.head ? { ...state.head.refs } : {};
	const segments: MutableSegment[] = [...state.segments]
		.sort((a, b) => a.number - b.number)
		.map((segment) => ({ number: segment.number, refs: { ...segment.decl.refs } }));
	const touched = new Set<number>();
	let headTouched = false;

	/** 该 hash 现在在哪个段里（取序号最大的那个）；不在段里返回 null。 */
	const segmentHolding = (hash: string): MutableSegment | null => {
		let found: MutableSegment | null = null;
		for (const segment of segments) {
			if (hash in segment.refs && (found === null || segment.number > found.number)) found = segment;
		}
		return found;
	};

	// ① 减引用：在 head 就从 head 删，在段里就重写那一段
	for (const hash of input.removes ?? []) {
		if (hash in headRefs) {
			delete headRefs[hash];
			headTouched = true;
			continue;
		}
		const owner = segmentHolding(hash);
		if (!owner) continue; // 幂等：本来就没有
		delete owner.refs[hash];
		touched.add(owner.number);
	}

	// ② 新增 / 改名：已在某个段里 ⇒ 重写那一段（**不能**在 head 里再存一份）
	for (const [hash, ref] of Object.entries(input.adds ?? {})) {
		const owner = segmentHolding(hash);
		if (owner) {
			owner.refs[hash] = ref;
			touched.add(owner.number);
			continue;
		}
		// head 里已有同 hash（改名或重复确认）⇒ 覆盖，不新增条目
		headRefs[hash] = ref;
		headTouched = true;
	}

	// ③ head 溢出就封存：按时间切出最早的 500 条成新段
	let seq = nextSegmentNumber(state.segments);
	const sealed: MutableSegment[] = [];
	while (Object.keys(headRefs).length > SEGMENT_LIMIT) {
		const sorted = Object.entries(headRefs).sort(compareEntries);
		const chunk = sorted.slice(0, SEGMENT_LIMIT);
		const refs: Record<string, DeclarationRef> = {};
		for (const [hash, ref] of chunk) {
			refs[hash] = ref;
			delete headRefs[hash];
		}
		sealed.push({ number: seq, refs });
		seq += 1;
		headTouched = true;
	}

	// ④ 压缩：把（删除/改名之后的）全部段合并重写，再删掉所有旧段
	const finalSegments: SegmentState[] = [
		...segments.map((segment) => ({
			number: segment.number,
			decl: { v: 1 as const, vault, device, updatedAt: now, refs: segment.refs },
		})),
		...sealed.map((segment) => ({
			number: segment.number,
			decl: { v: 1 as const, vault, device, updatedAt: now, refs: segment.refs },
		})),
	];
	const compact = compactionDue({ head: null, segments: finalSegments });

	const writes: DeclarationStep[] = [];
	const deletes: DeclarationStep[] = [];

	const headDeclaration: Declaration = { v: 1, vault, device, updatedAt: now, refs: headRefs };
	if (headTouched || state.head === null) {
		writes.push({ kind: "write", key: `${prefix}/head.json`, decl: headDeclaration });
	}

	if (compact) {
		const merged: [string, DeclarationRef][] = [];
		for (const segment of finalSegments) merged.push(...Object.entries(segment.decl.refs));
		merged.sort(compareEntries);

		let compactSeq = nextSegmentNumber(finalSegments);
		for (let at = 0; at < merged.length; at += SEGMENT_LIMIT) {
			const chunk = merged.slice(at, at + SEGMENT_LIMIT);
			const refs: Record<string, DeclarationRef> = {};
			for (const [hash, ref] of chunk) refs[hash] = ref;
			writes.push({
				kind: "write",
				key: `${prefix}/seg-${String(compactSeq).padStart(4, "0")}.json`,
				decl: { v: 1, vault, device, updatedAt: now, refs },
			});
			compactSeq += 1;
		}
		for (const segment of finalSegments) {
			deletes.push({ kind: "delete", key: `${prefix}/seg-${String(segment.number).padStart(4, "0")}.json` });
		}
		return [...writes, ...deletes];
	}

	const sealedNumbers = new Set(sealed.map((segment) => segment.number));
	for (const segment of finalSegments) {
		// ⚠️ 封存出来的新段**必须写**（它不在 `touched` 里 —— 那里只记"被改写的旧段"）
		if (!touched.has(segment.number) && !sealedNumbers.has(segment.number)) continue;
		// 段变空也照样写（写成空 refs 占位）—— **不删文件**：段号连续是读端排序的前提
		writes.push({
			kind: "write",
			key: `${prefix}/seg-${String(segment.number).padStart(4, "0")}.json`,
			decl: segment.decl,
		});
	}
	return [...writes, ...deletes];
}

// ─────────────────────────────── 指纹 ───────────────────────────────

export interface DeclaredObject {
	readonly key: string;
	/** 服务端时间（ISO 8601）。**只用服务端时间**：本机时钟漂移不该影响判据。 */
	readonly lastModified: string;
}

/**
 * 声明集合的指纹：`数量:key 摘要:最新 LastModified`。
 *
 * 用途只有一个 —— 批量删除期间每隔 N 个重算一次，**变了就停**（说明期间有人写过声明，
 * 此刻的"没人引用"结论已经过期）。它**不是**安全判据、也不参与删除决定；
 * 所以能接受"摘要取前 64 位"这种截断。
 */
export function fingerprint(objects: readonly DeclaredObject[]): string {
	const keys = objects.map((object) => object.key).sort();
	let maxModified = "";
	for (const object of objects) {
		if (typeof object.lastModified === "string" && object.lastModified > maxModified) {
			maxModified = object.lastModified;
		}
	}
	const digest = hexEncode(sha256Pure(utf8Bytes(keys.join("\n")))).slice(0, 16);
	return `${keys.length}:${digest}:${maxModified}`;
}
