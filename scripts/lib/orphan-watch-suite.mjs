/**
 * 孤儿监视（`src/maintenance/orphan-watch.ts`）的断言套件。
 *
 * 这一层回答"**什么时候该问用户要不要连云端一起清**"。两个方向判错的代价都不小：
 * - 漏问 ⇒ 孤儿永远没人回收（用户只能自己跑命令）；
 * - 误报 ⇒ 弹出一个"要不要删云端"的框 —— 而那东西可能还在被用；
 *   更糟的是用户顺手点了删除（**不可恢复**）。
 *
 * ⇒ 所以"什么时候**不**问"与"什么时候问"同等重要，两个方向都要有钉子。
 *
 * 断言用**假事件序列**驱动（`noteChanged` / `noteRemoved` / `noteRenamed`），
 * 不需要时钟 —— 这一层刻意**不含定时器**（防抖与攒批在接线层，见模块头注释）。
 *
 * 第 9 节守的是另一半：用户答"连本地一起删"之后的**处置清单怎么算**。
 * 那里分类错了的后果是"绕过回收站永久删掉用户自己的附件"，
 * 所以它按类别归属来钉（`isUserFile` 落在哪一侧）。
 */

import assert from "node:assert/strict";

export async function runOrphanWatchSuite(mod) {
	const { createOrphanWatcher, dropLocallyReferenced, planOrphanLocalRemoval, selectOrphanAsks } = mod;

	/**
	 * 造一个可注入的监视器。
	 *
	 * `extractKeys` 把正文当成"逗号分隔的 key 列表" —— 真实的提取（`keysInText`）
	 * 在别处已被独立覆盖，这里只关心**状态机**的时序。
	 */
	const make = (notes = []) => {
		const texts = new Map(notes.map((note) => [note.path, note.text]));
		const errors = [];
		const watcher = createOrphanWatcher({
			listNotes: () => notes.map((note) => ({ path: note.path, kind: note.kind ?? "md" })),
			readText: async (path) => {
				if (!texts.has(path)) throw new Error(`没有这个文件：${path}`);
				return texts.get(path);
			},
			extractKeys: (_kind, text) =>
				new Set(
					String(text)
						.split(",")
						.map((value) => value.trim())
						.filter(Boolean)
				),
			onError: (error) => errors.push(error),
		});
		return { watcher, texts, errors };
	};

	// ============================================================
	// 1. ⭐⭐ 冷启动**只登记、不判定**（否则加载一次就会把所有已上传对象全弹一遍）
	// ============================================================
	{
		const { watcher } = make([
			{ path: "a.md", text: "k1,k2" },
			{ path: "b.md", text: "k1" },
		]);
		assert.equal(await watcher.warmUp(), true, "第一次建立应该返回 true");
		assert.equal(watcher.watchedCount(), 2, "两篇都要进快照");
		assert.equal(watcher.referencedCount(), 2, "k1、k2 各算一份引用（k1 有两篇引用也只是一条）");

		// ⭐ 反向钉子：再报一次**一模一样**的内容 ⇒ 什么都没变 ⇒ 没有孤儿
		assert.deepEqual(watcher.noteChanged("a.md", "md", "k1,k2"), [], "内容没变不该产出孤儿");
		assert.deepEqual(watcher.noteChanged("b.md", "md", "k1"), [], "同上");

		// 幂等：再 warmUp 一次不该把计数加重复
		assert.equal(await watcher.warmUp(), false, "第二次 warmUp 应该返回 false（已经建过）");
		assert.equal(watcher.referencedCount(), 2, "重复建立不能把引用数翻倍");
	}

	// ============================================================
	// 2. 删掉一条引用 ⇒ 那个 key 成为孤儿
	// ============================================================
	{
		const { watcher } = make([{ path: "a.md", text: "k1,k2" }]);
		await watcher.warmUp();
		assert.deepEqual(watcher.noteChanged("a.md", "md", "k1"), ["k2"], "★ 引用消失了 ⇒ 报孤儿");
		assert.equal(watcher.referencedCount(), 1, "还剩一个被引用");
		assert.deepEqual(watcher.noteChanged("a.md", "md", ""), ["k1"], "★ 清空正文 ⇒ 最后一个也成为孤儿");
		assert.equal(watcher.referencedCount(), 0, "没有引用了");
	}

	// ============================================================
	// 3. ⭐ 别的笔记还引用着 ⇒ **不是**孤儿（这条是"误报"方向的主钉子）
	// ============================================================
	{
		const { watcher } = make([
			{ path: "a.md", text: "shared.png" },
			{ path: "b.md", text: "shared.png" },
		]);
		await watcher.warmUp();
		assert.deepEqual(
			watcher.noteChanged("a.md", "md", ""),
			[],
			"★ a 删掉了引用，但 b 还在用 ⇒ 绝不能报成孤儿（否则会删掉仍在用的对象）"
		);
		assert.equal(watcher.referencedCount(), 1, "还剩 b 那一份引用");
		// 现在 b 也删掉 ⇒ 才成为孤儿
		assert.deepEqual(watcher.noteChanged("b.md", "md", ""), ["shared.png"], "两份都删掉才是孤儿");
	}

	// ============================================================
	// 4. 删掉整篇笔记 ⇒ 它引用过的对象失去引用
	// ============================================================
	{
		const { watcher } = make([
			{ path: "a.md", text: "k1" },
			{ path: "b.md", text: "k2" },
		]);
		await watcher.warmUp();
		assert.deepEqual(watcher.noteRemoved("a.md"), ["k1"], "★ 删笔记也会让它的图成为孤儿");
		assert.equal(watcher.watchedCount(), 1, "快照里少了一篇");
		assert.deepEqual(watcher.noteRemoved("a.md"), [], "同一篇再报一次不该重复产出");
		assert.deepEqual(watcher.noteRemoved("never-seen.md"), [], "⚠️ 快照里没有的路径不产出（防误报）");
	}

	// ============================================================
	// 5. 重命名：快照跟着搬，**引用计数不变**（改名不是"引用消失"）
	// ============================================================
	{
		const { watcher } = make([{ path: "a.md", text: "k1" }]);
		await watcher.warmUp();
		watcher.noteRenamed("a.md", "c.md");
		assert.equal(watcher.watchedCount(), 1, "还是一篇（只是换了名字）");
		assert.equal(watcher.referencedCount(), 1, "引用数不变");
		assert.deepEqual(watcher.noteChanged("c.md", "md", "k1"), [], "★ 改名后内容没变 ⇒ 不该报孤儿");
		assert.deepEqual(watcher.noteChanged("c.md", "md", ""), ["k1"], "改名之后删引用照常能报");
	}

	// ============================================================
	// 6. 引用加回来又删掉 ⇒ **再次**成为孤儿（冷却不在这里，由接线层负责）
	// ============================================================
	{
		const { watcher } = make([{ path: "a.md", text: "k1" }]);
		await watcher.warmUp();
		assert.deepEqual(watcher.noteChanged("a.md", "md", ""), ["k1"], "第一次消失");
		assert.deepEqual(watcher.noteChanged("a.md", "md", "k1"), [], "加回来不是孤儿（变多了）");
		assert.deepEqual(
			watcher.noteChanged("a.md", "md", ""),
			["k1"],
			"再删掉又会报一次 —— 去重/冷却由接线层做，这一层如实报告"
		);
	}

	// ============================================================
	// 7. 读不到的文件 ⇒ 记错误、**不当成"它没有引用了"**
	// ============================================================
	{
		const errors = [];
		const watcher = createOrphanWatcher({
			listNotes: () => [
				{ path: "ok.md", kind: "md" },
				{ path: "gone.md", kind: "md" },
			],
			readText: async (path) => {
				if (path === "gone.md") throw new Error("读不到");
				return "k1";
			},
			extractKeys: (_kind, text) =>
				new Set(
					String(text)
						.split(",")
						.map((value) => value.trim())
						.filter(Boolean)
				),
			onError: (error) => errors.push(error),
		});
		await watcher.warmUp();
		assert.equal(errors.length, 1, "读不到要记下来（它意味着这一篇这一趟没算进来）");
		assert.equal(watcher.watchedCount(), 1, "只有读到的那一篇进了快照");
		assert.equal(watcher.referencedCount(), 1, "读到的那篇的引用照常算");
	}

	// ============================================================
	// 8. ⭐ 筛选：只问"我们经手过的"，且问过就不再问
	//
	// ⚠️ 判据是 `isOurs`（**上传台账**），不是"索引里有没有条目"。
	// 这一条是 2026-10-11 新查出的 N11 的钉子：「不留副本」那一档**没有条目**
	// （上传后本地文件被移走 ⇒ 按纪律不写条目），若判据接的是条目，
	// 该档**所有**对象都会被判 `not-ours` ⇒ 这个询问在那个档位一次都不出现。
	// ============================================================
	{
		const context = {
			isOurs: (key) => key !== "theirs.png",
			hasAsked: (key) => key === "asked.png",
			isExternal: () => false,
		};
		const selection = selectOrphanAsks(
			["ours.png", "theirs.png", "asked.png", "ours.png"],
			context
		);
		assert.deepEqual(selection.asks, ["ours.png"], "★ 只留下我们经手过、且没问过的（重复的只算一次）");
		assert.deepEqual(
			selection.skipped,
			[
				{ key: "theirs.png", reason: "not-ours" },
				{ key: "asked.png", reason: "already-asked" },
			],
			"两种跳过要分开记（排查时看得出是哪种）"
		);

		// ⚠️ 反向：全都不是我们的 ⇒ **一个都不问**（对别人的对象我们没有处置权）
		assert.deepEqual(
			selectOrphanAsks(["theirs.png"], {
				isOurs: () => false,
				hasAsked: () => false,
				isExternal: () => false,
			}).asks,
			[],
			"★ 不是我们经手过的对象，绝不拿去问（更没有删的道理）"
		);

		// ⭐ 反向（N11 的主钉子）：**有台账、但没有索引条目** ⇒ 必须照问。
		// 这一格就是「不留副本」档的形态：对象是我们上传的（台账有），
		// 而本地没有副本（索引里没有条目）。判据写成"查条目"就会在这一格静默失效。
		{
			const ledgerOnly = {
				isOurs: (key) => key === "no-local-copy.png",
				hasAsked: () => false,
				isExternal: () => false,
			};
			assert.deepEqual(
				selectOrphanAsks(["no-local-copy.png"], ledgerOnly).asks,
				["no-local-copy.png"],
				"★ 台账里有它、索引里没有它（不留副本档）⇒ 仍然要问，不能静默跳过"
			);
		}

		// ⭐⭐ 2026-10-22 审计：**本地副本还被正文直接指着的**不许当孤儿
		// （同一个对象，占用报告说"在用"、这条命令却列成孤儿 ⇒ 用户可能删掉正文还在显示的图）。
		//
		// 现场三种形态都可达：改写失败（D-56）、用户把链接改回本地（D-50 的退出路径）、
		// 先传文件后补本地链接。它们共同的形态是"正文里只有本地路径、没有 URL"。
		{
			const paths = new Set(["attachments/still-used.png", "assets/图 1.png"]);
			const dropped = dropLocallyReferenced(["used.png", "Idle.png", "no-copy.png"], {
				cachePathOf: (key) => ({ "used.png": "attachments/still-used.png", "Idle.png": "attachments/idle.png" })[key],
				referencedPaths: paths,
			});
			assert.deepEqual(
				dropped.kept,
				["Idle.png", "no-copy.png"],
				"★★ 正文还直接指着那份本地副本时，这个对象**不是孤儿**（不许列出来让用户删）"
			);
			assert.deepEqual(
				dropped.skipped,
				["used.png"],
				"摘掉的那几个要能单独数出来（诊断/排查用）"
			);
			// ⚠️ 反向：没有索引条目（「不留副本」档）⇒ 映射不出路径 ⇒ 照旧当孤儿。
			// 那种档位下本地根本没有副本，正文里指着它的本地路径只可能是死链。
			assert.equal(
				dropLocallyReferenced(["no-copy.png"], {
					cachePathOf: () => undefined,
					referencedPaths: new Set(["attachments/whatever.png"]),
				}).kept.length,
				1,
				"★ 没有条目时映射不出路径 ⇒ 保持原行为（不替用户猜）"
			);
		}

		// 反向：空输入 ⇒ 空结果（不该崩，也不该产出）
		assert.deepEqual(selectOrphanAsks([], context).asks, [], "空候选不产出");
		assert.deepEqual(selectOrphanAsks(["", "  "], context).asks, [], "空串/空白要被跳过");

		// ⭐⭐ **站外缓存的对象一律不列**（2026-10-16 从退役的「清理云端未使用对象…」继承来）。
		//
		// 为什么：站外缓存的链接**改写失败**时，笔记里留着的是**原来的站外地址**（别人的域名）
		// —— 而"谁在引用"的判据是**按 URL 回算对象 key**，它根本认不出那种地址，于是这个对象
		// 会被误判成"没人引用"。那条老命令为此把站外缓存**整体排除**（宁可多留）；
		// 它退役之后，这条排除必须跟着搬过来 —— 否则会**悄悄丢掉**（而两侧都不报错）。
		{
			const withExternal = {
				isOurs: () => true,
				hasAsked: () => false,
				isExternal: (key) => key === "from-site.png",
			};
			const sel = selectOrphanAsks(["mine.png", "from-site.png"], withExternal);
			assert.deepEqual(
				sel.asks,
				["mine.png"],
				"★★ 站外缓存的对象不列（它的引用可能长成认不出的站外地址）"
			);
			assert.deepEqual(
				sel.skipped,
				[{ key: "from-site.png", reason: "external" }],
				"★ 跳过原因要分开记「站外缓存」（诊断时看得出是哪种）"
			);
		}
	}

	// ============================================================
	// 9. ⭐ 本地副本的处置清单（1.2.0 / D-17：删法**只有一种**）
	//
	// 用户答「连本地一起删」之后，删的是**索引里登记的副本** —— 而它同时可能就是
	// 用户附件目录里的原件。所以这条路一律走**回收站**：判据不是「文件在哪」，
	// 而是「能不能重新拿到」，而这条路是用户**明确确认**过的、也不需要立刻腾空间。
	//（要立刻腾空间的是上限淘汰那条自动路径，它另有一套云端 HEAD 前置复核 ——
	// 见 `maintenance/remove.ts` 的论证。）
	//
	// ⚠️ 从前这里按「在不在缓存目录里」分两个桶，那个分类随缓存目录一起删掉了。
	// 保留下来的断言只问一件事：**清单本身对不对**（哪些 key/path 该产出、哪些不该）。
	// ============================================================
	{
		const withPaths = (map) => ({ cachePathOf: (key) => map[key] });

		assert.deepEqual(
			planOrphanLocalRemoval(["a.png"], withPaths({ "a.png": "attachments/a.png" })),
			[{ key: "a.png", path: "attachments/a.png" }],
			"索引里记着的副本 ⇒ 产出待删目标（删法由执行层固定为回收站）"
		);

		// 没有索引记录 ⇒ 本地无可处置（不是我们上传的，或「不留副本」档没留副本）
		assert.deepEqual(
			planOrphanLocalRemoval(["a.png"], withPaths({})),
			[],
			"★ 索引里没有记录 ⇒ 一个文件都不给删（对不属于我们的东西没有处置权）"
		);
		assert.deepEqual(
			planOrphanLocalRemoval(["a.png"], withPaths({ "a.png": "" })),
			[],
			"记录里路径是空串 ⇒ 不产出（没有可以删的路径）"
		);
		assert.deepEqual(
			planOrphanLocalRemoval(["a.png"], withPaths({ "a.png": "   " })),
			[],
			"★ 纯空白的路径也要挡掉 —— 交给宿主去解析一个只有空格的路径是在赌它怎么处理"
		);
		assert.deepEqual(
			planOrphanLocalRemoval(["  ", "a.png"], withPaths({ "a.png": "attachments/a.png" })),
			[{ key: "a.png", path: "attachments/a.png" }],
			"空/空白的 key 要跳过（不是合法的对象 key）"
		);

		// 同一个路径只删一次；顺序保持输入顺序（提示语里的数量要对得上）
		assert.deepEqual(
			planOrphanLocalRemoval(
				["b.png", "a.png", "c.png"],
				withPaths({
					"b.png": "attachments/same.png",
					"a.png": "attachments/same.png",
					"c.png": "attachments/other.png",
				})
			).map((target) => target.path),
			["attachments/same.png", "attachments/other.png"],
			"同一路径只产出一次（清单来自外部，不假设它干净）"
		);
	}

	return { cases: 9 };
}
