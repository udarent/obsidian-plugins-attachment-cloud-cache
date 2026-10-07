/**
 * 站外缓存询问通知（`src/ui/external-notice.ts`）的断言套件。
 *
 * ## 为什么必须注入假通知
 *
 * 测试替身里的 `Notice` 是**空壳**（没有 DOM），所以"挂了几颗按钮、点了会怎样"
 * 在 Node 里本来无从验证。把创建通知做成接缝之后，这里可以塞一个**记账的假通知**，
 * 把这些性质钉住。
 *
 * ⚠️ 但要说清楚它的边界：这些断言证明的是**我们的逻辑**（常驻、两颗按钮、
 * 点击后关闭并返回对应选择、重复点击不改变结果）。**真实观感** ——
 * 按钮在真实 `Notice` 里长什么样、在移动端能不能点中 —— 只能真机验证。
 */

import assert from "node:assert/strict";

// 内部有 await（等用户点击）→ 必须是 async 函数
export async function runExternalNoticeSuite(mod) {
	const { askExternalCacheWithNotice } = mod;

	/** 一个记账的假通知：记录创建出来的按钮与每次点击。 */
	function makeFakeNotice() {
		const created = [];
		const notice = {
			message: "",
			duration: null,
			hidden: 0,
			containerEl: {
				createEl(tag, options) {
					const button = {
						tag,
						text: options?.text,
						cls: options?.cls,
						handlers: [],
						addEventListener(event, handler) {
							if (event === "click") button.handlers.push(handler);
						},
						async click() {
							for (const handler of [...button.handlers]) await handler();
						},
					};
					created.push(button);
					return button;
				},
			},
			hide() {
				notice.hidden += 1;
			},
		};
		return { notice, buttons: created };
	}

	const options = { message: "来自 a.example.net 的图片 —— 缓存到你的存储？", cacheLabel: "缓存并记住该站点", neverLabel: "此站点不再询问" };

	// ============================================================
	// 1. ⭐ 必须常驻（duration: 0）
	// ============================================================
	// 用默认时长的话，用户在读完那段文字之前它就已经消失了 —— 而这是**只问一次**的机会。
	{
		const fake = makeFakeNotice();
		const seen = [];
		const promise = askExternalCacheWithNotice(options, {
			noticeFactory: (message, duration) => {
				seen.push({ message, duration });
				return fake.notice;
			},
		});
		assert.equal(seen.length, 1, "应恰好创建一个通知");
		assert.equal(seen[0].duration, 0, "★ 必须常驻（duration: 0）—— 否则用户还没看完它就没了");
		assert.equal(seen[0].message, options.message, "正文要原样传给通知");
		await fake.buttons[0].click();
		await promise;
	}

	// ============================================================
	// 2. 必须是两颗按钮，且文字正确
	// ============================================================
	{
		const fake = makeFakeNotice();
		const promise = askExternalCacheWithNotice(options, { noticeFactory: () => fake.notice });
		assert.equal(fake.buttons.length, 2, "★ 必须给出两个选择（只给一个等于没得选）");
		assert.equal(fake.buttons[0].tag, "button", "应当是按钮元素");
		assert.equal(fake.buttons[0].text, options.cacheLabel, "第一颗是「缓存」");
		assert.equal(fake.buttons[1].text, options.neverLabel, "第二颗是「不再询问」");
		assert.equal(fake.buttons[0].cls, "mod-cta", "「缓存」是主操作，要有主按钮样式");
		await fake.buttons[0].click();
		await promise;
	}

	// ============================================================
	// 3. 点「缓存」→ 返回 cache，并关闭通知
	// ============================================================
	{
		const fake = makeFakeNotice();
		const promise = askExternalCacheWithNotice(options, { noticeFactory: () => fake.notice });
		await fake.buttons[0].click();
		assert.equal(await promise, "cache", "★ 点第一颗应返回 cache");
		assert.equal(fake.notice.hidden, 1, "★ 选完必须关闭通知（否则留着一个没意义的空壳）");
	}

	// ============================================================
	// 4. 点「不再询问」→ 返回 never，并关闭通知
	// ============================================================
	{
		const fake = makeFakeNotice();
		const promise = askExternalCacheWithNotice(options, { noticeFactory: () => fake.notice });
		await fake.buttons[1].click();
		assert.equal(await promise, "never", "★ 点第二颗应返回 never");
		assert.equal(fake.notice.hidden, 1, "选完必须关闭通知");
	}

	// ============================================================
	// 5. ⭐ 重复点击不改变结果，也不会关闭两次
	// ============================================================
	// 两颗按钮在同一个容器上，用户完全可能连点两下（或点完这边又点那边）。
	{
		const fake = makeFakeNotice();
		const promise = askExternalCacheWithNotice(options, { noticeFactory: () => fake.notice });
		await fake.buttons[0].click();
		await fake.buttons[1].click();
		await fake.buttons[0].click();
		assert.equal(await promise, "cache", "★ 第一次点击之后的结果不该被后续点击改掉");
		assert.equal(fake.notice.hidden, 1, "★ 关闭动作只该发生一次");
	}
}
