import { runMutations } from "./lib/mutate.mjs";
import { runValueGuardsSuite } from "./lib/value-guards-suite.mjs";

/**
 * 变异验证：`src/types.ts` 的三组模式守卫。
 *
 * `isCacheDisabled` 是「不留副本」的**唯一语义定义**；三组 `*_MODES` 是合法取值的
 * **唯一清单**（设置页的下拉与校验都从它生成）。它们改坏时不会报错，
 * 只会让"什么算合法/什么算关闭缓存"悄悄换一套。
 */
await runMutations({
	source: "src/types.ts",
	entries: ["src/types.ts", "src/records.ts"],
	suite: runValueGuardsSuite,
	mutations: [
		{
			// 后果：旧档位名 cache 也被当成"关闭缓存" ⇒ 老用户升级后行为凭空改变。
			name: "「关闭缓存」的判据放宽（旧档位名也算）",
			from: '\treturn action === "trash";',
			to: '\treturn action !== "keep";',
			expect: "旧档位名 cache 也不该算关闭缓存",
		},
		{
			// 后果：清单里多出一个已废弃的取值 ⇒ 设置页/校验接受一个不存在的档位。
			name: "本地副本清单里塞进已废弃的取值",
			from: 'export const LOCAL_COPY_ACTIONS: readonly LocalCopyAction[] = ["keep", "trash"];',
			to: 'export const LOCAL_COPY_ACTIONS: readonly LocalCopyAction[] = ["keep", "cache", "trash"];',
			expect: "本地副本的合法取值清单必须正好是 keep / trash",
		},
		{
			// 后果：站点模式多认一个词 ⇒ 用户手改 data.json 的畸形值会被当成合法并生效。
			name: "站点模式清单被改宽",
			from: 'export const EXTERNAL_SITE_MODES: readonly ExternalSiteMode[] = ["off", "blocklist", "allowlist"];',
			to: 'export const EXTERNAL_SITE_MODES: readonly ExternalSiteMode[] = ["off", "allow", "allowlist"];',
			expect: "站点模式的合法取值清单必须正好是 off / blocklist / allowlist",
		},
		{
			// 后果：notice 档从清单里消失 ⇒ 用户选了它，加载时却被判成非法值。
			name: "孤儿询问清单漏掉 notice 档",
			from: 'export const ORPHAN_ASK_MODES: readonly OrphanAskMode[] = ["always", "notice", "never"];',
			to: 'export const ORPHAN_ASK_MODES: readonly OrphanAskMode[] = ["always", "never"];',
			expect: "孤儿询问的合法取值清单必须正好是 always / notice / never",
		},
	],
});
