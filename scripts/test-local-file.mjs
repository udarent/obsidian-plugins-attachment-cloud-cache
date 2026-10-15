import { withLoadedTs } from "./lib/load-ts.mjs";
import { runLocalFileSuite } from "./lib/local-file-suite.mjs";

/**
 * 「本机文件」（`file:///D:/…`）的测试。
 *
 * 这条路的定位：与「站外文件」是**同一件事的两半**（都要搬进用户自己的存储、都要改写链接），
 * 只差"字节从哪来"（那边去网上下，这边**从本机磁盘读**）。
 *
 * ⚠️ 它是全库唯一会**读用户本机任意文件**的地方 ⇒ 三件事必须钉住：
 * ① 形态解析别认错（认错 = 读了一份别的文件）；② 扩展名闸门别放宽（它是"不加目录白名单"之后
 * 唯一还站着的技术边界）；③ 非桌面一律不认（手机拿不到本机绝对路径）。
 *
 * ⚠️ 同时打包 `src/vault-files`（扩展名/内容类型/可嵌入判定都从那里来 —— 与站外那条链**同一份**）。
 */
await withLoadedTs(["src/local-file", "src/vault-files"], async (mod) => {
	const stats = await runLocalFileSuite(mod);
	console.log(
		`Local-file tests passed (${stats.cases} cases: every form seen on real machines parses ` +
			"(triple slash, file:/, UNC, percent-encoded Chinese) while relative paths and null bytes are " +
			"refused outright; the extension gate only lets through what can be embedded in a note, so ticking " +
			"a screenshot never turns into ticking an arbitrary file; non-desktop is ignored because phones " +
			"cannot reach a local absolute path; and reading really goes to disk - size is checked before the " +
			"bytes are pulled in, a moved file is reported as missing, a directory is not.)"
	);
});
