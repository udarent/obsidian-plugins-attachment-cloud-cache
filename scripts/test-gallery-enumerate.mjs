import { withLoadedTs } from "./lib/load-ts.mjs";
import { runGalleryEnumerateSuite } from "./lib/gallery-enumerate-suite.mjs";

/**
 * 附件管理的枚举与四态（`src/gallery/enumerate.ts`，R24 / F22）。
 *
 * 断言在 `lib/gallery-enumerate-suite.mjs`（与变异验证共用同一份）。
 */
await withLoadedTs(["src/gallery/enumerate"], async (mod) => {
	const stats = await runGalleryEnumerateSuite(mod);
	console.log(
		`Gallery-enumerate tests passed (${stats.cases} rows: 笔记/画布/数据库不进列表；已上传 / 未上传 / 云端有本地无三态互斥，` +
			`证据区分 index / ledger / none；“有没有人引用”问路径与 URL 两半；站外缓存副本带 origin；` +
			`同一对象不出两行；同一份输入顺序稳定).`
	);
});
