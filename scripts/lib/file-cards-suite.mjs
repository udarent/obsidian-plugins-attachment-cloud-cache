import assert from "node:assert/strict";

/**
 * 确认框里那张「文件清单」的断言（`src/ui/file-cards.ts`）。
 *
 * ## 为什么值得有套件
 *
 * 判定的产物决定用户在**不可恢复**的按钮前看到什么：一串 sha256 还是"能认出来的图 + 名字"。
 * 而这一层原先根本没有 —— 两处确认框直接 `map(key)` 就把 key 当清单列出来了。
 *
 * ## ⚠️ 结构：**一节一件事**
 *
 * 套件是"第一条失败断言决定报错"，而变异脚本要求每条变异因**自己的原因**失败。
 * 所以每一节只依赖一条规则（见下面的编号），互不掩盖。
 *
 * 渲染那一节用一个**记账替身**（结构化，不需要宿主 DOM）—— 它顺便钉住一件很要紧的事：
 * `src` 必须走 `attr`（= `setAttribute`），**不许**赋 `img.src` ——
 * 渲染钩子改写了 `HTMLImageElement.prototype.src` 的 setter，而那一层在"缺本地副本"时会
 * **去下载那个对象**：这个对话框问的正是"要不要删掉它"。
 */
export function runFileCardsSuite(mod) {
	const { planFileCards, renderFileCards, externalRowMeta } = mod;
	assert.ok(typeof planFileCards === "function", "应当导出清单判定");
	assert.ok(typeof renderFileCards === "function", "应当导出清单渲染");
	assert.ok(typeof externalRowMeta === "function", "应当导出站外/本机行的副标题拼法");

	/** 替身：`missing/` 开头的路径"本地拿不到"，`nourl.png` 推不出远端地址。 */
	const deps = {
		resourceUrl: (path) => (path.startsWith("missing/") ? null : `app://vault/${path}`),
		remoteUrl: (key) => (key === "nourl.png" ? null : `https://cdn.example.com/${key}`),
	};

	// ============================================================
	// ① 名字：有原始文件名就用它；没有才退化成 id
	// ============================================================
	{
		const cards = planFileCards(
			[
				{ id: "a1b2.png", name: "报告截图.png" },
				{ id: "a1b2.png" },
			],
			deps
		);
		assert.equal(cards[0].label, "报告截图.png", "★ 有原始文件名就该显示它");
		assert.equal(cards[1].label, "a1b2.png", "没有名字时退化成 id（那是唯一还能说的事实）");
	}

	// ============================================================
	// ② ⭐ 本地副本**优先**：有副本时缩略图不联网
	// ============================================================
	{
		const [card] = planFileCards(
			[{ id: "a1b2.png", localPath: "attachments-cache/a1b2.png", remoteKey: "a1b2.png" }],
			deps
		);
		assert.deepEqual(card.thumbUrls, ["app://vault/attachments-cache/a1b2.png"], "★ 本地副本优先（零网络）");
		assert.equal(card.fromLocalCopy, true, "要说清这张图是不是来自本地副本");
	}

	// ============================================================
	// ③ 本地拿不到（文件已被删 / 不在宿主索引里）才退到远端地址
	// ============================================================
	{
		const [card] = planFileCards(
			[{ id: "a1b2.png", localPath: "missing/a1b2.png", remoteKey: "a1b2.png" }],
			deps
		);
		assert.deepEqual(card.thumbUrls, ["https://cdn.example.com/a1b2.png"], "本地拿不到时退到远端地址");
		assert.equal(card.fromLocalCopy, false, "远端地址不是本地副本");
	}

	// ============================================================
	// ④ ⭐ 缩略图**只给图片**：别的类型给标记，不给破图
	// ============================================================
	{
		const [pdf, zip] = planFileCards(
			[
				{ id: "b7c8.pdf", localPath: "attachments-cache/b7c8.pdf", remoteKey: "b7c8.pdf" },
				{ id: "c9d0.zip", localPath: "attachments-cache/c9d0.zip" },
			],
			deps
		);
		assert.deepEqual(pdf.thumbUrls, [], "★ PDF 塞进 img 只会得到破图 ⇒ 不给缩略图");
		assert.equal(pdf.badge, "PDF", "要给类型标记，让用户知道它是什么");
		assert.deepEqual(zip.thumbUrls, [], "未知类型同理");
		assert.equal(zip.badge, "ZIP", "扩展名认不出来时也要如实显示它");
	}

	// ============================================================
	// ⑤ 两个来源都拿不到 ⇒ **不给图**（不是给一个空地址或半截地址）
	// ============================================================
	{
		const [noRemote, noLocal, unconfigured] = planFileCards(
			[
				{ id: "nourl.png", remoteKey: "nourl.png" },
				{ id: "d1e2.png", localPath: "missing/d1e2.png" },
				{ id: "f3a4.png" },
			],
			deps
		);
		assert.deepEqual(noRemote.thumbUrls, [], "★ 推不出远端地址 ⇒ 空，不给空串或空地址");
		assert.deepEqual(noLocal.thumbUrls, [], "本地拿不到、又没有 key ⇒ 空");
		assert.deepEqual(unconfigured.thumbUrls, [], "什么都没给 ⇒ 空（不抛错）");
	}

	// ============================================================
	// ⑤b ⭐ 调用方**直接给的地址**（站外图 / 本机 `file://…`）优先，且同样只对图片生效
	//
	// 这两类的图既不在库内、也不是本存储的对象 ⇒ 上面那两条推导（本地副本 / 远端 key）
	// 对它们无从下手，只能由调用方把地址递进来。
	// ⚠️ 「只给图片」那条纪律对它们**一样**成立：给 PDF 一个地址只会得到破图。
	// ============================================================
	{
		const [image, pdf, both] = planFileCards(
			[
				{ id: "https://example.com/a.png", name: "a.png", thumb: "https://example.com/a.png" },
				{ id: "https://example.com/b.pdf", name: "b.pdf", thumb: "https://example.com/b.pdf" },
				// 三个都给：显式地址排最前（顺序写在 `planFileCards` 上，别处不许另有口径）
				{
					id: "d5e6.png",
					name: "d.png",
					thumb: "app://elsewhere/d.png",
					localPath: "attachments-cache/d5e6.png",
					remoteKey: "d5e6.png",
				},
			],
			deps
		);
		assert.deepEqual(image.thumbUrls, ["https://example.com/a.png"], "★ 调用方给的地址优先（否则站外/本机那些行永远没有图）");
		assert.equal(image.fromLocalCopy, false, "它不来自本地副本 —— 别把站外/本机图说成零网络");
		assert.deepEqual(pdf.thumbUrls, [], "非图片给地址也只显示类型标记");
		assert.deepEqual(
			both.thumbUrls,
			["app://elsewhere/d.png"],
			"★ 显式地址优先于本地副本与远端 key（三样都给时按这个顺序）"
		);
		assert.equal(both.fromLocalCopy, false, "显式地址那一档不算本地副本");
	}

	// ============================================================
	// ⑥ 脏输入：空项 / 空白 id 跳过，缺字段不抛错
	// ============================================================
	{
		const cards = planFileCards([null, undefined, { id: "   " }, { id: " e5f6.png " }], deps);
		assert.equal(cards.length, 1, "空项与空白 id 都要跳过（它们画不出一行有意义的东西）");
		assert.equal(cards[0].id, "e5f6.png", "id 要 trim（它还要用来回查要删什么）");
		assert.deepEqual(planFileCards([], deps), [], "空清单不产出");
	}

	// ============================================================
	// ⑦ 渲染：`src` 走 `attr`（setAttribute），且加载失败要降级成标记
	// ============================================================
	{
		const calls = [];
		/** 记账替身：只记录"被怎么用"，不需要真 DOM。 */
		const makeEl = (tag) => {
			const el = {
				tag,
				attrs: {},
				classes: [],
				text: "",
				children: [],
				createDiv: (options = {}) => {
					const child = makeEl("div");
					child.cls = options.cls;
					child.text = options.text ?? "";
					el.children.push(child);
					return child;
				},
				createSpan: (options = {}) => {
					const child = makeEl("span");
					child.cls = options.cls;
					child.text = options.text ?? "";
					el.children.push(child);
					return child;
				},
				createEl: (childTag, options = {}) => {
					const child = makeEl(childTag);
					child.cls = options.cls;
					child.text = options.text ?? "";
					child.attrs = options.attr ?? {};
					calls.push({ tag: childTag, attr: options.attr ?? {} });
					el.children.push(child);
					return child;
				},
				// ⚠️ 真实 DOM 元素一定有它，而"候选链"那一步走的正是 `setAttribute`
				//（**不能**走 `img.src = …`：渲染钩子改写了那个 setter）⇒ 替身也得有，
				// 否则"接着试下一条候选"在套件里根本走不到。
				setAttribute: (name, value) => {
					el.attrs[name] = value;
				},
				addClass: (cls) => el.classes.push(cls),
				setText: (text) => {
					el.text = text;
				},
				remove: () => {
					el.removed = true;
				},
			};
			return el;
		};

		const root = makeEl("root");
		renderFileCards(root, [
			{ id: "a1b2.png", label: "报告.png", badge: "PNG", thumbUrls: ["https://cdn.example.com/a1b2.png"] },
		]);

		const row = root.children[0];
		assert.ok(row, "每一行都要有个容器（否则两行会并在一起）");
		const img = row.children[0].children[0];
		assert.equal(img.tag, "img", "图片行要真的渲染一个 img");
		// ⭐ 最要紧的一条：地址走 **attr**（setAttribute），不走被渲染钩子改写的 `img.src`
		assert.equal(
			calls[0]?.attr?.src,
			"https://cdn.example.com/a1b2.png",
			"★ 缩略图地址必须通过 attr 写（走 img.src 会被渲染钩子接走 → 缺副本时触发下载）"
		);
		assert.equal(img.src, undefined, "不许直接给元素赋 src 属性");
		// ⚠️⚠️ 缩略图**不许**带原生懒加载（理由见 `renderThumb` 的注释，2026-10-15 真机踩过）：
		// 宿主的弹窗容器带 transform/opacity 动画，`loading="lazy"` 在那种容器里可能
		// **永远不加载**；而它不加载时**连 `onerror` 都不触发** ⇒ 连"降级成类型标记"
		// 那条兜底也走不到，用户看到的就是一块空白、也没有任何报错可查。
		assert.ok(
			!("loading" in (calls[0]?.attr ?? {})),
			"★ 缩略图不许带 loading 属性（原生懒加载在宿主弹窗里可能永远不加载，且不报错）"
		);
		assert.equal(row.children[1].text, "报告.png", "名字要显示出来（那是核对的主要依据）");

		// 一条候选都没有（或全试完了）⇒ 降级成类型标记，不留破图
		row.children[0].children[0].onerror?.();
		assert.ok(row.children[0].classes.includes("acc-file-badge"), "★ 图加载不出来要降级成标记");
		assert.equal(row.children[0].text, "PNG", "降级后显示类型标记");

		// ⭐⭐ 候选是**一串**：第一条画不出来要**接着试**第二条，全试完才降级（D-45）。
		// 站外 `http(s)` 只有一条；库外本机文件有两条（宿主前缀 + 原文）——
		// 而"宿主认哪一种"由**运行时**说了算 ⇒ 不接着试就等于把决定权又抢回我们手里。
		const rootChain = makeEl("root");
		renderFileCards(rootChain, [
			{
				id: "g7h8.png",
				label: "截图.png",
				badge: "PNG",
				thumbUrls: ["app://local/D:/截图.png", "file:///D:/截图.png"],
			},
		]);
		const chained = rootChain.children[0].children[0];
		assert.equal(chained.children[0].attrs.src, "app://local/D:/截图.png", "★ 先试第一条候选");
		chained.children[0].onerror?.();
		assert.equal(
			chained.children[0].attrs.src,
			"file:///D:/截图.png",
			"★★ 第一条画不出来要**接着试第二条**（不是立刻降级成标记）"
		);
		assert.ok(!chained.classes.includes("acc-file-badge"), "★ 还有候选没试完时不该降级");
		chained.children[0].onerror?.();
		assert.ok(chained.classes.includes("acc-file-badge"), "★★ 候选全试完才降级成类型标记");
		assert.equal(chained.text, "PNG", "降级后显示类型标记");

		// 非图片：直接就是标记，没有 img
		const root2 = makeEl("root");
		renderFileCards(root2, [{ id: "b7c8.pdf", label: "报告.pdf", badge: "PDF", thumbUrls: [] }]);
		assert.equal(root2.children[0].children[0].children.length, 0, "没有缩略图时不渲染 img");
		assert.equal(root2.children[0].children[0].text, "PDF", "非图片显示类型标记");
	}

	// ============================================================
	// ⑧ 站外 / 本机那一类行的**副标题**（⚠️ 全库只能有一处拼它）
	// ============================================================
	{
		// ⚠️⚠️ **这一段走过三轮弯路，别再走回去**（2026-10-16）：用户三次报「清单里出现了 `.md`」，
		// 我前两轮都在改**文案**（先加「笔记：」前缀、再去掉笔记后缀），两次都被否掉 ——
		// 第三次他把话说到最清楚：「**这个链接对应的文件不是附件，不应该进入上传列表**」。
		// ⇒ 真正该做的两条：① 那样的地址压根不该变成候选（判定层的形状/网页判据）；
		//   ② 这一行**压根不该出现库内路径**（下面这条断言 + 入参里根本不收 `notePath`）。
		// ⭐ ② 是**结构性**的：没有那个字段 ⇒ 想写也写不出来，
		// 不需要"再立一条规则、指望没人违反"（本项目最贵的一课）。
		const row = externalRowMeta({ host: "wiki.example.cn:666", notePath: "pages/方案.md", url: "https://x/y" });
		assert.equal(row, "wiki.example.cn:666", "★ 站外那一行只给**主机**");
		assert.ok(
			!row.includes(".md") && !row.includes("pages/"),
			"★★ 副标题里不许出现库内路径（否则会被读成「清单里进了一个 .md 文件」）"
		);

		// ⚠️ 本机文件（`file:///D:/…`）**没有主机** ⇒ 副标题要给那条**绝对路径**
		//（用户勾中它就是签了"读这条路径"，只显示一个空主机名等于让人盲签）。
		assert.equal(
			externalRowMeta({ host: "", notePath: "notes/x.md", url: "file:///D:/企业微信文件/截图.png" }),
			"file:///D:/企业微信文件/截图.png",
			"★ 本机文件（host 为空）要显示那条路径，而不是空串"
		);

		// 缺字段不能拼出半截字符串
		assert.equal(externalRowMeta({ host: "example.cn" }), "example.cn", "没有 URL 时只说主机");
		assert.equal(externalRowMeta({}), "", "什么都没有时返回空串");
		assert.equal(externalRowMeta(null), "", "null 不能抛错");
		assert.equal(externalRowMeta(undefined), "", "undefined 也不能抛错");
	}

	// ⚠️ 这里**不印"多少例"**：那个数是手工维护的，而"加一节"就把它变成假话
	//（2026-10-16 查出它停在 12，而套件此前已经加过两节）。规模数一律由跑测试时现算 ——
	// 参考 `test-transfer.mjs` 那种把计数**算出来**的写法。
	return {};
}
