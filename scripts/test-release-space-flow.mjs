import { withLoadedTs } from "./lib/load-ts.mjs";
import { runReleaseSpaceFlowSuite } from "./lib/release-space-flow-suite.mjs";

/**
 * 「清理本地占用」（F18）**编排层**的测试。
 *
 * 这段编排此前是 `main.ts` 的私有方法（套件加载不了插件类）。判定层有
 * `release-space-suite` 守着，而**执行层**（`deleteVerifiedCopies`：删之前
 * 逐个复核"索引里还认这条记录吗"与"云端现在还有这个对象吗"）此前一条断言也没有 ——
 * 这条流程调的就是线上那个 `runReleaseSpace`，所以它也一并把执行层走通了。
 *
 * ⚠️ 同时打包 `src/i18n`（真实文案）与 `src/s3/client`（`publicUrlFor`：
 * 笔记里的链接由插件自己的函数生成，而不是测试手拼的字符串）。
 */
await withLoadedTs(
	["src/plugin/release-space-flow", "src/i18n", "src/s3/client", "src/maintenance/run"],
	async (mod) => {
		const stats = await runReleaseSpaceFlowSuite(mod);
		console.log(
			`Release-space flow tests passed (${stats.cases} cases: the two admission rules really are wired ` +
				"through - an entry missing from the upload ledger or a copy no note links to never reaches the " +
				"confirmation, so a file we never uploaded or a note-less orphan is not deleted; the manual entry " +
				"speaks up when there is nothing to clear and the settings-change entry stays quiet, and a stale " +
				"index record is reported with its own wording; the confirmation carries the amount, the " +
				"permanence, the irreversibility and the promise that storage and notes are untouched; cancelling " +
				"deletes nothing and never asks the cloud; confirming deletes the copy only after re-checking the " +
				"cloud holds it; when nothing could be deleted the plugin explains why instead of leaving the " +
				"user with a silent 'skipped N'; and with a local-copy limit set the same button stops at that " +
				"limit instead of clearing everything - still leaving copies no note links to alone, and saying " +
				"where those went instead.)"
		);
	}
);
