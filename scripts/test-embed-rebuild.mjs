import { withLoadedTs } from "./lib/load-ts.mjs";
import { runEmbedRebuildSuite } from "./lib/embed-rebuild-suite.mjs";

/**
 * 非图片可预览附件的**节点重建**（`src/render/embed-rebuild.ts`）。
 *
 * 这一套守住的是"音频 / 视频 / PDF 离线也能直接看"——而宿主把它们渲染成了 `<img>`，
 * 改 `src` 救不了，只能换成正确的嵌入节点。⚠️ 它同时守着"远端地址绝不进元素"
 * 这条结构性质（离线零请求的来源）。
 */
await withLoadedTs(
	["src/render/embed-rebuild", "src/render/render-target", "src/vault-files", "src/s3/client"],
	async (mod) => {
		await runEmbedRebuildSuite(mod);
	}
);

console.log(
	"Embed-rebuild tests passed (the judgement comes from the same embeddable-type table the link " +
		"builder uses, so \"embed or plain link\" and \"swap src or rebuild the node\" can never drift " +
		"apart; only non-image targets are taken over; the local path is written instead of the remote " +
		"one, so no http(s) value is ever put into an element; a node that cannot be rendered (or whose " +
		"parent is not attached yet) leaves the original element untouched rather than blanking it; one " +
		"failing element never stops the batch; and a missing local copy is fetched first and only then " +
		"marked)."
);
