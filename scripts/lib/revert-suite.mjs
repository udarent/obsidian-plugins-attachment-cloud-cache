/**
 * 「把链接改回本地路径」的断言（与变异验证共用）。
 *
 * 这一层的核心风险**不是**"改不回来"，而是"改错"：
 * - 本地副本已经不在了还改回去 ⇒ 造一条打不开的链接；
 * - 只认得 Markdown 一种写法 ⇒ 另外三种（行内 HTML / 引用式定义 / 带尺寸的嵌入）静默漏掉。
 */

import assert from "node:assert/strict";

const URL_A = "https://probe.invalid/bucket/a-hash.png";
const URL_B = "https://probe.invalid/bucket/b-hash.png";

/** 一个只有"一个笔记 + 两个附件"的最小 vault。 */
function makeEnv(initialNote, entries) {
	const files = [{ path: "attachments/a.png" }, { path: "attachments/b.png" }];
	const note = { path: "note.md", text: initialNote };
	const writes = [];
	const app = {
		vault: {
			getFiles: () => files,
			getMarkdownFiles: () => [{ path: note.path }],
			read: async () => note.text,
			getAbstractFileByPath: (path) => (path === note.path ? { path } : null),
			process: async (file, mutate) => {
				note.text = mutate(note.text);
				writes.push(file.path);
			},
		},
	};
	return {
		note,
		writes,
		ctx: {
			app,
			currentIndex: () => ({ toArray: () => entries }),
			t: (key) => key,
			confirmMaintenance: async () => true,
		},
	};
}

export async function runRevertSuite(mod) {
	const { planRevertText, revertTargets } = mod;
	const { revertLinksToLocal } = mod;

	// ── 纯函数：只改"能对上 URL"的那些，四种写法都要覆盖 ──
	{
		const targets = [
			{ url: URL_A, path: "attachments/a.png", name: "a.png" },
			{ url: URL_B, path: "attachments/b.png", name: "b.png" },
		];
		const text = [
			`![a](${URL_A})`,
			`<img src="${URL_B}">`,
			`![ref][r1]`,
			`[r1]: ${URL_A}`,
			`![600](${URL_B})`,
			"![](https://someone-else.invalid/x.png)",
		].join("\n");
		const plan = planRevertText(text, targets);
		assert.equal(plan.count, 4, "★ 四种写法都要改（Markdown / 行内 HTML / 引用式定义行 / 带尺寸的嵌入）");
		assert.ok(plan.text.includes("attachments/a.png"), "Markdown 那处要变成库内路径");
		assert.ok(plan.text.includes('src="attachments/b.png"'), "行内 HTML 只换属性值，标签结构不动");
		assert.ok(plan.text.includes("[r1]: attachments/a.png"), "引用式定义行要改在定义那一行上");
		assert.ok(plan.text.includes("![600](attachments/b.png)"), "带尺寸的嵌入改成 Markdown 图片，尺寸名留在 alt");
		assert.ok(plan.text.includes("someone-else.invalid"), "别家的地址一个字都不许动");
	}

	// ── 纯函数：本地副本不在 ⇒ 不进目标（改回去就是造坏链）──
	{
		const { targets, missing } = revertTargets({
			entries: [
				{ remoteUrl: URL_A, cachePath: "attachments/a.png", sourceName: "a.png" },
				{ remoteUrl: URL_B, cachePath: "attachments/gone.png", sourceName: "gone.png" },
			],
			present: (path) => path !== "attachments/gone.png",
		});
		assert.equal(targets.length, 1, "★ 本地副本不在的那份不许进改写目标");
		assert.equal(missing, 1, "但要**数出来**（确认框里如实说）");
	}

	// ── 流程：真的把笔记写回去，且只写被改过的那一篇 ──
	{
		const env = makeEnv(`![a](${URL_A})`, [
			{ remoteUrl: URL_A, cachePath: "attachments/a.png", sourceName: "a.png" },
		]);
		await revertLinksToLocal(env.ctx);
		assert.equal(env.note.text, "![a](attachments/a.png)", "★ 笔记里的链接要真的变成库内路径");
		assert.deepEqual(env.writes, ["note.md"], "只写被改过的那一篇（没改的不许碰）");
	}

	// ── 流程：一篇都对不上 ⇒ 一个字都不写 ──
	{
		const env = makeEnv("![](https://someone-else.invalid/x.png)", [
			{ remoteUrl: URL_A, cachePath: "attachments/a.png", sourceName: "a.png" },
		]);
		await revertLinksToLocal(env.ctx);
		assert.deepEqual(env.writes, [], "★ 没有可改的 ⇒ 一次写盘都不该发生");
	}

	// ── 流程：用户取消 ⇒ 一个字都不写 ──
	{
		const env = makeEnv(`![a](${URL_A})`, [
			{ remoteUrl: URL_A, cachePath: "attachments/a.png", sourceName: "a.png" },
		]);
		env.ctx.confirmMaintenance = async () => false;
		await revertLinksToLocal(env.ctx);
		assert.deepEqual(env.writes, [], "★ 取消之后不许动笔记");
	}
}
