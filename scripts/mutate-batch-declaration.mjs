import { runMutations } from "./lib/mutate.mjs";
import { runBatchDeclarationSuite } from "./lib/batch-declaration-suite.mjs";

/**
 * 变异验证：「整批一次写云端声明」的编排。
 *
 * 守的不是「快了多少」而是**失败方向**：集合只在整批声明确实成功时才交给
 * `ingest`；漏传会退回逐文件（慢），错传会让对象传上去却没有引用保护（丢数据）。
 */
await runMutations({
	source: "src/maintenance/run.ts",
	entries: ["src/maintenance/run", "src/cache/index", "src/settings", "src/core/ingest"],
	suite: runBatchDeclarationSuite,
	mutations: [
		{
			// 后果：整批声明写好了，但 ingest 不知道 ⇒ 每个文件又各写一次，优化完全失效。
			name: "★ 阶段一盘好了却没把集合传给 ingest（每文件仍写一次声明）",
			from: "\t\t\t\tdeclaredHashes,\n",
			to: "",
			expect: "每个 ingest 都要收到含自己哈希的已声明集合",
		},
		{
			// 后果：整批声明阶段整个不跑 ⇒ 退回逐文件读-改-写（用户看到的还是 1s/文件）。
			name: "★★ 整批声明阶段没接线（退回每文件一次读-改-写）",
			from: "\tif (chosenPaths.length > 0 && deps.planAttachmentRef && deps.declareRefBatch) {",
			to: "\tif (false) {",
			expect: "整批声明只该调一次",
		},
		{
			// 后果：声明写失败也把集合传下去 ⇒ ingest 跳过逐文件声明 ⇒
			// 对象传上去了、云端却没有一条引用保护它（下一次清理会当孤儿删掉）。
			name: "★★ 批量声明失败仍传集合（对象没有引用保护）",
			from: "\t\t\tif (refs.size > 0 && (await deps.declareRefBatch([...refs.values()]))) {",
			to: "\t\t\tif (await deps.declareRefBatch([...refs.values()]) || true) {",
			expect: "批量声明失败必须退回逐文件声明",
		},
		{
			// 后果：集合是空的 ⇒ ingest 查表查不到，但代码又以为「盘过了」而不发逐文件
			// 声明 ⇒ 同样是没有保护的对象（比 3 更隐蔽：声明 PUT 次数看着是对的）。
			name: "★★ 传了空集合（查表落空却不再逐文件补声明）",
			from: "\t\t\t\tdeclaredHashes = new Set(refs.keys());",
			to: "\t\t\t\tdeclaredHashes = new Set();",
			expect: "每个 ingest 都要收到含自己哈希的已声明集合",
		},
		{
			// R14 重评：并发度压回 1 ⇒ 用户看到的又是 N 个串行 RTT。
			name: "★★ 并发上传被悄悄改回串行（1s/文件又回来了）",
			from: "\tconst UPLOAD_CONCURRENCY = 4;\n",
			to: "\tconst UPLOAD_CONCURRENCY = 1;\n",
			expect: "整批声明成功时必须并发",
		},
		{
			// ⚠️ D-86：降级到逐文件声明时循环里会并发读-改-写同一份 head.json ⇒ 丢引用。
			// 闸门不是装饰，删掉它是「对象传上去了却没有保护」那一侧。
			name: "★★ 并发闸门失效（降级时并发覆盖 head.json 丢引用）",
			from: "\tconst concurrency = declaredHashes !== undefined ? Math.min(UPLOAD_CONCURRENCY, chosenPaths.length) : 1;\n",
			to: "\tconst concurrency = Math.min(UPLOAD_CONCURRENCY, chosenPaths.length);\n",
			expect: "退回逐文件声明必须串行",
		},
		{
			// 有序提交换成「谁先做完谁先报」⇒ 界面行序、改写规则顺序全部随网络抖动。
			name: "★★ 提交乱序（进度与改写规则跟着网络完成顺序漂）",
			from: "\t\t\toutcomes[index] = await processOne(chosenPaths[index]);\n\t\t\tflush();\n",
			to: "\t\t\tconst outcome = await processOne(chosenPaths[index]);\n\t\t\toutcomes[index] = outcome;\n\t\t\tapplyOne(index, outcome);\n",
			expect: "完成顺序乱了，进度仍要按清单顺序逐项报",
		},
		{
			// 上限一放开，几百张图同时 PUT 会打爆连接 / 移动端 OOM。
			name: "★ 并发上限被放开（一批附件全部同时打出去）",
			from: "\tconst UPLOAD_CONCURRENCY = 4;\n",
			to: "\tconst UPLOAD_CONCURRENCY = 999;\n",
			expect: "并发必须有上限",
		},
		{
			// R14 三条之一「失败能定位到具体一件」：漏计数 = 界面那一行停在等待。
			name: "★ 单件失败没计数（界面那一行永远停在等待）",
			from: "\t\tconst failed = (): void => {\n\t\t\tresult.failed += 1;\n\t\t\toptions.onItem?.({ kind: \"vault\", path, status: \"failed\" });\n\t\t};\n",
			to: "\t\tconst failed = (): void => {\n\t\t\toptions.onItem?.({ kind: \"vault\", path, status: \"failed\" });\n\t\t};\n",
			expect: "抛错的那份只算一件失败",
		},
	],
});
