/**
 * **清单勾选**纯逻辑（`src/ui/selection-logic.ts`）的断言套件。
 *
 * ## 这里只断言**勾选**，不断言弹窗
 *
 * 弹窗那一层在 Node 里点不了（宿主的 `Modal` 没有可编程 DOM），它靠真机探针验证。
 * 而"勾选怎么算"能穷举，也正是最容易错又不报错的地方 —— 所以全部放这里。
 *
 * 最要命的一条：**同一个地址出现在两篇笔记里必须是两个键**。
 * 合成一条的后果是其中一篇的链接没被改写（文件进了存储、笔记还指着别人的服务器），
 * 而用户以为自己勾过了。
 *
 * ⚠️ 2026-10-22（D-68）：原来的 `buildPickItems`（候选 → 清单行）随「挑选外链」那条链
 * 一起删掉了 —— 现在清单行由 `plugin/upload-existing-flow.ts` 直接构造。
 * 这个套件只守剩下的三件事：**键怎么算 / 切换 / 全选**。
 */

import assert from "node:assert/strict";

export function runSelectionSuite(mod) {
	const { pickKey, toggleSelection, selectEverything } = mod;

	// ============================================================
	// 1. ⭐ 勾选的单位 = 笔记 + 地址
	// ============================================================
	{
		const a = pickKey({ url: "https://a.example.net/x.png", notePath: "notes/one.md" });
		const b = pickKey({ url: "https://a.example.net/x.png", notePath: "notes/two.md" });
		assert.notEqual(a, b, "★ 同一个地址在两篇笔记里必须是两个键（否则其中一篇不会被处理）");
		assert.equal(a, pickKey({ url: "https://a.example.net/x.png", notePath: "notes/one.md" }), "同样的输入给同样的键");

		// 首尾空白不改变身份（候选那边也可能带着空白）
		assert.equal(
			pickKey({ url: "  https://a.example.net/x.png  ", notePath: " notes/one.md " }),
			a,
			"首尾空白要忽略"
		);

		// 药丸输入不抛错
		for (const bad of [null, undefined, {}, { url: 42 }, { url: "x" }]) {
			assert.equal(typeof pickKey(bad), "string", `奇怪输入要返回字符串：${JSON.stringify(bad)}`);
		}
		assert.notEqual(pickKey({ url: "x" }), pickKey({ notePath: "x" }), "只有地址、或只有路径的键不能撞成同一个");
	}

	// ============================================================
	// 2. toggleSelection：不可变、非字符串键不生效
	// ============================================================
	{
		const first = pickKey({ url: "https://a.example.net/1.png", notePath: "notes/one.md" });
		const second = pickKey({ url: "https://a.example.net/2.png", notePath: "notes/one.md" });

		const empty = new Set();
		const one = toggleSelection(empty, first);
		assert.equal(one.has(first), true, "切换应勾上它");
		assert.equal(empty.size, 0, "★ 返回新的集合，不改原集合（改动调用方的东西会让状态有两个来源）");

		const two = toggleSelection(one, first);
		assert.equal(two.has(first), false, "再切一次应当取消勾选");
		assert.equal(one.has(first), true, "原集合不受影响");

		const both = toggleSelection(two, second);
		assert.equal(both.has(first), false, "取消勾选的那个保持取消");
		assert.equal(both.has(second), true, "另一个仍然勾着");

		for (const bad of ["", null, undefined, 42, {}]) {
			const unchanged = toggleSelection(one, bad);
			assert.equal(unchanged.has(first), true, `奇怪键不该改变选择：${JSON.stringify(bad)}`);
			assert.equal(unchanged.size, 1, `奇怪键不该增删条目：${JSON.stringify(bad)}`);
		}
	}

	// ============================================================
	// 3. selectEverything：勾**清单里每一行**，不多不少
	// ============================================================
	{
		// ⚠️ 参数按 `{ key }` 收口：几条链的行类型不同（`FileCard` 用 `id`，调用方做映射）
		const items = [
			{ key: "attachments/a.png" },
			{ key: pickKey({ url: "https://a.example.net/2.png", notePath: "notes/two.md" }) },
			{ key: "attachments/b.pdf" },
		];
		const all = selectEverything(items);
		assert.equal(all.size, 3, "★ 全选要勾上清单里每一行");
		for (const item of items) assert.equal(all.has(item.key), true, `漏了：${item.key}`);

		// ⚠️ 反向：**不残留**清单外的键（切换范围后残留的键会让提交多出几条不存在的条目）
		assert.equal(selectEverything([]).size, 0, "空清单全选之后还是空的");
		assert.equal(
			selectEverything([{ key: "x" }]).size,
			1,
			"全选只认传进来的这些（不是\"把见过的都留下\"）"
		);
	}

	return { cases: 3 };
}
