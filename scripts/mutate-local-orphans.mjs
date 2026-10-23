import { runMutations } from "./lib/mutate.mjs";
import { runLocalOrphansSuite } from "./lib/local-orphans-suite.mjs";

/**
 * 变异验证：「没有任何引用的本地文件」怎么挑（`src/maintenance/local-orphans.ts`，D-74），
 * 以及站外缓存副本怎么分到它自己那一栏（D-77）。
 *
 * 这一层唯一的后果就是**删错文件**，而它的每一条排除都对应一件具体的坏事
 * （见 `local-orphans-suite.mjs` 文件头那张表）。
 */
await runMutations({
	source: "src/maintenance/local-orphans.ts",
	entries: ["src/maintenance/local-orphans", "src/vault-files"],
	suite: runLocalOrphansSuite,
	mutations: [
		{
			// 后果：**删掉宿主自己的目录** —— `.obsidian/` 里是插件与设置（本插件自己的
			// `.cache-index.json` 就在那儿）。⚠️ 2026-10-22 实测抓到的就是这一格。
			name: "★★★ 不再排除宿主自己的目录（配置目录 / 回收站进了清理清单）",
			from: '\t\tif (options.excludedPrefixes.some((prefix) => prefix !== "" && path.startsWith(prefix)) || topFolder.startsWith(".")) {',
			to: "\t\tif (false) {",
			expect: "宿主自己的目录（配置目录 / 回收站）里的文件一个都不许列",
		},
		{
			// 后果：**"被远端 URL 引用"不算在用** ⇒ 已经迁到云端、链接也改好的附件被当成孤立，
			// 一清就删掉正在显示的图（那份副本没了就得重新下载，离线直接看不到）。
			name: "★★ 只认本地引用（链接已改成远端地址的附件被当成孤立）",
			from: "\t\tif (options.usedPaths.has(path)) {",
			to: "\t\tif (false) {",
			expect: "两份「有人在用」的都要排除",
		},
		{
			// 后果：**站外缓存副本混进普通清单** ⇒ 它们被当成「用户自己的文件」，
			// 标签、默认勾选、以及“删了会怎样”的解释全部错位（D-77）。
			name: "★★ 站外缓存副本混进普通清单（标签与默认勾选都错）",
			from: "\t\tif (options.externalPaths.has(path)) {",
			to: "\t\tif (false) {",
			expect: "站外缓存副本要单独一栏",
		},
		{
			// 后果：**站外缓存副本被整个丢掉** ⇒ 用户要清缓存时清单里
			// 一行都没有（D-77 之前就是这个状态：它们被硬排除）。
			name: "★★ 站外缓存副本被整个丢掉（清单里一行都没有）",
			from: "\t\t\tcachedPaths.push(path);",
			to: "",
			expect: "站外缓存副本要单独一栏",
		},
		{
			// 后果：**同一个文件在清单里出现两行**（一行"云端"、一行"本地"）⇒ 两行各删一次，
			// 第二次删的是别的行正在指的东西（或者直接报失败）。
			name: "★★ 云端清单已覆盖的路径又列一遍（同一个文件出现两行）",
			from: "\t\tif (options.coveredPaths.has(path)) {",
			to: "\t\tif (false) {",
			expect: "云端清单已覆盖的路径不重复列",
		},
		{
			// 后果：**笔记被当成附件** ⇒ 清理清单里出现 `.md`，删了就是删一篇笔记。
			name: "★★ 笔记类不再排除（清理清单里出现 .md）",
			from: "\t\tif (isNoteLikeExtension(extension)) {",
			to: "\t\tif (false) {",
			expect: "笔记类必须排除",
		},
	],
});
