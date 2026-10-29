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
		"Settings-UI tests passed (the only value conversion left is the numeric cache limit, which round-trips both ways, " +
			"conditional visibility follows whether *this* mode can produce a copy at all (the limit is shown exactly when it can act - that is how P7 was closed), " +
			"dropdown options are generated from the type list so no fake option can appear, " +
			"bindings read/write dotted keys without inventing intermediate objects, " +
			"empty values are refused only where empty would silently break a feature, " +
			"the keychain slot for the secret is generated once and never renamed, " +
			"credentials distinguish 'never chosen' from 'the chosen secret no longer exists', " +
			"an imported credentials file maps onto the right fields while the secret alone " +
			"travels to the keychain (never into the settings patch), " +
			"and the page order follows the business chain (group order, the two opposite actions sitting side by side at the end of the upload group, " +
			"a parameter-only offline group, and the derived address after the switch that shapes it')."
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

// ============================================================
// 静态守卫：删除留痕必须有**用户可见的入口**（U8）
// ============================================================
//
// 留痕的价值全在"事后能查"，而文件在插件目录、**以点开头**（不进宿主索引）——
// 用户没有别的办法打开它。这条没有行为断言能守（要驱动设置页点击 + 真磁盘），
// 所以钉住三件事：入口在、路径从同一处算、读的是 adapter 而不是 openLinkText。
// ⚠️ 2026-10-24：这一项搬到了「记录与排障」组（与「调试日志」同组：都是"事后能查的东西"）。
assert.match(tab, /this\.t\("deleteLogName"\)/, "「记录与排障」组必须有「删除记录」入口");
assert.match(tab, /deleteLogTargetPath\(/, "留痕路径必须由 deleteLogTargetPath 算（不要自己拼）");
assert.match(tab, /adapter\.read\(/, "留痕是点开头文件（不进索引）⇒ 必须直接读，不能靠 openLinkText");

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
// ⚠️ 1.7.0：这两条守的**事实**没变，但实现搬了家（探测收进 `link-access.ts`，
// 由插件的 `refreshAccessProbe` 统一发起 —— 界面上显示的那一份必须与渲染判定用的
// 是**同一份**结果，否则会出现"测试说公开、图却按私有取"）。所以守卫跟着通路走：
// 「界面 → 那唯一一条探测路径」与「探测地址由 publicUrlFor 推导」。
//
// ⚠️ D-53：按钮那条路现在走 `runConnectionProbe()`（回路 = 写 → 读 → 删 + 匿名问），
// 它把**这一轮**的 `{probe, sample, url}` 交回来。界面必须用返回值，**不许**回头读
// 全局字段（`currentAccessProbe*`）：连点 / 与自动探测并发时，全局那一格可能已被另一轮
// 覆盖，界面就会把另一轮的对象名、字节数、删除状态当成自己的结果显示（而数字都在
// 合理范围内，看不出来）。这两条都守。
assert.ok(
	tab.includes("this.plugin.runConnectionProbe("),
	"★ 「测试连接」必须真的探一次（走插件那唯一一条探测路径）—— 否则「别人能不能打开我的链接」没有任何检查"
);
assert.ok(
	!/currentAccessProbe(?:Sample|Url)\(/.test(tab),
	"★ 界面必须用**这一轮**的返回值，不许回头读全局探测结论（并发时会显示另一轮的结果）"
);

// ============================================================
// 静态守卫：按钮回路不许借用**自动探测**的缓存语义
// ============================================================
//
// `recordAccessProbe` 是为自动探测写的：它带一道「地址变了这次结论就作废」的闸门，
// 并且与自动探测**共用** `lastProbe`。用户手点的这一下如果复用它，就会拿到**另一轮**
// （甚至很久以前）的结论 —— 症状是同一次测试里「链接公开可用」＋「私有访问」并存，
// 两次点击之间来回摆（2026-10-18 用户报的「公开访问和私有访问交替出现」）。
//
// 判据只数**调用点**：自动探测那一处必须留着，按钮那处必须自己发。
{
	const main = read("src/main.ts");
	const calls = [...main.matchAll(/this\.recordAccessProbe\(/g)].length;
	assert.equal(
		calls,
		1,
		"★ 只有自动探测能走 recordAccessProbe —— 按钮回路必须自己发一次（复用它会把另一轮的结论带进来）"
	);

	// 同一轮必须**问两次**：真机实测过「同一时刻一次读得到、一次读不到」，
	// 一次成功不足以证明「别人打得开」—— 那正是用户 2026-10-18 报的「公开 / 私有交替」。
	const anonCalls = [...main.matchAll(/probePublicContent\(url, body\.length\)/g)].length;
	assert.equal(anonCalls, 2, "★ 匿名检查必须问两次并比对结论（一次成功只是偶然）");
}

// ============================================================
// 静态守卫：设置项描述是**纯文本** —— 里面不许写 markdown
// ============================================================
//
// `Setting.desc` 是渲成文本的：`**粗体**` 不会变粗，只会**原样显示两个星号**。
// 这个坑踩过两次（连接状态描述里的 `**事实**`、本地副本描述里的 `**本身就是**`），
// 两次都是从开发文档搬文案过来时混进去的 —— 文档里该加粗，界面上不该。
{
	const i18n = read("src/i18n.ts");
	const withMarkdown = [...i18n.matchAll(/(\w+Desc):\s*\n?\s*"((?:[^"\\]|\\.)*)"/g)]
		.filter((m) => m[2].includes("**"))
		.map((m) => m[1]);
	assert.deepEqual(withMarkdown, [], "★ 设置项描述是纯文本：`**` 会原样显示成星号，别在 Desc 里写 markdown");
}

// ============================================================
// 静态守卫：状态**与按钮在同一项里**，而且带一盏指示灯
// ============================================================
//
// 2026-10-18（用户要求「连接状态增加一个指示灯，合并到测试连接功能中」）：
// 原来「连接状态」是独立的一项，用户得在两项之间来回对照，还会以为它们不相干。
// 现在一项里就是「灯 + 一句话 + 按钮 + 逐行证据」。
//
// 三条判据，各自对应一种退化：
// 1. 那个独立项不许回来 —— 键名一旦重新出现在设置项定义里，就是又拆成两项了；
// 2. 必须真的画一个灯（只有一行字的话，扫一眼看不出通不通）；
// 3. 灯的颜色必须与文字**同源**（跟着 `acc-test-${tone}` 走）。⚠️ 各配一次色，
//    迟早一红一绿，而**灯说谎比没有灯更糟** —— 用户看一眼颜色就不再读字了。
assert.ok(
	!tab.includes("connectionStatusName"),
	"★ 状态不许再单独占一项 —— 它已经合并进「测试连接」（灯 + 说明 + 按钮）"
);
assert.ok(
	tab.includes("acc-status-dot"),
	"★ 状态要带指示灯（`acc-status-dot`）—— 只有一行字的话，扫一眼看不出通不通"
);
assert.ok(
	tab.includes("acc-status-head acc-test-${connectionStateTone(state)}"),
	"★ 指示灯的颜色必须与文字同源（跟着 `acc-test-${tone}` 走），不许各配一次"
);
{
	const linkAccess = read("src/link-access.ts");
	assert.ok(
		linkAccess.includes("return publicUrlFor(address, cleanKey);"),
		"★ 探的必须是**真要写进笔记**的那个地址（同一个 publicUrlFor），不能自己另拼一个"
	);
	assert.ok(
		linkAccess.includes("probePublicLink"),
		"★ 探测必须走**不带签名**的那条实现 —— 带凭据去请求等于拿「我自己能打开」冒充「别人能打开」"
	);
}

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
	// ⚠️ 实现在 2026-10-13 的 A1 重构里从 `main.ts` 搬到了 `plugin/credentials-flow.ts`。
	// 守卫跟着实现走 —— 它守的是**那条通路**（秘密只进钥匙串），不是某一个文件。
	const credFlow = read("src/plugin/credentials-flow.ts");

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
		credFlow.includes("secretStorage.setSecret(slot, parsed.secret)"),
		"★ 导入时秘密必须写进钥匙串"
	);
	assert.ok(
		!/settings\.s3\.[A-Za-z]*\s*=\s*parsed\.secret/.test(credFlow),
		"★★ 秘密绝不能被写进 settings —— data.json 是明文，且会随 vault 同步、备份、分享"
	);
}

// ============================================================
// 静态守卫：凭据导入那一行**结构上只有一个控件**，而且那个控件**在文档里**
// ============================================================
//
// 用户先后报过两件事，它们其实是同一个问题的两面：
//
//  ① 「凭据选择按钮有两个，多出来了一个」—— `<input type="file">` **自己会渲染**
//     （"选择文件 / 未选择任何文件"），跟我们的按钮并排站着；
//  ② 「点击选择文件按钮没有响应」—— 第二版为了消掉那个多出来的控件，把它做成了
//     **游离节点**（`document.createElement`、从不 append）。⚠️⚠️ 但 Chromium 只对
//     **在文档里的**文件控件打开选择器：真机上点击到达了按钮、`input.click()` 也调了，
//     `Page.fileChooserOpened` 却一次都不来。⇒「不在文档里」正是它失灵的原因，不是解法。
//
// 现在的结构：控件区里只有一个包裹层，里面是「皮肤按钮 + 铺满它的 file input」。
// 控件只有一个（由结构决定），input 在文档里（所以真的能开），而且**没有**
// `input.click()` 这条中继（点击直接落在 input 上）。
//
// ⚠️ 这两条都没有行为断言能看见：两个控件**都能用**；游离的 input 也照样能被
// `DOM.setFileInputFiles` 喂进文件（于是"导入成功"的断言全是绿的）—— 只有真机上
// 真的去点，才看得出区别。判据只能落在源码与样式表上。
//
// ⚠️ 判据要落在**代码**上：这段实现里的注释正好在解释「不能用全局 document」、
// 「不能游离」，直接对整段文本做 includes 会被自己的注释判红（本项目踩过两次 ⇒ 先剥注释）。
{
	const start = tab.indexOf("private renderCredentialImport(");
	const end = start >= 0 ? tab.indexOf("\n\t}", start) : -1;
	const body = end > start ? tab.slice(start, end) : "";
	assert.ok(body.length > 0, "★ 找不到 renderCredentialImport 的实现（守卫自己失效了，别让它静默通过）");

	const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	const css = read("styles.css");

	assert.ok(
		code.includes('wrap.createEl("input"'),
		"★★ input 要用**这一行自己的元素**建（`wrap.createEl`）—— 它同时保证：建在这个窗口里 + 挂进文档里"
	);
	assert.ok(
		!/ownerDocument\.createEl/.test(code),
		"★★ 不能写成 `ownerDocument.createEl` —— 宿主的 createEl 会**把元素挂到接收者里**，" +
			"在文档上调用 ⇒ `HierarchyRequestError: Only one element on document allowed`（真机实测：设置页那行直接渲染失败）"
	);
	assert.ok(
		!/(^|[^A-Za-z.])document\.createElement\(/.test(code),
		"★★ 不能用全局 document 造 —— 那样它属于主窗文档，而按钮在设置窗口里"
	);
	assert.ok(
		!code.includes("input.click()"),
		"★ 不该再有 input.click() 中继 —— 点击直接落在 input 上，少一条会静默失效的路"
	);
	assert.ok(
		!code.includes("controlEl.createEl"),
		"★ 别把 input 直接建在控件区（那正是「并排两个控件」的成因）—— 控件区只放一个包裹层"
	);
	assert.equal(
		(code.match(/controlEl\.createDiv\(/g) ?? []).length,
		1,
		"★ 控件区里只该有**一个**子元素（我们那个包裹层）"
	);
	assert.equal(
		(code.match(/new ButtonComponent\(/g) ?? []).length,
		1,
		"★ 皮肤按钮恰好一个"
	);
	assert.ok(
		code.includes("aria-hidden") && code.includes("tabIndex"),
		"★ 皮肤按钮要退出交互（aria-hidden + tabindex=-1）—— 读屏与键盘只该看到一个控件"
	);
	assert.ok(
		code.includes("acc-credentials-file-input"),
		"★ input 要留类名钩子 —— 真机探针靠它找到那个控件"
	);
	assert.ok(
		css.includes(".acc-credentials-import .acc-credentials-file-input"),
		"★ 样式表要给出包裹层与 input 的配合（input 铺满按钮、当命中面）"
	);
}

// ============================================================
// 静态守卫：页面的**顺序**就是业务链的顺序（2026-10-24 整理）
// ============================================================
//
// 顺序坏了**不会报错**，界面上也看不出"错" —— 只是读起来别扭，而且没有一条行为断言
// 能看见它（渲染出来的项一个不少、一个不差）。所以只能按结构钉住：
//
// | 组 / 位置 | 判据 | 坏了会怎样 |
// |---|---|---|
// | 组顺序 | 连接 → 上传 → 副本 → 排障（2026-10-25 起「云端清理」组已删）| 用户在"还没有连接"的一页里读到上传策略 |
// | 「存储连接」组尾 | 必须是「测试连接」 | 校验项夹在中间，用户填一半就去点 |
// | 「兼容模式」在「公开链接地址」之前 | 后者留空时的提示地址由前者推导（`objectBaseFor` 读 `forcePathStyle`）| 先看到推导结果、后看到决定它形状的开关 |
// | 两颗反向按钮**相邻收「上传」组尾** | 上传全部 → 改回本地（最后两项） | 两个方向的批量迁移被拆到两个组里，各自读成孤立的一条命令（2026-10-24 用户定的口径）|
// | 「离线与本地副本」组**没有动作** | 末项必须是只读的「占用空间」 | 参数串里又冒出一颗按钮，把同一串策略问题切成两段 |
// | 站外的两个子项不插在两个兄弟开关**之间** | `externalSiteMode` 夹在 `externalImageCache` 与 `uploadLocalFiles` 之间 | 「同时上传本机文件」被读成站外那一组的第三个子项 |
//
// ⚠️ 判据只取**设置项的键名**（`name: this.t("…")`），不看文案 —— 文案两种语言各一份。
{
	/** 取一个类方法的源码（从声明到它自己的收尾大括号）。 */
	const methodBody = (name) => {
		const start = tab.indexOf(`private ${name}(`);
		const end = start >= 0 ? tab.indexOf("\n\t}", start) : -1;
		return start >= 0 && end > start ? tab.slice(start, end) : "";
	};
	/** 方法体里设置项出现的**顺序**（只认 `name: this.t("键")`）。 */
	const itemNames = (body) => [...body.matchAll(/name: this\.t\("(\w+)"\)/g)].map((match) => match[1]);

	for (const name of ["storageItems", "uploadItems", "offlineItems", "diagnosticsItems"]) {
		assert.ok(methodBody(name).length > 0, `★ 找不到 ${name} 的实现（守卫自己失效了，别让它静默通过）`);
	}

	const groups = [...tab.matchAll(/type: "group", heading: this\.t\("(section\w+)"\)/g)].map((match) => match[1]);
	assert.deepEqual(
		groups,
		["sectionStorage", "sectionUpload", "sectionOffline", "sectionDiagnostics"],
		"★ 组的顺序 = 业务链的顺序（连上 → 传上来 → 本地那份怎么管 → 出事看哪儿）；" +
			"确实要改就先想清楚它插在哪一步之后，再改这一行"
	);

	const storage = itemNames(methodBody("storageItems"));
	const upload = itemNames(methodBody("uploadItems"));
	const offline = itemNames(methodBody("offlineItems"));

	assert.deepEqual(
		storage.slice(-2),
		["testConnection", "unifyNamesName"],
		"★ 「存储连接」组的两个动作：先「测试连接」（验证连得上）、再「统一对象名」（确认能连才动桶里的东西）。" +
			"顺序反过来就是「先动刀、再确认刀快不快」；参数一律排在它们之前（D-89 判据③：动作只在组尾）"
	);
	// ⚠️ 2026-10-29：「内容寻址 key」那个决策项已删（key 形状固定纯哈希，不再是可配项）。
	// 保留一条**否定式**守卫：它不许以任何名字回来 —— 一个"机制"重新变成用户设置项，
	// 就意味着又要把 `ListBucket` 权限、显示名来源这些代价重新解释给用户。
	assert.ok(
		!storage.includes("contentAddressed"),
		"★ 「内容寻址 key」已删除，不得以设置项形式回归（形状是固定的）"
	);

	assert.ok(
		storage.indexOf("forcePathStyle") < storage.indexOf("s3PublicUrlBase"),
		"★ 「兼容模式」必须排在「公开链接地址」之前 —— 后者的留空提示（`objectBaseFor`）读的就是它"
	);
	assert.deepEqual(
		upload.slice(-2),
		["uploadAllName", "revertName"],
		"★ 两颗互为反向的按钮必须**相邻**、并在「上传」组尾（上传全部 → 改回本地）；" +
			"拆到两个组里，用户就看不出这是同一件事的两个方向"
	);
	assert.equal(
		offline.at(-1),
		"localUsageName",
		"★ 「离线与本地副本」组只放参数（末项是只读的「占用空间」）—— " +
			"动作项一律去「上传」组尾，别再让一颗按钮把这一串策略问题切成两段"
	);
	assert.ok(
		upload.indexOf("externalSiteMode") > upload.indexOf("externalImageCache") &&
			upload.indexOf("externalSiteList") > upload.indexOf("externalSiteMode") &&
			upload.indexOf("uploadLocalFiles") > upload.indexOf("externalSiteList"),
		"★ 站外的两个子项要**紧跟**它们所属的开关、且在「同时上传本机文件」之前 —— " +
			"插在兄弟开关中间会让后者看起来像站外的第三个子项"
	);
}

