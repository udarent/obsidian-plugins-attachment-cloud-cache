/**
 * 站点决定记忆持久化（`src/host/site-store.ts`）的断言套件。
 *
 * ## 两条硬要求（与缓存索引同一套纪律）
 *
 * 1. **读不到 / 读坏了都必须能继续跑。** 与索引不同的是：这份文件存的是
 *    **用户回答过的内容**，丢了会重新被问（烦，但不致命）。所以更没理由为它抛错 ——
 *    一个手改坏的文件绝不能让插件起不来。
 * 2. **写入不能留下半截文件。** 这份文件也在 `.obsidian/` 下，同样可能被
 *    同步工具在任意时刻读到，所以同样要"先写临时文件再改名"。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppMock } from "./mock-obsidian.mjs";

/**
 * 记录适配器调用的包装层 —— 用来断言"写入走了临时文件 + 改名"这条协议。
 *
 * 直接断言文件系统状态是抓不住它的：写完直接写目标文件，最终内容**也是对的**，
 * 区别只在"崩溃时会不会留下半截" —— 那只能靠**过程**来验证。
 */
function makeRecordingAdapter(inner) {
	const ops = [];
	return {
		ops,
		exists: async (p) => {
			ops.push(`exists ${p}`);
			return inner.exists(p);
		},
		read: async (p) => {
			ops.push(`read ${p}`);
			return inner.read(p);
		},
		write: async (p, data) => {
			ops.push(`write ${p}`);
			return inner.write(p, data);
		},
		mkdir: async (p) => {
			ops.push(`mkdir ${p}`);
			return inner.mkdir(p);
		},
		rename: async (a, b) => {
			ops.push(`rename ${a} ${b}`);
			return inner.rename(a, b);
		},
		remove: async (p) => {
			ops.push(`remove ${p}`);
			return inner.remove(p);
		},
	};
}

/**
 * 一个**严格**的假适配器：父目录不存在时 `write` / `rename` 直接失败。
 *
 * 存在的理由写在正文里（替身的 `write` 会顺手建父目录，比真实系统宽容）。
 * 它只实现这条链上用到的几个方法，且**不假装**自己更聪明。
 */
function makeStrictAdapter() {
	const folders = new Set();
	const files = new Set();
	const dirOf = (p) => p.split("/").slice(0, -1).join("/");
	const requireParent = (p) => {
		const dir = dirOf(p);
		if (dir && !folders.has(dir)) throw new Error(`ENOENT: 父目录不存在 ${dir}`);
	};
	return {
		exists: async (p) => folders.has(p) || files.has(p),
		read: async (p) => {
			if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
			return "";
		},
		write: async (p, data) => {
			requireParent(p);
			void data;
			files.add(p);
		},
		mkdir: async (p) => {
			folders.add(p);
		},
		rename: async (from, to) => {
			requireParent(to);
			files.delete(from);
			files.add(to);
		},
		remove: async (p) => {
			files.delete(p);
		},
	};
}

export async function runSiteStoreSuite(mod) {
	const { SITE_DECISIONS_FILE, siteDecisionsFilePath, loadSiteDecisions, saveSiteDecisions, createSiteStore } = mod;
	const { SiteDecisions } = mod;

	// ============================================================
	// 1. 路径推导
	// ============================================================
	assert.equal(SITE_DECISIONS_FILE, ".site-decisions.json", "文件名以点开头（不进宿主的文件索引）");
	assert.equal(
		siteDecisionsFilePath(".obsidian/plugins/acc"),
		`.obsidian/plugins/acc/${SITE_DECISIONS_FILE}`,
		"正常插件目录"
	);
	assert.equal(siteDecisionsFilePath(".obsidian/plugins/acc/"), `.obsidian/plugins/acc/${SITE_DECISIONS_FILE}`, "尾斜杠要归一");
	assert.equal(siteDecisionsFilePath("\\a\\b"), `a/b/${SITE_DECISIONS_FILE}`, "反斜杠要归一成正斜杠");
	assert.equal(siteDecisionsFilePath(""), SITE_DECISIONS_FILE, "空目录 → 只有文件名");
	assert.equal(siteDecisionsFilePath(undefined), SITE_DECISIONS_FILE, "undefined 也不能抛错");

	// ============================================================
	// 2. 文件不存在 → 空记忆，且不是错误
	// ============================================================
	const root = await mkdtemp(join(tmpdir(), "acc-site-"));
	try {
		const harness = createAppMock(root);
		const adapter = harness.app.vault.adapter;
		const dir = ".obsidian/plugins/acc";
		const path = siteDecisionsFilePath(dir);

		const missing = await loadSiteDecisions(adapter, path);
		assert.ok(missing.decisions instanceof SiteDecisions, "应返回一份可用的记忆");
		assert.equal(missing.decisions.size, 0, "文件不存在 → 空记忆");
		assert.equal(missing.existed, false, "要能区分「首次运行」与「文件丢了」");
		assert.equal(missing.error, "", "文件不存在不是错误");

		// ============================================================
		// 3. 往返
		// ============================================================
		const decisions = new SiteDecisions();
		decisions.set("a.example.com", "allow");
		decisions.set("b.example.net", "deny");
		await saveSiteDecisions(adapter, path, decisions);

		const loaded = await loadSiteDecisions(adapter, path);
		assert.equal(loaded.existed, true, "写入后应存在");
		assert.equal(loaded.error, "", "正常读取不该有错误");
		assert.equal(loaded.decisions.size, 2, "两条都要恢复");
		assert.equal(loaded.decisions.get("a.example.com"), "allow", "allow 要恢复");
		assert.equal(loaded.decisions.get("b.example.net"), "deny", "deny 要恢复");

		// 磁盘上确实是一份合法 JSON，且带版本号
		const raw = JSON.parse(await readFile(join(root, path), "utf8"));
		assert.equal(raw.version, mod.SITE_DECISIONS_VERSION, "落盘要带版本号");

		// ============================================================
		// 4. ⭐ 原子写：必须走「临时文件 + 改名」
		// ============================================================
		const recording = makeRecordingAdapter(adapter);
		await saveSiteDecisions(recording, path, decisions);
		const ops = recording.ops;
		assert.ok(
			ops.includes(`write ${path}.tmp`),
			"★ 必须先写临时文件（否则崩溃会留下半截 JSON）"
		);
		assert.ok(
			ops.includes(`rename ${path}.tmp ${path}`),
			"★ 必须靠改名落地（同目录内改名是原子的）"
		);
		assert.ok(
			!ops.includes(`write ${path}`),
			"★ 改动成功时不该直接写目标文件（那就没有原子性了）"
		);
		assert.ok(!ops.includes(`remove ${path}.tmp`), "成功路径不该残留临时文件要清");

		// 临时文件不能留在磁盘上
		assert.equal(await adapter.exists(`${path}.tmp`), false, "★ 临时文件不该残留");

		// ============================================================
		// 5. ⭐ 目录不存在 → 自建（用户手工删过插件目录时要自愈）
		// ============================================================
		const nestedDir = ".obsidian/plugins/fresh";
		const nestedPath = siteDecisionsFilePath(nestedDir);
		let saveError = null;
		try {
			await saveSiteDecisions(adapter, nestedPath, decisions);
		} catch (error) {
			saveError = error;
		}
		assert.equal(saveError, null, "★ 目录不存在时必须先建（自建目录才能在用户删过插件目录后自愈）");
		const afterNested = await loadSiteDecisions(adapter, nestedPath);
		assert.equal(afterNested.decisions.size, 2, "建目录后要能正常往返");

		// ⚠️ 上面这一条**没有牙齿**：替身的 `adapter.write` 会顺手 `mkdir(dirname, {recursive:true})`，
		// 比真实适配器宽容得多 —— 于是"忘了 mkdir"在这条链上永远不暴露。
		// 所以这里再用一个**严格**的假适配器：父目录不存在时 write/rename 直接失败
		// （真实文件系统就是这样），"必须先建目录"这条性质才有意义。
		const strict = makeStrictAdapter();
		let strictError = null;
		try {
			await saveSiteDecisions(strict, siteDecisionsFilePath(".obsidian/plugins/strict"), decisions);
		} catch (error) {
			strictError = error;
		}
		assert.equal(
			strictError,
			null,
			"★ 父目录不存在时必须先建（真实适配器的 write 不会替你建目录，缺了就是写不进去）"
		);

		// ============================================================
		// 6. ⭐ 读坏数据必须降级，绝不抛错
		// ============================================================
		const badDir = ".obsidian/plugins/bad";
		const badPath = siteDecisionsFilePath(badDir);
		await mkdir(join(root, badDir), { recursive: true });

		for (const [label, payload] of [
			["截断的 JSON", '{"version":1,"decisions":[{"host":"a.com","dec'],
			["不是 JSON", "<html>404</html>"],
			["是 JSON 但不是对象", "42"],
			["结构不对", '{"decisions":"nope"}'],
			["空文件", ""],
		]) {
			await writeFile(join(root, badPath), payload, "utf8");
			let result;
			try {
				result = await loadSiteDecisions(adapter, badPath);
			} catch (error) {
				result = error;
			}
			assert.ok(
				result && result.decisions instanceof SiteDecisions,
				`★ 读坏数据必须降级为空记忆并继续（不能让它抛错）——输入：${label}`
			);
			assert.equal(result.decisions.size, 0, `（${label}）应降级为空记忆`);
			assert.equal(result.existed, true, `（${label}）文件其实存在（要与「没写过」区分开）`);
			assert.notEqual(result.error, "", `（${label}）要留下错误原因供排查`);
		}

		// 部分损坏的 JSON：好条目要尽量留下（不能一条坏记录毁掉全部）
		await writeFile(
			join(root, badPath),
			JSON.stringify({ version: 1, decisions: [{ host: "ok.com", decision: "allow" }, null, "junk"] }),
			"utf8"
		);
		const partial = await loadSiteDecisions(adapter, badPath);
		assert.equal(partial.decisions.get("ok.com"), "allow", "坏条目跳过，好条目必须留下");
		assert.equal(partial.decisions.size, 1, "只有一条可用");

		// ============================================================
		// 7. adapter.read 抛错（权限/被占用）→ 同样降级
		// ============================================================
		const throwing = {
			exists: async () => true,
			read: async () => {
				throw new Error("EBUSY: 文件被占用");
			},
		};
		let readFailure;
		try {
			readFailure = await loadSiteDecisions(throwing, path);
		} catch (error) {
			readFailure = error;
		}
		assert.ok(
			readFailure && readFailure.decisions instanceof SiteDecisions,
			"★ 读失败（权限/占用）也要降级，不能让插件起不来"
		);
		assert.equal(readFailure.decisions.size, 0, "读失败 → 空记忆");
		assert.notEqual(readFailure.error, "", "要留下原因");

		// ============================================================
		// 8. createSiteStore：路径兜底与读写
		// ============================================================
		const storeDir = ".obsidian/plugins/store-test";
		const store = createSiteStore(harness.app, storeDir, "acc");
		const storeLoad = await store.load();
		assert.equal(storeLoad.existed, false, "首次加载应报「文件不存在」");
		assert.equal(store.decisions.size, 0, "首次加载为空");

		store.decisions.set("x.example.com", "allow");
		await store.save();
		assert.equal(await adapter.exists(join(storeDir, SITE_DECISIONS_FILE)), true, "store 应落到推导出的路径");

		const store2 = createSiteStore(harness.app, storeDir, "acc");
		await store2.load();
		assert.equal(store2.decisions.get("x.example.com"), "allow", "另一个 store 实例要能读回");

		// pluginDir 缺失 → 用 id 兜底（写错位置只影响记忆，比插件起不来轻）
		const fallback = createSiteStore(harness.app, undefined, "my-plugin");
		fallback.decisions.set("y.example.com", "deny");
		await fallback.save();
		assert.equal(
			await adapter.exists(`.obsidian/plugins/my-plugin/${SITE_DECISIONS_FILE}`),
			true,
			"★ planDir 缺失时要按 id 兜底定位（而不是抛错）"
		);
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
	}
}
