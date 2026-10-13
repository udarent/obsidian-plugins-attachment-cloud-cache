/**
 * **入口 B**（「清理云端未使用对象」，`src/plugin/cloud-cleanup-flow.ts`）的断言套件 —— 需求 R17 / F15。
 *
 * ## 为什么这条套件到现在才存在
 *
 * 这段流程此前是 `main.ts` 里的一个私有方法，而 `main.ts` 是插件类（依赖宿主），
 * 套件加载不了 —— 于是整条编排（列桶 → 算引用 → 弹确认 → 删 → 留痕）**零覆盖**，
 * 只有真机探针顺带走过一次。2026-10-13 的 A1 重构把它搬到 `plugin/` 之后
 * 它才成为一个可以喂假 `PluginContext` 的普通函数 —— 这条套件是那次重构的直接收益。
 *
 * ## 守的是什么
 *
 * 这条流程会**不可恢复地删云端对象**，所以断言的重心是"什么时候**什么都不该删**"：
 *
 * - 有笔记/画布**读不到** ⇒ 整体放弃（⚠️ 这是它与 `releaseLocalSpace` **共用**的那条判据：
 *   另一条路径有兜底、这条没有，曾经就静默变成一句 unhandled rejection）；
 * - 没配齐 / 列桶失败 ⇒ 明确报错，不是"安静地什么都不做"；
 * - 用户取消 ⇒ 一个对象都不删、日志也不写；
 * - 列举没读全（truncated）⇒ 提示里必须**如实说清单可能不全**。
 *
 * 另一头守的是"删了之后要记得"：确认后每个对象都删、并且**每个都留痕**
 * （`scope: "command"`）—— 删云端不留痕是本产品风险最集中的一处。
 *
 * ⚠️ 替身纪律：`ctx` 全是手工造的假件，但**URL 与 key 的换算用的是真实函数**
 * （`publicUrlFor` / `keyFromUrl` 都是被测代码那一份）—— 自己拼一个 URL 字符串，
 * 测的就是"我拼对了没有"，而不是"插件认不认自己的链接"。
 *
 * 断言在这里（与变异验证共用），入口在 `scripts/test-cloud-cleanup-flow.mjs`。
 */

import assert from "node:assert/strict";
import * as mockObsidian from "./mock-obsidian.mjs";

/** 一份"够用"的 S3 配置（path-style，于是 URL 形如 `<端点>/<桶>/<key>`）。 */
const S3 = { endpoint: "https://s3.example.com", bucket: "notes", forcePathStyle: true };

/** 把 `Notice.instances` 读成一组文案。 */
function noticeTexts() {
	return mockObsidian.Notice.instances.map((notice) => notice.message);
}

/** 一句话断言："应当只弹了一条提示，且它包含这些片段"。 */
function assertSingleNotice(fragments, why) {
	const texts = noticeTexts();
	assert.equal(texts.length, 1, `${why}：应恰好弹一条提示，实际 ${texts.length} 条 → ${JSON.stringify(texts)}`);
	for (const fragment of fragments) {
		assert.ok(texts[0].includes(fragment), `${why}：提示里应包含 ${JSON.stringify(fragment)}，实际 ${JSON.stringify(texts[0])}`);
	}
}

export async function runCloudCleanupFlowSuite(mod) {
	const { cleanupCloudObjects, translate, publicUrlFor } = mod;

	/**
	 * 造一个假 `PluginContext`。
	 *
	 * @param {object} options
	 *   `objects` 桶里的对象；`notes` 笔记（`{ path, text }` 或 `{ path, readError }`）；
	 *   `canvases` 画布（同上）；`entries` 索引里的记录；
	 *   `confirm` 确认框的答案；`configured` 有没有配齐。
	 */
	function makeCtx(options = {}) {
		const objects = options.objects ?? [];
		const notes = options.notes ?? [];
		const canvases = options.canvases ?? [];
		const entries = new Map((options.entries ?? []).map((entry) => [entry.key, entry]));

		const calls = {
			/** `deleteObject` 收到过的 key（顺序即执行顺序）。 */
			deleted: [],
			/** 最后一次给确认框的选项。 */
			confirm: null,
			/** 最后一次给 `fileCards` 的候选与上限。 */
			cardInputs: null,
			cardLimit: null,
			/** 索引落盘次数。 */
			persisted: 0,
			/** 删除日志被追加的文本（空串 = 没写）。 */
			logText: "",
			/** 删除日志被 `exists` 问过几次（用于验证"先看一眼再写"那条约定）。 */
			logExistsAsked: 0,
		};

		const noteFiles = notes.map((note) => ({ path: note.path, extension: "md" }));
		const canvasFiles = canvases.map((canvas) => ({ path: canvas.path, extension: "canvas" }));
		const byPath = new Map([...notes, ...canvases].map((file) => [file.path, file]));

		const index = {
			get: (key) => entries.get(key),
			toArray: () => [...entries.values()],
			remove: (key) => entries.delete(key),
			forgetUploaded: () => false,
		};

		// ⚠️ truncated 的造法：**后续每一页都空、但 token 一直给**，于是
		// `listAllObjects` 会真的跑满页数上限并如实标记 truncated —— 第一页的对象
		// 只出现一次，断言里的"几个对象/多少 MB"才是可预期的。
		let page = 0;
		const client = {
			listObjects: async () => {
				const first = page === 0;
				page += 1;
				return {
					objects: first ? [...objects] : [],
					nextToken: options.truncated ? "more" : null,
				};
			},
			deleteObject: async (key) => {
				calls.deleted.push(key);
				return true;
			},
		};

		const ctx = {
			app: {
				vault: {
					getMarkdownFiles: () => noteFiles,
					getFiles: () => [...noteFiles, ...canvasFiles],
					read: async (file) => {
						const found = byPath.get(file.path);
						if (found && found.readError) throw new Error(found.readError);
						return found ? found.text : "";
					},
					adapter: {
						exists: async () => {
							calls.logExistsAsked += 1;
							return false;
						},
						append: async (_path, text) => {
							calls.logText += text;
						},
						write: async (_path, text) => {
							calls.logText += text;
						},
					},
				},
			},
			manifest: { dir: ".obsidian/plugins/attachment-cloud-cache" },
			settings: { s3: { ...S3 } },
			t: (key, params) => translate("en", key, params ?? {}),
			currentIndex: () => index,
			hostContext: () => ({
				persistIndex: async () => {
					calls.persisted += 1;
				},
			}),
			buildClient: () => (options.configured === false ? null : client),
			fileCards: (items, limit) => {
				calls.cardInputs = items;
				calls.cardLimit = limit;
				return items.slice(0, limit).map((item) => ({ ...item, thumb: null }));
			},
			confirmMaintenance: async (config) => {
				calls.confirm = config;
				return options.confirm ?? true;
			},
		};

		return { ctx, calls };
	}

	/** 每个用例前清账（`Notice.instances` 是模块级共享的）。 */
	function reset() {
		mockObsidian.Notice.instances.length = 0;
	}

	// ============================================================
	// 1. ⭐ 读不到笔记 / 画布 ⇒ 整体放弃（一次都不删）
	//
	// 这条判据与 `main.ts::releaseLocalSpace` **成对存在**：两条路径共用
	// `cloudReferencedKeys`，而它抛错的唯一原因就是"有东西读不到"。
	// 2026-10-13 之前这条路径**没有兜底** ⇒ 抛出的错误变成一句
	// unhandled rejection，用户什么都看不到，而文案里写着"因此取消了这次清理"。
	// ============================================================
	{
		reset();
		const { ctx, calls } = makeCtx({
			objects: [{ key: "orphan.png", size: 10 }],
			notes: [{ path: "notes/broken.md", readError: "EIO" }],
		});
		await cleanupCloudObjects(ctx);
		assertSingleNotice(["notes/broken.md", "cancelled"], "笔记读不到 ⇒ 必须明确告知并取消");
		assert.equal(calls.deleted.length, 0, "⚠️ 读不到引用时**一个对象都不许删**（漏掉的那篇可能正引用着它们）");
		assert.equal(calls.logText, "", "什么都没删 ⇒ 不写删除日志（不产生空文件）");
		assert.equal(calls.confirm, null, "还没到确认那一步就该停下");
	}
	{
		reset();
		const { ctx, calls } = makeCtx({
			objects: [{ key: "orphan.png", size: 10 }],
			canvases: [{ path: "boards/talk.canvas", readError: "EIO" }],
		});
		await cleanupCloudObjects(ctx);
		assertSingleNotice(["talk.canvas", "cancelled"], "画布读不到同样要取消（画布里的链接也是引用）");
		assert.equal(calls.deleted.length, 0, "画布读不到时同样一个都不许删");
	}

	// ============================================================
	// 2. 没配齐 / 列桶失败 ⇒ 明确报错（不是"安静地什么都不做"）
	// ============================================================
	{
		reset();
		const { ctx, calls } = makeCtx({ configured: false });
		await cleanupCloudObjects(ctx);
		assertSingleNotice(["not set up yet"], "没配齐时必须说清是配置问题");
		assert.equal(calls.cardInputs, null, "没配齐时不该走到装配卡片那一步");
	}
	{
		reset();
		const { ctx, calls } = makeCtx({ objects: [{ key: "a.png", size: 1 }] });
		ctx.buildClient = () => ({ listObjects: async () => { throw new Error("AccessDenied"); } });
		await cleanupCloudObjects(ctx);
		assertSingleNotice(["AccessDenied"], "列桶失败要把原因说出来（只说\"失败\"没法排查）");
		assert.equal(calls.deleted.length, 0, "列桶失败 ⇒ 没有候选可删");
	}

	// ============================================================
	// 3. ⭐ "仍被引用"的对象绝不进候选（这条流程唯一真正的危险方向）
	//
	// 端到端地走一遍：笔记与画布里的链接都由**真实的** `publicUrlFor` 生成，
	// 于是这条断言同时钉住"引用扫描这条路是通的"。
	// ============================================================
	{
		reset();
		const { ctx, calls } = makeCtx({
			objects: [
				{ key: "used.png", size: 10 },
				{ key: "on-canvas.pdf", size: 20 },
				{ key: "external.jpg", size: 30 },
				{ key: "orphan.png", size: 40 },
			],
			notes: [{ path: "notes/a.md", text: `![]( ${publicUrlFor(S3, "used.png")} )` }],
			canvases: [
				{
					path: "boards/b.canvas",
					text: JSON.stringify({ nodes: [{ type: "text", text: `![](${publicUrlFor(S3, "on-canvas.pdf")})` }] }),
				},
			],
			// 站外缓存的对象同样要排除：它的引用可能写在别处（`CacheEntry.origin`）
			entries: [{ key: "external.jpg", cachePath: "attachments/external.jpg", origin: "external" }],
		});
		await cleanupCloudObjects(ctx);
		assert.deepEqual(
			calls.cardInputs.map((card) => card.id),
			["orphan.png"],
			"只剩一个候选：被笔记引用的、被画布引用的、站外缓存的都不许进清单"
		);
		assert.deepEqual(calls.deleted, ["orphan.png"], "确认之后删掉的就是候选那一批");
	}

	// ============================================================
	// 4. 清单为空（两种）—— truncated 时不能假装"没事"
	// ============================================================
	{
		reset();
		const { ctx, calls } = makeCtx({ objects: [] });
		await cleanupCloudObjects(ctx);
		assertSingleNotice(["Nothing to clean up"], "桶里没有可清理的 ⇒ 如实说");
		assert.equal(calls.logText, "", "没删任何东西 ⇒ 不留痕");
	}
	{
		reset();
		const { ctx } = makeCtx({ objects: [{ key: "used.png", size: 1 }], notes: [{ path: "notes/a.md", text: publicUrlFor(S3, "used.png") }], truncated: true });
		await cleanupCloudObjects(ctx);
		assertSingleNotice(["stopped early"], "列举没读全时**必须**点出来（不能让用户以为剩下那些都有人用）");
	}

	// ============================================================
	// 5. ⭐ 确认框：三条该说清的（盲区 / 不可恢复 / 清单不全）+ 取消 ⇒ 什么都不做
	// ============================================================
	{
		reset();
		const { ctx, calls } = makeCtx({
			objects: [{ key: "orphan.png", size: 5 * 1024 * 1024 }],
			truncated: true,
		});
		await cleanupCloudObjects(ctx);
		const lines = calls.confirm.lines.join("\n");
		assert.equal(calls.confirm.destructive, true, "删云端必须标成破坏性");
		assert.ok(lines.includes("5 MB"), `摘要要说清总体积，实际：${JSON.stringify(lines)}`);
		assert.ok(/device/i.test(lines), "必须写明「多设备看不到别人的引用」这条盲区");
		assert.ok(/cannot be undone|permanently/i.test(lines), "必须写明不可恢复");
		assert.ok(/local copies are kept/i.test(lines), "必须写明本地副本会留着（否则用户会以为笔记里的图也被删了）");
		assert.ok(/incomplete/i.test(lines), "列举没读全时，确认框里也要再写一次");
	}
	{
		reset();
		const { ctx, calls } = makeCtx({ objects: [{ key: "orphan.png", size: 1 }], confirm: false });
		await cleanupCloudObjects(ctx);
		// ⚠️ 顺序有讲究：**先**断"一个都没删"。
		// 反过来的话，变异"取消之后照样删"会先撞上"提示条数不对"那条次要断言，
		// 于是报错说"取消要如实反馈"——真实的原因是**不可恢复的删除照做了**。
		assert.equal(calls.deleted.length, 0, "⚠️ 取消 ⇒ 一个对象都不许删");
		assert.equal(calls.logText, "", "取消 ⇒ 不写删除日志");
		assert.equal(calls.persisted, 0, "取消 ⇒ 不动索引");
		assertSingleNotice(["Cancelled"], "取消要如实反馈");
	}

	// ============================================================
	// 6. ⭐ 删了就要记得：留痕（scope=command）+ 索引落盘
	// ============================================================
	{
		reset();
		const { ctx, calls } = makeCtx({
			objects: [
				{ key: "a.png", size: 1 },
				{ key: "b.png", size: 2 },
			],
			entries: [
				{ key: "a.png", cachePath: "attachments/a.png", sourceName: "photo.png" },
				{ key: "b.png", cachePath: "attachments/b.png" },
			],
		});
		await cleanupCloudObjects(ctx);
		assert.deepEqual(calls.deleted, ["a.png", "b.png"], "整批都删（一次失败不该中断，这里没有失败）");
		const logLines = calls.logText.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
		assert.equal(logLines.length, 2, `每个被删的对象都要留一行痕，实际：${JSON.stringify(calls.logText)}`);
		assert.ok(
			logLines.every((line) => line.scope === "command"),
			"入口必须记成 command（孤儿询问那条入口记的是 orphan）"
		);
		assert.equal(logLines[0].name, "photo.png", "留痕带的是索引里的原始文件名");
		assert.equal(calls.persisted, 1, "摘了索引记录 ⇒ 必须落盘一次");
		assert.ok(calls.logExistsAsked > 0, "写日志前先 exists 看一眼（不依赖宿主的 append 自动建文件）");
	}

	// ============================================================
	// 7. 候选过多 ⇒ 只列上限那么多张卡，另用一行报"还有几个"
	// ============================================================
	{
		reset();
		const objects = Array.from({ length: 14 }, (_, index) => ({ key: `o${index}.png`, size: 1 }));
		const { ctx, calls } = makeCtx({ objects, confirm: false });
		await cleanupCloudObjects(ctx);
		assert.equal(calls.cardLimit, 10, "清单上限是 10");
		assert.equal(calls.cardInputs.length, 14, "上限只影响**展示**，不影响候选本身（全部 14 个都要被删）");
		assert.ok(calls.confirm.lines.some((line) => line.includes("4")), "要有\"另有 4 个\"那一行");
	}

	return { cases: 13 };
}
