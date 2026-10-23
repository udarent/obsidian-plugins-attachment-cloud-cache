/**
 * 真机探针的**页面内选择器与弹窗操作**（被 `verify-flows` / `verify-confirm` 共用）。
 *
 * ## 为什么要有这一层
 *
 * 两个探针都要做同一件事：等清单弹窗出现、读它的结构、按名字勾一行、点主按钮。
 * 而这些东西**全部是 DOM 契约** —— 类名一改，两处都得跟着改。复制一份的下场是
 * 「一处改了、另一处还在看旧类名，而且不报错，只是断言忽然全绿」（这个项目踩过同形的坑）。
 *
 * ## 一条纪律：这里只**读**界面，不替用户做决定
 *
 * `clickCta()` 会点主按钮（那是调用方明确要求的动作，`verify-confirm` 需要它）。
 * 除此之外这里没有任何"顺手点一下"的东西 —— 谁来点、点完断言什么，都由调用方说清。
 */

import { setTimeout as delay } from "node:timers/promises";

import { evaluate } from "./obsidian-host.mjs";

/**
 * 页面里的公共小工具（拼进每次 `evaluate` 的前面）。
 *
 * ⚠️ 它是一串 `const …` 声明，只能待在**块**里（`(() => { … })()` 或 `(async () => { … })()`）。
 * 塞进 `Boolean(${DOM_HELPERS})` 这种表达式位置会直接语法错。
 */
export const DOM_HELPERS = `
	const modal = () => document.querySelector(".modal-container .modal");
	const rows = () => Array.from(modal()?.querySelectorAll(".acc-task-row") ?? []);
	const rowInfo = (row) => {
		const box = row.querySelector("input.acc-task-check");
		const open = row.querySelector("a.acc-task-open");
		const icon = row.querySelector(".acc-task-hint-icon");
		return {
			name: row.querySelector(".acc-task-name")?.textContent ?? "",
			hint: row.querySelector(".acc-task-hint")?.textContent ?? "",
			hasIcon: Boolean(icon),
			iconSvg: Boolean(icon?.querySelector("svg")),
			iconTitle: icon?.getAttribute("title") ?? "",
			meta: row.querySelector(".acc-task-meta")?.textContent ?? "",
			boxChecked: box ? box.checked : null,
			boxDisabled: box ? box.disabled : null,
			aria: box ? box.getAttribute("aria-label") : null,
			openText: open?.textContent ?? "",
			openTitle: open?.getAttribute("title") ?? "",
			status: row.querySelector(".acc-task-status")?.textContent ?? "",
		};
	};
	const toggleFor = (label) => {
		for (const item of Array.from(modal()?.querySelectorAll(".setting-item") ?? [])) {
			const name = item.querySelector(".setting-item-name")?.textContent ?? "";
			if (!name.includes(label)) continue;
			const box = item.querySelector(".checkbox-container");
			if (box) return box;
		}
		return null;
	};
	const clickButton = (label) => {
		for (const button of Array.from(modal()?.querySelectorAll("button") ?? [])) {
			if ((button.textContent ?? "").trim() === label) {
				button.click();
				return true;
			}
		}
		return false;
	};
	const progressText = () => modal()?.querySelector(".acc-task-progress")?.textContent ?? "";
	const actionButtons = () =>
		Array.from(modal()?.querySelectorAll(".acc-task-actions button") ?? []).map((button) => ({
			text: (button.textContent ?? "").trim(),
			disabled: Boolean(button.disabled),
			cta: button.classList.contains("mod-cta"),
		}));
	/** 按行名**包含**匹配某一行（名字是文件名，够唯一；匹配不到返回 null）。 */
	const rowByName = (name) =>
		rows().find((row) => (row.querySelector(".acc-task-name")?.textContent ?? "").includes(name)) ?? null;
	/** 把某一行勾成 on 状态（已经是那个状态就不点，避免把勾选点反）。 */
	const checkRow = (name, on) => {
		const row = rowByName(name);
		const box = row?.querySelector("input.acc-task-check");
		if (!box || box.disabled) return false;
		if (box.checked !== on) box.click();
		return true;
	};
	/**
	 * 点主按钮（"上传并改写链接 (3)" / "只删本地文件 (3)" 那种）。
	 *
	 * ⚠️ **完成态那颗「关闭」也是 mod-cta 样式**（showSettledFooter 里同样 setCta），
	 * 所以必须把"关闭 / Close"排掉 —— 否则在完成态再调一次就成了关窗。
	 */
	const clickCta = () => {
		const button = Array.from(modal()?.querySelectorAll(".acc-task-actions button") ?? []).find((item) => {
			const text = (item.textContent ?? "").trim();
			if (/^(关闭|Close)$/.test(text)) return false;
			return item.classList.contains("mod-cta") || /(上传|只删|Upload|Delete)/i.test(text);
		});
		if (!button) return false;
		button.click();
		return true;
	};
`;

/** 等弹窗出现（最多 `ms`）。⚠️ 必须轮询：命令是异步的，`executeCommandById` 立刻返回。 */
export async function waitForDialog(client, ms = 9000) {
	const deadline = Date.now() + ms;
	/**
	 * 轮询期间见到的 Notice —— 有些结局（「没有可处理的」/「先去配置」）
	 * **只会出现一瞬**（几秒后自己消失）。收着它们，失败时才知道"它到底说了什么"。
	 */
	const notices = new Set();
	while (Date.now() < deadline) {
		const ready = await evaluate(
			client,
			`(() => { ${DOM_HELPERS} return Boolean(modal() && modal().querySelector(".acc-task-list")); })()`
		).catch(() => false);
		const seen = await evaluate(
			client,
			`Array.from(document.querySelectorAll(".notice")).map((el) => el.textContent)`
		).catch(() => []);
		for (const text of seen ?? []) notices.add(text);
		if (ready) return { appeared: true, notices: [...notices] };
		await delay(150);
	}
	return { appeared: false, notices: [...notices] };
}

/** 读一眼弹窗的当前样子（含进度行与按钮区）。 */
export async function dialogSnapshot(client) {
	return evaluate(
		client,
		`(() => {
			${DOM_HELPERS}
			const root = modal();
			if (!root) return null;
			const filters = Array.from(root.querySelectorAll(".setting-item")).map((item) => ({
				name: item.querySelector(".setting-item-name")?.textContent ?? "",
				hasToggle: Boolean(item.querySelector(".checkbox-container")),
			}));
			return {
				title: root.querySelector(".modal-title")?.textContent ?? "",
				lines: Array.from(root.querySelectorAll(".acc-task-lines > div")).map((el) => el.textContent ?? ""),
				rows: rows().map(rowInfo),
				filters: filters.filter((item) => item.hasToggle),
				buttons: Array.from(root.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim()).filter(Boolean),
				progress: progressText(),
				actions: actionButtons(),
			};
		})()`
	);
}

/** 执行一条插件命令（命令体是 fire-and-forget，所以这行返回时弹窗还没出现）。 */
export async function runCommand(client, pluginId, id) {
	return evaluate(
		client,
		`(async () => {
			await app.commands.executeCommandById(${JSON.stringify(`${pluginId}:${id}`)});
			return true;
		})()`
	);
}

/** 勾选/取消「只看当前笔记」这类开关（按名字包含匹配）。 */
export async function setToggle(client, label, on) {
	return evaluate(
		client,
		`(() => {
			${DOM_HELPERS}
			const box = toggleFor(${JSON.stringify(label)});
			if (!box) return false;
			const input = box.querySelector("input");
			const isOn = input ? input.checked : box.classList.contains("is-enabled");
			if (isOn === ${Boolean(on)}) return true;
			box.click();
			return true;
		})()`
	);
}

/** 勾/取消某一行（按行名包含匹配）。返回是否真点到了。 */
export async function checkRow(client, name, on = true) {
	return evaluate(
		client,
		`(() => { ${DOM_HELPERS} return checkRow(${JSON.stringify(name)}, ${Boolean(on)}); })()`
	);
}

/** 点主按钮（完成态的「关闭」不算主按钮）。 */
export async function clickCta(client) {
	return evaluate(client, `(() => { ${DOM_HELPERS} return clickCta(); })()`);
}

/**
 * 等到**完成态**（D-80）：进度行变成"已结束：…"且按钮区只剩一颗。
 *
 * ⚠️ 两个条件都要：只看进度会早一截（逐项跑完后改写/收尾还在继续，
 * `task-list-modal.ts` 的文件头专门写了这一条），只看按钮数又分不清"还没画完"。
 *
 * 超时返回最后一次快照（`settled: false`），交给调用方断言 —— 这里不抛错，
 * 因为"没等到完成态"本身就是一条要打印出来的失败原因。
 */
export async function waitSettled(client, ms = 120_000) {
	const deadline = Date.now() + ms;
	let snapshot = null;
	while (Date.now() < deadline) {
		snapshot = await dialogSnapshot(client).catch(() => null);
		const progress = snapshot?.progress ?? "";
		const finished = /(已结束|Finished):/.test(progress);
		const singleAction = (snapshot?.actions ?? []).length === 1;
		if (finished && singleAction) return { settled: true, snapshot };
		await delay(200);
	}
	return { settled: false, snapshot };
}

/** 关掉弹窗，并等它真的消失（否则下一条命令会读到上一个 DOM）。 */
export async function closeDialog(client) {
	await evaluate(
		client,
		`(() => {
			${DOM_HELPERS}
			if (!clickButton("取消") && !clickButton("Cancel")) {
				if (!clickButton("关闭")) clickButton("Close");
			}
			return true;
		})()`
	);
	const deadline = Date.now() + 4000;
	while (Date.now() < deadline) {
		const gone = await evaluate(client, "Boolean(!document.querySelector('.modal-container .modal'))");
		if (gone) return true;
		await delay(120);
	}
	return false;
}
