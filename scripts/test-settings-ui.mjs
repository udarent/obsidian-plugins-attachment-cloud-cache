import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { withLoadedTs } from "./lib/load-ts.mjs";
import { runSettingsUiSuite } from "./lib/settings-ui-suite.mjs";

/**
 * 设置界面支撑模块的测试。
 *
 * 三个模块一起打进**同一个** bundle：`settings-bindings` 会调用
 * `settings-logic` 的扩展名转换函数，分两次 build 会让两边的实现不是同一份。
 *
 * 这些模块都**不碰 DOM**，所以能穷举 —— 这是刻意的：设置界面里最难查的问题
 * 恰恰是"改了没生效"（绑定错）与"选项没作用"（假选项）这两类静默失效。
 *
 * 断言在 `lib/settings-ui-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs(["src/ui/settings-logic", "src/ui/settings-bindings", "src/s3/credentials"], async (mod) => {
	runSettingsUiSuite(mod);
	console.log(
		"Settings-UI tests passed (extension lists parse from commas/spaces/ideographic commas/newlines " +
			"and round-trip, conditional visibility hides the cache folder unless the copy is cached, " +
			"dropdown options are generated from the type list so no fake option can appear, " +
			"bindings read/write dotted keys without inventing intermediate objects, " +
			"empty values are refused only where empty would silently break a feature, " +
			"the keychain slot for the secret is generated once and never renamed, " +
			"credentials distinguish 'never chosen' from 'the chosen secret no longer exists', " +
			"and an imported credentials file maps onto the right fields while the secret alone " +
			"travels to the keychain (never into the settings patch')."
	);
});

// ============================================================
// 静态守卫：一对凭据必须**在同一处编辑**
// ============================================================
//
// 这条守的是一个**设计事实**，行为断言看不见它：
// 访问密钥 ID 与秘密访问密钥是**成对签发、成对轮换**的（MinIO/AWS 都如此），
// 所以两者必须都在这两个相邻的输入框里改。
//
// 早期版本把秘密交给 `SecretComponent`（"从钥匙串里选择/新建一条**具名**密钥"），
// 于是这一对凭据被拆到了两个地方：ID 在文本框里，秘密却要先给钥匙串条目**起个名字**。
// 用户报的正是这件事（"没有一起修改是不对的"）——
// 而把 `SecretComponent` 加回来**不会有任何行为断言变红**，所以在这里钉住。
//
// ⚠️ 秘密**仍然不进设置**（它写穿到钥匙串）：那条不变量由 `test-settings.mjs` 把着。
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function read(relativePath) {
	return readFileSync(join(ROOT, relativePath), "utf8");
}

const tab = read("src/ui/settings-tab.ts");

// ⚠️ 只匹配**真的构造**（`new SecretComponent(`），不匹配裸标识符 ——
// 否则注释里"为什么不用 SecretComponent"这种说明会被当成违规。
// （同一个坑在 `test-remove.mjs` 的 `adapter.remove` 守卫上已经踩过一次：
//   **静态守卫要匹配调用，不要匹配字面量**。）
assert.ok(
	!tab.includes("new SecretComponent("),
	"★ settings-tab 不该再构造 SecretComponent —— 那会把成对的凭据拆成「两处才能改」"
);
assert.ok(
	tab.includes("addText"),
	"★ 秘密访问密钥要用普通输入框（与访问密钥 ID 并列），而不是密钥选择器"
);

// 两个框必须**相邻**：中间插进别的项，用户就得在两个地方来回找。
// 判据是"设置项定义里 secretKey 紧跟 accessKey"，不看文案（文案会随语言变）。
{
	const order = [...tab.matchAll(/s3AccessKey"\)|s3SecretKey"\)/g)].map((m) => m[0]);
	assert.deepEqual(
		order.slice(0, 2),
		['s3AccessKey")', 's3SecretKey")'],
		"★ 访问密钥 ID 与秘密访问密钥必须是**相邻的两项**（成对编辑的前提）"
	);
}

// 新增的两条文案必须在 i18n 里真的存在 —— 否则界面上会直接显示键名本身。
{
	const i18n = read("src/i18n.ts");
	for (const key of ["s3SecretKeyPlaceholder", "s3SecretStoreFailed"]) {
		const occurrences = i18n.split(`\t\t${key}:`).length - 1;
		assert.equal(occurrences, 2, `★ 文案 ${key} 必须在两种语言里都存在（实际出现 ${occurrences} 次）`);
	}
}

// ============================================================
// 静态守卫：「测试连接」必须**两步都做**
// ============================================================
//
// 守的是一个**设计事实**，行为断言看不见它：只验「我这边连得上」会漏掉
// 「**别人**打不开我笔记里的链接」—— 而后者能长期不被察觉（本项目真出过：
// 公开前缀根本没生效、链接一直退回对象地址，而"测试连接"一路全绿）。
//
// 两条判据，各自对应一种写法上的退化：
// 1. 必须真的发起匿名探测（删掉它，测试就退化成只验桶）；
// 2. 探的必须是**真的要写进笔记的那个地址**（用 `publicUrlFor` 推导），
//    不能另拼一个 —— 一分开算，检查就会开始骗人。
assert.ok(
	tab.includes("probePublicLink("),
	"★ 「测试连接」要真的匿名探测一次公开地址 —— 否则「别人能不能打开我的链接」没有任何检查"
);
assert.ok(
	tab.includes("publicUrlFor(config, key)"),
	"★ 探的必须是**真要写进笔记**的那个地址（同一个 publicUrlFor），不能自己另拼一个"
);

// ============================================================
// 静态守卫：导入凭据文件时，秘密**只**进钥匙串
// ============================================================
//
// 守的是一处**安全边界**：一份外来的凭据文件里有三样东西，而它们的**去向不同** ——
// 服务地址与访问密钥 ID 进设置（`data.json`：明文，会随 vault 同步/备份/分享），
// 秘密访问密钥必须进钥匙串。
//
// 两种退化在 review 里都看不出异常：
// ① 界面自己实现一份导入 ⇒ 秘密的去向变成"界面里怎么写"，插件上那份成了摆设；
// ② 读完不清空 file input ⇒ 那份**明文秘密**一直挂在 DOM 上。
//
// （"秘密没被塞进设置"这条另有行为断言钉着 —— 见套件第 11 节。这里守的是
//  「只有一处实现」与「用完就清」这两件行为断言看不见的事。）
{
	const main = read("src/main.ts");

	assert.ok(
		tab.includes("plugin.importCredentialsFile("),
		"★ 界面必须走插件那一个导入实现 —— 另写一份就等于秘密的去向由界面决定"
	);
	assert.ok(
		tab.includes('input.value = ""'),
		"★ 读完必须清空那个 file input —— 它里面是明文秘密，没有理由留在 DOM 上"
	);
	// 导入是**绕过控件**直接写设置的，宿主不会自己重渲染 ⇒ 不刷新的话那几栏
	// 会继续显示导入前的内容（"通知说成功、框里还是空的"）。这条没有行为断言能看见。
	assert.ok(
		tab.includes("this.update()"),
		"★ 导入成功后必须让设置页重新取值（update()）—— 否则端口/密钥那几栏还显示旧值"
	);
	assert.ok(
		main.includes("secretStorage.setSecret(slot, parsed.secret)"),
		"★ 导入时秘密必须写进钥匙串"
	);
	assert.ok(
		!/settings\.s3\.[A-Za-z]*\s*=\s*parsed\.secret/.test(main),
		"★★ 秘密绝不能被写进 settings —— data.json 是明文，且会随 vault 同步、备份、分享"
	);
}
