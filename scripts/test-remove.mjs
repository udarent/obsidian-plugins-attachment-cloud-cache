import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { withLoadedTs } from "./lib/load-ts.mjs";
import { runRemoveSuite } from "./lib/remove-suite.mjs";

/**
 * 「缓存文件怎么删」的测试（`src/maintenance/remove.ts`）。
 *
 * 全库只有这一个文件决定"用哪个宿主 API 把缓存文件拿掉"，而两条调用路径
 * （后台自动淘汰、用户确认后的清理命令）都从这里过 —— 所以这个判断
 * 值得单独钉住，而不是只在验收里顺带看一眼。
 *
 * ## 为什么还要一组**静态**守卫
 *
 * 行为断言只能验"这一次调用了什么"；而本次要守的东西里有几条是**关于整个代码库**
 * 的（"那个备选设计不存在"、"只有一处删文件"）。那类事实恰恰**最容易在重构里悄悄回来** ——
 * 加一个分支不会有任何行为断言变红。所以直接在源码文本上钉：
 *
 * - 缓存维护层（`run.ts` / `rotation.ts` / `remove.ts`）里**不许出现** `trashFile`；
 * - 全 `src/` 里 `vault.delete(` **恰好一处**（就是 `remove.ts`）；
 * - 「删除方式」这个设置项与它的文案键**不存在**；
 * - ⭐ 反过来：**不许扫到不该扫的东西** —— `localCopy: "trash"`（上传后不留本地副本，
 *   删的是**用户自己的文件**）必须完好无损。少了这一条，一次"清理冗余"就可能顺手
 *   把那条与本次无关、但完全合理的路径也拆掉，而且不会有任何测试变红。
 *
 * 这组断言按设计**不参与变异验证**：它们不依赖任何被变异的实现，而是盯着
 * "有没有人把那个设计加回来/把另一条路径拆掉"。变异运行器跑的是行为套件，
 * 这组在普通测试里跑——两条腿各管一件事。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SRC = join(ROOT, "src");

function read(relativePath) {
	return readFileSync(join(ROOT, relativePath), "utf8");
}

/** 递归列出 `src/` 下所有 `.ts`（返回仓库相对路径，用 `/` 分隔）。 */
function listSourceFiles() {
	return readdirSync(SRC, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => relative(ROOT, join(entry.parentPath ?? SRC, entry.name)).split(sep).join("/"))
		.sort();
}

await withLoadedTs(["src/maintenance/remove", "src/types"], runRemoveSuite);

// ============================================================
// 静态守卫 ①：缓存维护层绝不出现 `trashFile`
// ============================================================
const CACHE_MAINTENANCE = [
	"src/maintenance/remove.ts",
	"src/maintenance/run.ts",
	"src/maintenance/rotation.ts",
	"src/maintenance/eviction.ts",
	"src/maintenance/audit.ts",
];
for (const file of CACHE_MAINTENANCE) {
	assert.ok(
		!read(file).includes("trashFile"),
		`★ ${file} 里出现了 trashFile —— 缓存清理**不该**走回收站（回收站不释放物理空间，` +
			`与「空间有限」的动机直接矛盾，那个备选已按需求去掉）`
	);
}

// ============================================================
// 静态守卫 ②：全 src/ 只有**一处**真正删文件
// ============================================================
// 这条是"删除原语只有一个落点"这条不变量的**可执行版本**。
// 它同时挡住两种退化：新写一个删除点（绕过这层唯一的校验与理由），
// 以及在别处偷偷用底层删除。
const deleteSites = listSourceFiles().filter((file) => read(file).includes("vault.delete("));
assert.deepEqual(
	deleteSites,
	["src/maintenance/remove.ts"],
	`★ \`vault.delete(\` 只允许出现在 remove.ts 一处（实际：${JSON.stringify(deleteSites)}）—— ` +
		`多一处就多一个绕过「先校验路径、再拿删除凭据」的机会`
);

// `adapter.remove` 是底层删除：绕开宿主的**文件索引**（不是回收站设置），
// 会在磁盘上删掉文件而宿主仍认得它 → "看得见、读不到"的幽灵条目。
//
// ⚠️ 第一版这条守卫写得太宽（扫的是 `adapter.remove` 这个**字面量**），于是它
// 立刻打在**合法的**代码上 —— 那是原子写的收尾：删插件**自己刚写下的 `.tmp`
// 中间产物**，不是任何用户可见的文件。（这正是"静态守卫最容易犯的错：扫过头"。）
//
// ⚠️ 后来它又拦了一次，而那次拦得对：那两处 `removeQuietly()` 被合进了
// `src/atomic-write.ts`（两个 store 的落盘实现原本逐字相同），于是
// 允许列表里那两个文件**都不存在了**。守卫逼着人回头确认"新的这一处
// 删的还是临时文件吗"—— 答案是没有变，只是从两份变成了一份。
//
// 所以收窄成两件事，各自都有明确的理由：
//   ① 匹配**真的调用**（带括号），不匹配注释里的提及；
//   ② 用**显式白名单**列出允许出现的位置 —— 多一处就要人来确认它是"临时文件"
//      还是"用户的文件"。这点摩擦是刻意的：后者才是要防的东西。
const adapterRemoveSites = listSourceFiles().filter((file) => read(file).includes("adapter.remove("));
assert.deepEqual(
	adapterRemoveSites,
	["src/atomic-write.ts"],
	`★ \`adapter.remove(\` 只允许出现在这一处（原子写收尾时删自己的 .tmp 中间产物）。` +
		`新出现的地点要先确认它删的是临时文件而不是用户的文件 —— 实际：${JSON.stringify(adapterRemoveSites)}`
);

// 更要紧的一条：**缓存维护层**（决定"删哪些文件"的地方）一处都不许有。
for (const file of CACHE_MAINTENANCE) {
	assert.ok(
		!read(file).includes("adapter.remove("),
		`★ ${file} 里出现了 adapter.remove —— 维护层删的是用户的缓存文件，` +
			`必须走宿主 API（拿不到删除凭据就跳过），绝不是底层删除`
	);
}

// ============================================================
// 静态守卫 ③：「删除方式」这个备选设计必须整体不存在
// ============================================================
{
	const types = read("src/types.ts");
	assert.ok(!types.includes("DeleteMode"), "★ types.ts 里不该再有 DeleteMode（那个备选已被去掉）");
	assert.ok(!types.includes("DELETE_MODES"), "★ types.ts 里不该再有 DELETE_MODES");

	const settings = read("src/settings.ts");
	assert.ok(!settings.includes("deleteMode"), "★ 设置里不该再有 deleteMode 这一项");

	const i18n = read("src/i18n.ts");
	for (const forbidden of [
		"deleteMode",
		"maintainCleanSummary_",
		"maintainCleanSafety_",
		"maintainCleanCta_",
		"cacheEvicted_trash",
		"cacheEvictedPartial_trash",
	]) {
		assert.ok(!i18n.includes(forbidden), `★ 文案里不该再有 ${forbidden}（单一删除方式不需要分叉）`);
	}
	// 正向：收敛后的键必须在，否则通知/确认框会显示成键名本身
	for (const required of ["maintainCleanSummary:", "maintainCleanSafety:", "maintainCleanCta:", "cacheEvicted:"]) {
		assert.ok(i18n.includes(required), `★ 文案里必须有收敛后的单键 ${required}`);
	}
}

// ============================================================
// 静态守卫 ④：⭐ 别扫到不该扫的东西
// ============================================================
// 本次要去掉的是**缓存清理的**回收站备选。而 `localCopy: "trash"`
// （上传成功后不留本地副本）删的是**用户自己的原始文件**，是完全不同的决定，
// 必须原样保留。这一条把它钉住 —— "清理冗余"最容易犯的错就是扫过头。
{
	const types = read("src/types.ts");
	assert.ok(
		types.includes('export const LOCAL_COPY_ACTIONS: readonly LocalCopyAction[] = ["cache", "keep", "trash"]'),
		"★ localCopy 的 trash 必须保留（那是「上传后不留本地副本」，删的是用户自己的文件）"
	);

	const ingest = read("src/core/ingest.ts");
	assert.ok(ingest.includes("trashFile"), "★ 上传后不留副本那条路径仍然走回收站，不该被动过");

	const i18n = read("src/i18n.ts");
	for (const required of ["localCopy_trash", "localCopyDesc"]) {
		assert.ok(i18n.includes(required), `★ ${required} 必须保留（与缓存清理的删除方式无关）`);
	}
}

console.log("remove: 行为断言 + 静态守卫都通过");
