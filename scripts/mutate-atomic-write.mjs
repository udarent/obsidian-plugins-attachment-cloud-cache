import { runMutations } from "./lib/mutate.mjs";
import { runAtomicWriteSuite } from "./lib/atomic-write-suite.mjs";

/**
 * 变异验证：`writeJsonAtomically`（`src/atomic-write.ts`）。
 *
 * 这段实现原本在 `cache/store.ts` 与 `host/site-store.ts` 里各有一份逐字相同的版本。
 * 合并之后它是**两个 store 唯一的落盘路径**，所以这里的每条失效都同时影响两份数据。
 *
 * 失效方式全是静默的：目标文件照样存在、内容也对，坏的只是**过程** ——
 * 截断风险、或某类宿主上永远存不上。
 */
await runMutations({
	source: "src/atomic-write.ts",
	entries: ["src/atomic-write"],
	suite: runAtomicWriteSuite,
	mutations: [
		{
			// 后果：直接写目标文件 ⇒ 写到一半被同步工具读走，就是一份截断的 JSON，
			// 而"上一次还能用、这次打不开了"极难归因。
			name: "★ 跳过临时文件、直接写目标（截断风险回来了）",
			from: "\tconst temp = `${path}${TEMP_SUFFIX}`;\n\tawait adapter.write(temp, payload);",
			to: "\tconst temp = `${path}${TEMP_SUFFIX}`;\n\tawait adapter.write(path, payload);",
			expect: "必须先写 .tmp 再 rename",
		},
		{
			// 后果：rename 失败后不再退回直接写 ⇒ 那类适配器上**永远存不上**，
			// 而症状只是"设置没保存"。
			//
			// ⚠️ 锚点必须落在 **catch 里那次写**上。第一版我把变异写成了
			// "rename 之后 return" —— 那改的是**成功路径**，是个语义空操作，
			// 于是报"漏过（测试无牙）"。**变异写错了会看起来像测试没牙。**
			name: "★ 去掉 rename 的兜底（不支持的适配器上永远存不上）",
			from: "\t\ttry {\n\t\t\tawait adapter.write(path, payload);",
			to: "\t\ttry {\n\t\t\tvoid payload;",
			expect: "rename 失败要退回直接写",
		},
		{
			// 后果：退回之后留下 .tmp 垃圾，且同步工具会读到它。
			name: "退回后不清临时文件（留下垃圾且会被同步读走）",
			from: "\t\t} finally {\n\t\t\tawait removeQuietly(adapter, temp);\n\t\t}",
			to: "\t\t} finally {\n\t\t\tvoid temp;\n\t\t}",
			expect: "退回之后必须清掉临时文件",
		},
		{
			// 后果：为删不掉一个中间产物而让"保存"失败 —— 损失远大于留一个 .tmp。
			name: "★ 清临时文件失败就抛出（一个中间产物把保存搞失败）",
			from: "\t} catch {\n\t\t// 忽略\n\t}",
			to: "\t} catch (error) {\n\t\tthrow error;\n\t}",
			expect: "清临时文件失败必须被吞掉",
		},
		{
			// 后果：父目录不存在时直接写 ⇒ 抛错，表现为"存储目录被删过之后就再也存不上了"。
			name: "★ 不建父目录（目录被删过之后再也存不上）",
			from: "\tif (folder && !(await adapter.exists(folder))) {\n\t\tawait adapter.mkdir(folder);\n\t}",
			to: "\tvoid folder;",
			expect: "父目录不存在时必须先 mkdir",
		},
		{
			// 后果：反斜杠路径推不出父目录 ⇒ mkdir 建出错误层级，文件写进一个不存在的目录。
			name: "路径不再归一（反斜杠路径推错父目录）",
			from: '\tconst folder = path.replace(/\\\\/g, "/")',
			to: '\tconst folder = path.replace(/█/g, "/")',
			expect: "反斜杠路径要归一出正确的父目录",
		},
	],
});
