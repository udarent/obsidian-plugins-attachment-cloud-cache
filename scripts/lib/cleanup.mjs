/**
 * 测试收尾用的清理工具。
 *
 * ## 为什么删除临时目录要"交给子进程"
 *
 * 这是**实测**出来的，不是推测：Windows 上 `rm -r` **偶发**会卡住不返回
 * （现场：进程的活动句柄只剩未完成的 fs 请求，而套件其实早已跑完）。
 * 症状是"**测试全绿但进程退不出去**" —— 被外层超时杀掉，日志里什么都没有，
 * 最难查的一种。同一份代码连跑 8 遍能有 4 遍挂死，而套件越大（文件越多）越容易撞上。
 *
 * 交给分离的子进程之后，卡住也只卡它自己，与本进程能否退出无关。
 * `detached` + `unref` 两件都要：前者让它脱离进程组，后者让本进程不必等它。
 *
 * 删不掉也不是问题：临时目录在系统临时区，迟早会被清理 ——
 * 而"一次清理没做完"绝不该变成"整个测试跑不完"。
 */

import { spawn } from "node:child_process";

/** 异步地删掉一个目录树（卡住也不会拖住调用方）。 */
export function cleanupInBackground(path) {
	try {
		const child = spawn(
			process.execPath,
			["-e", `require("fs").rmSync(${JSON.stringify(path)}, { recursive: true, force: true })`],
			{ detached: true, stdio: "ignore" }
		);
		child.unref();
	} catch {
		// 连派生都失败就算了：清理失败不该影响测试结论
	}
}
