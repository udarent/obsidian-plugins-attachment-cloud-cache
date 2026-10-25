/**
 * 值形状守卫的套件（`src/types.ts` 的两组模式守卫 + `src/records.ts`）。
 *
 * ## 为什么这些"看着显然"的函数值得一套穷举
 *
 * 它们全部**直接决定持久化数据怎么被解释**：
 * - `isCacheDisabled` 是「不留副本」的**唯一语义定义** —— 四个调用点各有用例守着自己，
 *   但定义本身被改坏时，四处会一起"看起来正常地"改变行为；
 * - 两组 `*_MODES` 是"合法取值"的**唯一清单**，设置页的下拉与校验都从它生成；
 * - `isPlainRecord` 是设置合并 / 索引校验 / 错误解析的入口，`typeof null === "object"`
 *   与数组这两个坑是所有实现的第一现场。
 *
 * ⚠️ 这些函数没有副作用，所以每一条都可以直接断言"什么算、什么不算"，
 * 不需要构造宿主。
 */

import assert from "node:assert/strict";

export function runValueGuardsSuite(mod) {
	const {
		isPlainRecord,
		isLocalCopyAction,
		isCacheDisabled,
		isExternalSiteMode,
		LOCAL_COPY_ACTIONS,
		EXTERNAL_SITE_MODES,
	} = mod;

	// ============================================================
	// 1. `isPlainRecord`：null 与数组是两个必须挡住的坑
	// ============================================================
	assert.equal(isPlainRecord(null), false, "null 不是普通对象（typeof null === 'object' 是 JS 的老陷阱）");
	assert.equal(isPlainRecord([]), false, "数组不是普通对象（否则会读到一堆下标键）");
	assert.equal(isPlainRecord({ a: 1 }), true, "普通对象应通过");
	assert.equal(isPlainRecord("x"), false, "基本类型不是普通对象");
	assert.equal(isPlainRecord(undefined), false, "undefined 不是普通对象");

	// ============================================================
	// 2. `isCacheDisabled`：只有「不留副本」那一档算关闭缓存
	// ============================================================
	// 这一条是「不留副本」的**唯一语义定义**：改坏它，四处调用点会一起变行为，
	// 而每一处自己的用例仍然"看起来是对的"（它们测的是调用后的效果，不是定义）。
	assert.equal(isCacheDisabled("trash"), true, "「不留副本」必须算关闭缓存");
	assert.equal(isCacheDisabled("keep"), false, "「保留副本」不该算关闭缓存");
	assert.equal(isCacheDisabled("cache"), false, "旧档位名 cache 也不该算关闭缓存");
	assert.equal(isCacheDisabled(undefined), false, "未设置（undefined）不该算关闭缓存");

	// ============================================================
	// 3. 两组合法取值清单：清单本身就是判据
	// ============================================================
	assert.deepEqual(
		[...LOCAL_COPY_ACTIONS],
		["keep", "trash"],
		"本地副本的合法取值清单必须正好是 keep / trash"
	);
	assert.equal(isLocalCopyAction("keep"), true, "keep 是合法取值");
	assert.equal(isLocalCopyAction("trash"), true, "trash 是合法取值");
	assert.equal(isLocalCopyAction("cache"), false, "旧档位名 cache 已不是合法取值");

	assert.deepEqual(
		[...EXTERNAL_SITE_MODES],
		["off", "blocklist", "allowlist"],
		"站点模式的合法取值清单必须正好是 off / blocklist / allowlist"
	);
	assert.equal(isExternalSiteMode("allow"), false, "站点模式只认 off / blocklist / allowlist（别的词不算）");
	assert.equal(isExternalSiteMode("OFF"), false, "取值是大小写敏感的（不做大小写归一）");

	return { guards: 2 };
}
