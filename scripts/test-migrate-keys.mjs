import { withLoadedTs } from "./lib/load-ts.mjs";
import { runMigrateKeysSuite } from "./lib/migrate-keys-suite.mjs";

/**
 * 「统一对象名」的纯逻辑测试（`src/maintenance/migrate-keys.ts`，CR-15）。
 *
 * 这一层决定"哪些旧对象要复制、哪些只改链接、哪些可以直接删"，以及
 * **什么时候才允许删旧对象**。它是本项目第一次批量改用户笔记，所以
 * 断言都按后果写名字：分档错一条 ⇒ 链接改到不存在的对象上（图裂）；
 * 复核漏一种形态 ⇒ 删掉还在被引用的对象（不可逆）。
 *
 * 断言在 `lib/migrate-keys-suite.mjs`（与变异验证共用同一份）。
 */
await withLoadedTs("src/maintenance/migrate-keys", async (mod) => {
	const stats = await runMigrateKeysSuite(mod);
	console.log(
		`Migrate-keys tests passed (${stats.cases} groups: 四档分档 / 幂等收敛 / 同内容多份 / ` +
			`改写规则 / 复核两种形态 / 删除闸门 / 改名闸门 / 形状判据)`
	);
});
