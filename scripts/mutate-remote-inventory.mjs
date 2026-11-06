import { runMutations } from "./lib/mutate.mjs";
import { runRemoteInventorySuite } from "./lib/remote-inventory-suite.mjs";

/**
 * 变异验证：云端盘点（列桶 → 内容哈希集合）。
 *
 * 这里守的是「批量上传预检」换新实现后最不能坏的两件事：
 * - 只收**能反推内容哈希**的对象（把 key 当哈希收进来，会让候选被误判成"云端已有"）；
 * - 失败方向必须安全（列不到 / 翻不完 ⇒ `null`，退回逐文件 HEAD，而不是假装"空桶"）。
 */
await runMutations({
	source: "src/maintenance/remote-inventory.ts",
	entries: ["src/maintenance/remote-inventory"],
	suite: runRemoteInventorySuite,
	mutations: [
		{
			// 后果：声明（`_acc/…`）与第三方对象的 key 被当成哈希收进来，
			// 而它们与候选的 contentHash 永远对不上 ⇒ 不会误判"在"，但会把集合撑大、
			// 且语义上"哈希集合"里混进了 key。
			name: "不认识的 key 也被当哈希收进来（声明/第三方对象混进哈希集合）",
			from: "if (hash) hashes.add(hash);",
			to: "hashes.add(object.key);",
			expect: "只收能反推内容哈希",
		},
		{
			// 后果：列桶抛错（拿不到 ListBucket / 网络错）被当成"空桶" ⇒ 所有候选都走上传，
			// 而"不知道"本该退回逐文件 HEAD（那才是安全的、且能省字节的一侧）。
			name: "列桶抛错不兜底（把失败当成空桶，而不是退回逐文件 HEAD）",
			from: "\t\t} catch {\n\t\t\t// 拿不到 ListBucket / 网络错 / 超时 ⇒ 不知道，退回逐文件 HEAD\n\t\t\treturn null;\n\t\t}",
			to: "\t\t} catch {\n\t\t\t// 拿不到 ListBucket / 网络错 / 超时 ⇒ 不知道，退回逐文件 HEAD\n\t\t\treturn new Set();\n\t\t}",
			expect: "列不到应返回 null",
		},
		{
			// 后果：翻不完被当成"列到了" ⇒ 只拿到部分哈希集合，
			// 于是"云端已有但没列到"的候选会被重传（浪费字节），且判据从"不知道"退化成"猜"。
			name: "翻不完被当成已列完（部分清单当全量，漏掉的候选被重传）",
			from: '\t// 翻不完 = 不知道（不是"没有"）\n\treturn null;',
			to: '\t// 翻不完 = 不知道（不是"没有"）\n\treturn hashes;',
			expect: "翻不完应返回 null",
		},
	],
});
