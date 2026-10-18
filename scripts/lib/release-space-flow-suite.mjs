/**
 * **入口 ④ / F18**（「清理本地占用」，`src/plugin/release-space-flow.ts`）的断言套件。
 *
 * ## 为什么这条套件到现在才存在
 *
 * 与 A1 那次搬迁（`cloud-cleanup-flow`，2026-10-16 退役）同一个原因：这段编排此前是
 * `main.ts` 的私有方法，
 * 而套件加载不了插件类。判定层（`planReleaseSpace`）有 `release-space-suite` 守着，
 * 执行层（`deleteVerifiedCopies`）的执行路径**此前一条断言也没有** ——
 * 而这里跑的是真正的执行层（流程调的就是线上那个 `runReleaseSpace`），
 * 所以这条套件同时补上了"最关键的删除那一步到底会不会照着复核结果走"。
 *
 * ## 守的是什么
 *
 * 这一档的删法是**永久删除**（不进回收站，设计 §20.16 #7），所以重心是：
 *
 * - ⭐ **两条准入判据必须在编排层真的接上**：台账（"是我们传的"）与引用（"笔记还链着它"）。
 *   判定层算得再对，编排层把集合传错了照样删错 —— 这两条正是
 *   `mutate-load-acceptance` 里那两条锚点在盯着的东西（2026-10-13 随这次搬迁挪进来）。
 * - ⭐ **"一个都没删"必须解释**：用户刚按下"永久删除"，只看到"跳过 N 个"会以为功能坏了
 *   （真实原因只有一个：候选是纯判定，而删除前要逐个 HEAD 复核云端还有没有它）。
 * - 两种入口的差别：手动入口没有可清项**必须出声**，切档那次**不许打扰**。
 * - 读不到笔记 ⇒ 整体放弃（与 `orphan-flow.ts` 的 `checkNow` **成对**的那条兜底）。
 *
 * ⚠️ 替身纪律：笔记里的 URL 用**真实的** `publicUrlFor` 生成，不自己拼字符串 ——
 * 自己拼的话，测的是"我拼对了没有"，而不是"插件认不认自己的链接"。
 *
 * 断言在这里（与变异验证共用），入口在 `scripts/test-release-space-flow.mjs`。
 */

import assert from "node:assert/strict";
import * as mockObsidian from "./mock-obsidian.mjs";

/** 一份"够用"的 S3 配置（path-style ⇒ URL 形如 `<端点>/<桶>/<key>`）。 */
const S3 = { endpoint: "https://s3.example.com", bucket: "notes", forcePathStyle: true };

const MB = 1024 * 1024;

function noticeTexts() {
	return mockObsidian.Notice.instances.map((notice) => notice.message);
}

function assertNotice(fragments, why) {
	const texts = noticeTexts();
	assert.ok(
		texts.some((text) => fragments.every((fragment) => text.includes(fragment))),
		`${why}：期望有一条提示同时包含 ${JSON.stringify(fragments)}，实际 ${JSON.stringify(texts)}`
	);
}

function assertNoNotice(why) {
	assert.equal(noticeTexts().length, 0, `${why}：不该弹任何提示，实际 ${JSON.stringify(noticeTexts())}`);
}

export async function runReleaseSpaceFlowSuite(mod) {
	const { releaseLocalSpace, translate } = mod;

	/**
	 * 造一个假 `PluginContext`（+ 记账用的 `calls`）。
	 *
	 * @param {object} options
	 *   `entries` 索引条目（`{key, cachePath, size, sourceName?}`）、`uploaded` 台账里的 key、
	 *   `notes` 笔记（`{path, text}` 或 `{path, readError}`）、`onDisk` 磁盘上真实存在的路径、
	 *   `cloudHas` 逐个 key 的"云端现在还有吗"（`true`/`false`/`"throw"`）、`confirm` 确认框答案、
	 *   `localCopy` 档位（默认 `"trash"`）、`cacheLimitMb` 上限（默认 `0` = 不限制）。
	 *
	 * ⚠️ 2026-10-15 起这个夹具**必须**声明自己在哪一档：同一个按钮在「不留副本」档是"全清"、
	 * 在「保留副本 + 上限」档是"清到上限以内"，两者连候选池之外的目标都不一样。
	 * 老用例全部是「不留副本」档 ⇒ 默认值就是它（`trash`）。
	 */
	function makeCtx(options = {}) {
		const entries = options.entries ?? [];
		const onDisk = new Set(options.onDisk ?? entries.map((entry) => entry.cachePath));
		const notes = options.notes ?? [];
		const uploaded = new Set(options.uploaded ?? entries.map((entry) => entry.key));
		const confirmAnswer = options.confirm ?? true;

		const calls = {
			deleted: [],
			confirm: null,
			cardInputs: null,
			cardLimit: null,
			persisted: 0,
			/** `confirmRemote` 问过哪些 key（＝执行层真的逐个复核了云端）。 */
			cloudAsked: [],
		};

		const byPath = new Map(notes.map((note) => [note.path, note]));

		const index = {
			get: (key) => entries.find((entry) => entry.key === key),
			toArray: () => entries.map((entry) => ({ ...entry })),
			uploadedKeys: () => [...uploaded],
			findByCachePath: (path) => entries.find((entry) => entry.cachePath === path),
			remove: (key) => {
				const at = entries.findIndex((entry) => entry.key === key);
				if (at < 0) return false;
				entries.splice(at, 1);
				return true;
			},
		};

		const ctx = {
			app: {
				vault: {
					getMarkdownFiles: () => notes.map((note) => ({ path: note.path, extension: "md" })),
					getFiles: () => notes.map((note) => ({ path: note.path, extension: "md" })),
					read: async (file) => {
						const found = byPath.get(file.path);
						if (found && found.readError) throw new Error(found.readError);
						return found ? found.text : "";
					},
					adapter: {
						// 只用来问"这份副本在磁盘上吗、多大"（`readCopies` 的唯一用法）
						stat: async (path) => {
							if (!onDisk.has(path)) return null;
							const entry = entries.find((item) => item.cachePath === path);
							return { size: entry ? entry.size : 0 };
						},
					},
					getAbstractFileByPath: (path) => (onDisk.has(path) ? { path } : null),
					delete: async (file) => {
						calls.deleted.push(file.path);
						onDisk.delete(file.path);
					},
				},
			},
			manifest: { dir: ".obsidian/plugins/attachment-cloud-cache" },
			settings: {
				s3: { ...S3 },
				localCopy: options.localCopy ?? "trash",
				cacheLimitMb: options.cacheLimitMb ?? 0,
			},
			t: (key, params) => translate("en", key, params ?? {}),
			currentIndex: () => index,
			hostContext: () => ({ persistIndex: async () => {} }),
			buildClient: () => null,
			fileCards: (items, limit) => {
				calls.cardInputs = items;
				calls.cardLimit = limit;
				return items.slice(0, limit).map((item) => ({ ...item, thumb: null }));
			},
			confirmMaintenance: async (config) => {
				calls.confirm = config;
				return confirmAnswer;
			},
			maintenanceDeps: () => ({
				app: ctx.app,
				index: () => index,
				persistIndex: async () => {
					calls.persisted += 1;
				},
				t: ctx.t,
				confirmRemote: async (key) => {
					calls.cloudAsked.push(key);
					const answer = options.cloudHas ?? true;
					if (answer === "throw") throw new Error("HEAD failed");
					return typeof answer === "function" ? answer(key) : answer;
				},
			}),
		};

		return { ctx, calls };
	}

	function reset() {
		mockObsidian.Notice.instances.length = 0;
	}

	const key = "photo-aaaaaaaa.png";
	const path = "attachments/photo-aaaaaaaa.png";
	const entry = (overrides = {}) => ({ key, cachePath: path, size: Math.round(1.5 * MB), ...overrides });
	/** 一篇引用了 `theKey` 的笔记（URL 用**真实的** `publicUrlFor` 生成）。 */
	const noteLinking = (theKey = key) => ({
		path: "notes/a.md",
		text: `![](${mod.publicUrlFor(S3, theKey)})`,
	});

	// ============================================================
	// 1. ⭐⭐ 两条准入判据必须在**编排层**真的接上
	//
	// 判定层（`planReleaseSpace`）那四条判据由 `release-space-suite` 穷举；
	// 这里守的是另一半：编排层真的把**台账**与**引用扫描结果**传下去了吗。
	// 传错了不报错，只是"删了不该删的"。
	// ============================================================
	{
		reset();
		// 台账里没有它（从没上传成功过）⇒ 一个候选都不该有
		const { ctx, calls } = makeCtx({
			entries: [entry()],
			uploaded: [],
			notes: [noteLinking()],
		});
		await releaseLocalSpace(ctx, "notice");
		// ⚠️ 顺序：**先**断"一个都没删"。反过来的话，变异"不查台账"会先撞上
		//"不该走到确认框"这条次要断言，报错说不出真实危害（那是**丢数据**）。
		assert.equal(calls.deleted.length, 0, "★★ 台账里没有的对象不得删（它云端可能根本没有）");
		assert.equal(calls.confirm, null, "台账没命中 ⇒ 不该走到确认框");
		assertNotice(["Nothing to clean up"], "没有候选时要如实说");
	}
	{
		reset();
		// 笔记不引用它（孤儿）⇒ 不归这条命令管（那是 R17 三档询问的分内事）
		const { ctx, calls } = makeCtx({ entries: [entry()], notes: [] });
		await releaseLocalSpace(ctx, "notice");
		// ⚠️ 同上：先断"一个都没删"（承重的那条）
		assert.equal(calls.deleted.length, 0, "★ 孤儿（没有任何笔记引用）不归它管");
		assert.equal(calls.confirm, null, "孤儿 ⇒ 不该走到确认框");
	}

	// ============================================================
	// 2. 两个入口的差别：没有可清项时，手动入口出声、切档那次不打扰
	// ============================================================
	{
		reset();
		const { ctx } = makeCtx({ entries: [], notes: [] });
		await releaseLocalSpace(ctx, "silent");
		assertNoNotice("切档那次：没东西可清就别打扰他（他刚做的是改设置，不是清理）");
	}
	{
		reset();
		const { ctx } = makeCtx({ entries: [], notes: [] });
		await releaseLocalSpace(ctx, "notice");
		assertNotice(["Nothing to clean up"], "手动入口：他是特地来清东西的，必须说一声");
	}
	{
		reset();
		// 索引指着两条、磁盘上只剩一条 ⇒ 另一条算"已不在"，措辞与"没东西可清"**不同**
		// ⚠️ 要命中"磁盘上已不在"，它得先过上面前两条判据（台账命中 + 笔记还链着它）——
		// 判定的顺序就是这样：没过前两条的条目根本走不到磁盘那一步。
		const goneKey = "gone-bbbbbbbb.png";
		const { ctx } = makeCtx({
			entries: [entry({ key: goneKey, cachePath: "attachments/" + goneKey })],
			onDisk: [],
			notes: [noteLinking(goneKey)],
		});
		await releaseLocalSpace(ctx, "notice");
		assertNotice(["index record(s) point at files that are no longer there"], "失效记录要单独说（否则用户以为索引坏了）");
	}

	// ============================================================
	// 3. ⭐ 确认框：三句该说清的 + 破坏性标记 + 清单上限
	// ============================================================
	{
		reset();
		const { ctx, calls } = makeCtx({ entries: [entry()], notes: [noteLinking()], confirm: false });
		await releaseLocalSpace(ctx, "notice");
		const lines = calls.confirm.lines.join("\n");
		assert.equal(calls.confirm.destructive, true, "永久删除必须标成破坏性");
		assert.ok(lines.includes("1.5 MB"), `摘要要说清能腾多少，实际：${JSON.stringify(lines)}`);
		assert.ok(/deleted permanently/i.test(lines), "必须写明永久删除、不进回收站");
		assert.ok(/cannot be undone/i.test(lines), "必须写明不可撤销");
		assert.ok(/Nothing in your storage is deleted/i.test(lines), "必须写明云端不动（否则用户怕把图删死）");
		assert.ok(/notes are not changed/i.test(lines), "必须写明笔记不动");
		assert.equal(calls.cardInputs.length, 1, "候选要进卡片（用户按卡片核对）");
	}
	{
		reset();
		const many = Array.from({ length: 12 }, (_, index) => ({
			key: `p${index}-aaaaaaaa.png`,
			cachePath: `attachments/p${index}-aaaaaaaa.png`,
			size: 1000 + index,
		}));
		const { ctx, calls } = makeCtx({
			entries: many,
			notes: many.map((item, index) => ({ path: `notes/n${index}.md`, text: mod.publicUrlFor(S3, item.key) })),
			confirm: false,
		});
		await releaseLocalSpace(ctx, "notice");
		assert.equal(calls.cardLimit, 10, "清单上限是 10");
		assert.equal(calls.cardInputs.length, 12, "上限只影响**展示**，候选本身仍是 12 个");
		assert.ok(calls.confirm.lines.some((line) => line.includes("2")), "要有\"另有 2 个\"那一行");
	}

	// ============================================================
	// 4. 取消 ⇒ 一个文件都不删；确认 ⇒ 真的删（并且逐个复核过云端）
	// ============================================================
	{
		reset();
		const { ctx, calls } = makeCtx({ entries: [entry()], notes: [noteLinking()], confirm: false });
		await releaseLocalSpace(ctx, "notice");
		assert.equal(calls.deleted.length, 0, "⚠️ 取消 ⇒ 一个文件都不许删");
		assert.equal(calls.cloudAsked.length, 0, "取消 ⇒ 也不该去问云端");
		assertNotice(["Cancelled"], "取消要如实反馈");
	}
	{
		reset();
		const { ctx, calls } = makeCtx({ entries: [entry()], notes: [noteLinking()] });
		await releaseLocalSpace(ctx, "notice");
		assert.deepEqual(calls.deleted, [path], "确认之后删掉的就是候选那份");
		assert.deepEqual(calls.cloudAsked, [key], "⭐ 删之前**逐个复核**云端还有没有它（那可能是最后一份）");
		assert.equal(calls.persisted, 1, "摘了索引记录 ⇒ 必须落盘一次");
		assertNotice(["Deleted 1 local copy(ies)"], "如实汇报删了几个、腾了多少");
	}

	// ============================================================
	// 5. ⭐⭐ "一个都没删"必须解释 —— 否则用户以为功能坏了
	//
	// 真实原因只有一个：候选是纯判定（不联网），删除前要逐个 HEAD 复核
	// "云端现在确实还有它" ⇒ 确认不上的那些会被跳过。
	// ============================================================
	{
		reset();
		const { ctx, calls } = makeCtx({ entries: [entry()], notes: [noteLinking()], cloudHas: false });
		await releaseLocalSpace(ctx, "notice");
		assert.equal(calls.deleted.length, 0, "云端确认不上 ⇒ 不删（本机这份是最后一份）");
		assertNotice(["Deleted 0"], "总数要如实（0 就是 0）");
		assertNotice(["Nothing was deleted"], "★★ 一个都没删必须**再解释一句**，否则用户不知道发生了什么");
	}
	{
		reset();
		// 复核抛错（HEAD 失败）⇒ 同样跳过，且不中断整批
		const { ctx, calls } = makeCtx({ entries: [entry()], notes: [noteLinking()], cloudHas: "throw" });
		await releaseLocalSpace(ctx, "notice");
		assert.equal(calls.deleted.length, 0, "复核失败 ⇒ 跳过（绝不退化成\"不知道就删\"）");
		assertNotice(["Nothing was deleted"], "复核失败也要解释");
	}

	// ============================================================
	// 6. ⭐ 读不到笔记 ⇒ 整体放弃（与云端清理**成对**的那条兜底）
	// ============================================================
	{
		reset();
		const { ctx, calls } = makeCtx({
			entries: [entry()],
			notes: [{ path: "notes/broken.md", readError: "EIO" }],
		});
		await releaseLocalSpace(ctx, "notice");
		assert.equal(calls.confirm, null, "还没到确认那一步就该停下");
		assert.equal(calls.deleted.length, 0, "⚠️ 读不到引用时一个文件都不许删");
		assertNotice(["notes/broken.md", "was cancelled"], "必须明确告知并取消");
	}

	// ============================================================
	// 7. ⭐⭐ 上限档（「保留副本」+ 设了上限）：目标是"清到上限以内"，不是全清
	//
	// 用户 2026-10-15 报的原话："设置上限 500，清理副本，应该要留下 500，而不是全清。"
	// 判据层由 `release-space-suite` §9 穷举；这里守的是**编排层**：
	// 目标真的从设置里取到了吗、确认框与结果通知真的带上了目标吗。
	// ============================================================
	{
		reset();
		// 3 份 × 1 MB，上限 2 MB ⇒ 只需腾 1 MB（一份），剩下的要留下
		const files = [0, 1, 2].map((index) => ({
			key: `p${index}-aaaaaaaa.png`,
			cachePath: `attachments/p${index}-aaaaaaaa.png`,
			size: MB,
		}));
		const { ctx, calls } = makeCtx({
			entries: files,
			notes: files.map((item, index) => ({ path: `notes/n${index}.md`, text: mod.publicUrlFor(S3, item.key) })),
			localCopy: "keep",
			cacheLimitMb: 2,
		});
		await releaseLocalSpace(ctx, "notice");
		assert.deepEqual(
			calls.deleted,
			["attachments/p0-aaaaaaaa.png"],
			"★★ 只删到上限以内就停（3 份 3 MB、上限 2 MB ⇒ 只该删 1 份）—— 全清是用户 2026-10-15 报的那个缺陷"
		);
		const lines7 = calls.confirm.lines.join("\n");
		assert.ok(
			/2 MB/.test(lines7) && /1\.0 MB/.test(lines7),
			`★ 按下之前就要说清"清到你的 2 MB 上限、清完约剩 1.0 MB"，实际：${JSON.stringify(lines7)}`
		);
		assertNotice(
			["Deleted 1 local copy(ies)", "2 MB"],
			"★ 结果通知要带上目标（否则'为什么只剩这些'永远解释不清）"
		);
	}
	{
		reset();
		// ⭐⭐ 上限档**也不动**没人引用的副本（用户 2026-10-15 特意纠正）：
		// 没人引用的那份可能还要连云端对象一起删，那是 R17 三档询问的活。
		// ⚠️ 让孤儿**更旧**：真把池子放宽了，被删的必然是最旧的它 ⇒ 断言能抓出来。
		// ⚠️ 两份都要在宽限期之外（否则连"该删的那份"都不会动，这条用例就退化成"什么都没发生"）。
		const HOUR = 60 * 60 * 1000;
		const orphan = {
			key: "orphan-aaaaaaaa.png",
			cachePath: "attachments/orphan-aaaaaaaa.png",
			size: MB,
			lastUsedAt: Date.now() - 100 * HOUR,
		};
		const linked = {
			key: "linked-bbbbbbbb.png",
			cachePath: "attachments/linked-bbbbbbbb.png",
			// ⚠️ 它要**大于**上限，否则这批"已经在上限以内" ⇒ 一份都不该删，用例就退化成"什么都没发生"
			size: 2 * MB,
			lastUsedAt: Date.now() - 1 * HOUR,
		};
		const { ctx, calls } = makeCtx({
			entries: [orphan, linked],
			notes: [noteLinking(linked.key)], // 只有 linked 被引用
			localCopy: "keep",
			cacheLimitMb: 1,
		});
		await releaseLocalSpace(ctx, "notice");
		assert.deepEqual(
			calls.deleted,
			["attachments/linked-bbbbbbbb.png"],
			"★★ 上限档只动'笔记里仍引用着'的那批 —— 没人引用的那份要留给'连云端一起清'那条流程"
		);
		// ⚠️ 断言的是**接线**（这条提示把用户指到那条清理命令），不是某个具体名字 ——
		// 命令改名时两边一起走，不会因为文案调整而假红；而 `{command}` 一旦没传进来就会红。
		assertNotice(
			[translate("en", "cmdCheckOrphans")],
			"★★ 剩下那部分（没人引用的）必须指路：否则'我设了上限、也清了，怎么还占着'会变成一个说不清的谜"
		);
	}
	{
		reset();
		const { ctx, calls } = makeCtx({
			entries: [entry()],
			notes: [noteLinking()],
			localCopy: "keep",
			cacheLimitMb: 128,
		});
		await releaseLocalSpace(ctx, "notice");
		assert.equal(calls.confirm, null, "没超上限 ⇒ 连确认框都不该出现");
		assertNotice(["already within"], "★ 上限档的'没什么可清理'要说成'已经在上限以内'（那是好消息，不是故障）");
	}
	{
		reset();
		// ⚠️ 防御线：保留副本档 + **没设上限** ⇒ 没有目标。界面上那个按钮本来就不显示
		//（见 `shouldShowReleaseSpace`），走进来只可能是陈旧的设置页 —— 那时**什么都不做**，
		// 而绝不能把"没有目标"理解成"那就全清"。
		const { ctx, calls } = makeCtx({ entries: [entry()], notes: [noteLinking()], localCopy: "keep" });
		await releaseLocalSpace(ctx, "notice");
		assert.equal(calls.deleted.length, 0, "★★ 没有目标 ⇒ 一个文件都不许删（'没有目标'最不该被解释成'全清'）");
		assert.equal(calls.confirm, null, "没有目标 ⇒ 不该弹确认框");
		assertNoNotice("没有目标不是用户的动作，别打扰他");
	}

	// ============================================================
	// 7. ⭐⭐ 执行层的**每一条跳过**（`deleteVerifiedCopies`）
	//
	// 这条循环是"删用户附件目录里的文件"的唯一落点，而它有三道准入判据
	// （索引里还认这条记录 / 云端此刻确实还有它 / 宿主索引看得见这个文件）。
	// 流程层的用例只看到"删了几个"，看不出**是哪一道**拦下的 —— 而用户看到的
	// 提示恰恰是那句原因（"跳过，这份是仅剩的副本"与"确认不了"的修法不同）。
	// 所以这里直接调执行层，逐条把原因钉住。
	// ============================================================
	{
		const { deleteVerifiedCopies } = mod;
		assert.equal(typeof deleteVerifiedCopies, "function", "执行层必须可单测（`maintenance/run` 的导出）");

		/** 一次调用的最小依赖；`overrides` 覆盖某一项（undefined 也照传）。 */
		const runOnce = async (overrides) => {
			const removed = [];
			let persisted = 0;
			const result = { evicted: 0, freed: 0, skipped: [], unindexed: 0 };
			const deps = {
				app: {
					vault: {
						getAbstractFileByPath: (path) => ({ path }),
						delete: async () => {},
					},
				},
				settings: () => ({}),
				index: () => ({
					findByCachePath: () => ({ key: "a.png", cachePath: "attachments/a.png" }),
					remove: (key) => {
						removed.push(key);
						return true;
					},
				}),
				persistIndex: async () => {
					persisted += 1;
				},
				confirmRemote: async () => true,
				t: (key) => translate("en", key, {}),
				notify: () => {},
				...overrides,
			};
			await deleteVerifiedCopies(deps, [{ key: "a.png", cachePath: "attachments/a.png", bytes: 100 }], result);
			return { result, removed, persisted };
		};

		const reasonOf = (key) => translate("en", key, {});

		// ① 索引已经不认这条记录（路径还在，但账本里没有）
		{
			const { result } = await runOnce({ index: () => ({ findByCachePath: () => undefined, remove: () => true }) });
			assert.equal(result.evicted, 0, "索引里没有这条记录 ⇒ 不删");
			assert.equal(result.skipped.length, 1, "跳过要留一条记录（否则界面上看不到为什么没删）");
			assert.equal(result.skipped[0].reason, reasonOf("maintainSkipUnknownCopy"), "ⓘ 原因是「索引不再指向这份文件」");
		}
		// ② 同路径但 key 已经换了（路径被另一个对象复用）—— 同样不许删
		{
			const { result } = await runOnce({
				index: () => ({ findByCachePath: () => ({ key: "other.png", cachePath: "attachments/a.png" }), remove: () => true }),
			});
			assert.equal(result.evicted, 0, "★ key 对不上 ⇒ 不删（路径相同不等于同一条记录）");
			assert.equal(result.skipped[0].reason, reasonOf("maintainSkipUnknownCopy"), "与①同一句话：这条记录已经不认它了");
		}
		// ③ 连复核手段都没有（`confirmRemote` 未接线）⇒ 一律不删
		{
			const { result, removed } = await runOnce({ confirmRemote: undefined });
			assert.equal(result.evicted, 0, "★ 确认不了就不删 —— 安全的一侧");
			assert.equal(removed.length, 0, "也不许摘索引记录（文件还在）");
			assert.equal(result.skipped[0].reason, reasonOf("maintainSkipUnconfirmed"), "原因是「确认不了云端是否还有它」");
		}
		// ④ 云端已经没有这个对象 ⇒ 本机这份是最后一份
		{
			const { result } = await runOnce({ confirmRemote: async () => false });
			assert.equal(result.evicted, 0, "★ 云端没有 ⇒ 绝不删（那可能是仅剩的副本）");
			assert.equal(result.skipped[0].reason, reasonOf("maintainSkipNotInCloud"), "这句话必须说清「仅剩的副本」");
		}
		// ⑤ 宿主索引看不见这个文件（磁盘上可能存在）⇒ 跳过而不是退化成底层删除
		{
			const { result } = await runOnce({
				app: { vault: { getAbstractFileByPath: () => null, delete: async () => {} } },
			});
			assert.equal(result.evicted, 0, "宿主看不见 ⇒ 跳过（绝不退化成底层删除）");
			assert.equal(result.skipped[0].reason, reasonOf("maintainSkipNotIndexed"), "原因是「Obsidian 还看不到这个文件」");
		}
		// ⑥ 删除本身抛错 ⇒ 计数为 0、原因如实带出来，且不中断
		{
			const { result, persisted } = await runOnce({
				app: {
					vault: {
						getAbstractFileByPath: (path) => ({ path }),
						delete: async () => {
							throw new Error("EACCES");
						},
					},
				},
			});
			assert.equal(result.evicted, 0, "删除失败 ⇒ 不许计入已删");
			assert.ok(result.skipped[0].reason.includes("EACCES"), `原因要带出原始错误，实际：${result.skipped[0].reason}`);
			assert.equal(persisted, 0, "一个都没删掉 ⇒ 没有索引要落盘");
		}
		// ⑦ 全部通过 ⇒ 删、计数、摘记录、落盘
		{
			const { result, removed, persisted } = await runOnce({});
			assert.equal(result.evicted, 1, "复核全过 ⇒ 删掉");
			assert.equal(result.freed, 100, "释放的字节取自索引记录（不是重新 stat）");
			assert.deepEqual(removed, ["a.png"], "摘掉对应索引记录");
			assert.equal(result.unindexed, 1, "摘掉的条数要计数");
			assert.equal(persisted, 1, "摘了记录 ⇒ 必须落盘一次");
		}
	}

	return { cases: 22 };
}
