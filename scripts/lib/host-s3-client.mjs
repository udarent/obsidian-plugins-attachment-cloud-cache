/**
 * 把宿主的 S3 客户端**代理**给 Node 侧脚本用（凭据不出宿主）。
 *
 * ## 为什么不用"把密钥读出来传给 Node"
 *
 * 密钥在宿主的 `secretStorage`（Obsidian 的钥匙串）里。技术上可以从渲染进程读出来
 * 再传回 Node，但那样密钥就进了另一个进程的内存、还可能被顺手打进日志。
 * 本项目的纪律是**脚本不去挖 `secretStorage`**；而"用现有库的凭据做真机测试"这个诉求
 * 不需要破例 —— 让**宿主自己**发请求就行。
 *
 * ## 代价（如实记）
 *
 * - 每次 S3 操作 = 一次 CDP `evaluate`（几十毫秒），几十个对象的迁移会明显慢于直连；
 * - 异常跨进程只剩字段（`kind` / `code` / `status` / `message`），**不是** `S3Error` 实例 ⇒
 *   产品代码里 `error instanceof S3Error` 那几处分支在真机测试里**走不到**（单测那边覆盖）。
 */

const PLUGIN_ID = "attachment-cloud-cache";

/** 一次代理调用：在宿主里调 `plugin.buildClient()` 的同名方法，把结果序列化回来。 */
async function callInHost(evaluate, client, method, args) {
	const expression = `(async () => {
		try {
			const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
			if (!plugin) return { __error: "plugin-not-loaded" };
			const s3 = plugin.buildClient();
			if (!s3) return { __error: "no-client" };
			const value = await s3[${JSON.stringify(method)}](...${JSON.stringify(args)});
			// 只回显可 JSON 化的字段：Uint8Array 之类的响应不参与迁移判定
			return { ok: true, value: JSON.parse(JSON.stringify(value ?? null)) };
		} catch (error) {
			return {
				ok: false,
				error: {
					kind: String(error?.kind ?? ""),
					code: String(error?.code ?? ""),
					status: Number(error?.status ?? 0),
					message: String(error?.message ?? error),
				},
			};
		}
	})()`;

	const result = await evaluate(client, expression);
	if (!result) throw new Error(`${method}: 宿主没有返回结果（CDP 断开了？）`);
	if (result.__error) throw new Error(`${method}: ${result.__error}`);
	if (!result.ok) {
		const error = new Error(`${method}: ${result.error.message}`);
		error.kind = result.error.kind;
		error.code = result.error.code;
		error.status = result.error.status;
		throw error;
	}
	return result.value;
}

/**
 * 造一个和 `S3Client` 同形的对象（只含迁移用到的那几个方法）。
 *
 * ⚠️ `putObject` 单独写：字节要 base64 过去、在宿主里还原，不能塞进 `args` 的 JSON。
 */
export function createHostClient({ evaluate, client }) {
	return {
		listObjects: (options = {}) => callInHost(evaluate, client, "listObjects", [options]),
		headObject: (key) => callInHost(evaluate, client, "headObject", [key]),
		copyObject: (from, to) => callInHost(evaluate, client, "copyObject", [from, to]),
		deleteObject: (key) => callInHost(evaluate, client, "deleteObject", [key]),
		/**
		 * 读一个对象（返回 Buffer）。用于**读回声明**这类"要看正文"的断言。
		 *
		 * ⚠️ 正文按 base64 过桥：`Uint8Array` 经 `JSON.stringify` 会变成 `{"0":..}` 这种对象，
		 * 看着像有数据、其实不能直接用。
		 */
		async getObject(key) {
			const expression = `(async () => {
				try {
					const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
					if (!plugin) return { __error: "plugin-not-loaded" };
					const s3 = plugin.buildClient();
					if (!s3) return { __error: "no-client" };
					const value = await s3.getObject(${JSON.stringify(key)});
					const bytes = value?.data ?? new Uint8Array(0);
					let binary = "";
					for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
					return { ok: true, base64: btoa(binary) };
				} catch (error) {
					return { ok: false, error: { kind: String(error?.kind ?? ""), code: String(error?.code ?? ""), status: Number(error?.status ?? 0), message: String(error?.message ?? error) } };
				}
			})()`;
			const result = await evaluate(client, expression);
			if (!result) throw new Error("getObject: 宿主没有返回结果");
			if (result.__error) throw new Error(`getObject: ${result.__error}`);
			if (!result.ok) throw new Error(`getObject: ${result.error.message}`);
			return { data: Buffer.from(result.base64, "base64") };
		},

		async putObject(key, bytes, contentType = "") {
			const base64 = Buffer.from(bytes).toString("base64");
			const expression = `(async () => {
				try {
					const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
					if (!plugin) return { __error: "plugin-not-loaded" };
					const s3 = plugin.buildClient();
					if (!s3) return { __error: "no-client" };
					const binary = atob(${JSON.stringify(base64)});
					const data = new Uint8Array(binary.length);
					for (let i = 0; i < binary.length; i += 1) data[i] = binary.charCodeAt(i);
					const value = await s3.putObject(${JSON.stringify(key)}, data, ${JSON.stringify(contentType)});
					return { ok: true, value: JSON.parse(JSON.stringify(value ?? null)) };
				} catch (error) {
					return { ok: false, error: { kind: String(error?.kind ?? ""), code: String(error?.code ?? ""), status: Number(error?.status ?? 0), message: String(error?.message ?? error) } };
				}
			})()`;
			const result = await evaluate(client, expression);
			if (!result) throw new Error("putObject: 宿主没有返回结果");
			if (result.__error) throw new Error(`putObject: ${result.__error}`);
			if (!result.ok) throw new Error(`putObject: ${result.error.message}`);
			return result.value;
		},
	};
}

/**
 * 读插件当前生效的存储配置（**不含密钥**：密钥只在宿主内存里）。
 *
 * 只取迁移判定与链接拼接需要的那几项。
 */
export async function readS3Settings(evaluate, client) {
	const expression = `(() => {
		const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
		if (!plugin) return { __error: "plugin-not-loaded" };
		const s3 = plugin.settings?.s3 ?? {};
		const hasSecret = Boolean(plugin.buildClient());
		return {
			endpoint: String(s3.endpoint ?? ""),
			bucket: String(s3.bucket ?? ""),
			region: String(s3.region ?? ""),
			publicUrlBase: String(s3.publicUrlBase ?? ""),
			forcePathStyle: s3.forcePathStyle !== false,
			hasSecret,
		};
	})()`;
	const result = await evaluate(client, expression);
	if (!result) throw new Error("读不到插件设置（CDP 断开了？）");
	if (result.__error) throw new Error(result.__error);
	return result;
}
