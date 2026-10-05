import { runMutations } from "./lib/mutate.mjs";
import { runSettingsSuite } from "./lib/settings-suite.mjs";

/**
 * 变异验证：设置模块。
 *
 * 目标缺陷是「设置存得进读不出」—— 合并逻辑写成
 * `{ ...defaults, <逐个枚举的字段> }` 时，凡没被枚举到的字段都会静默回落到默认值。
 * 类型系统抓不到，也不报错，用户改了设置重启就丢。
 *
 * 加载机器与断言共用逻辑在 `lib/mutate.mjs` / `lib/settings-suite.mjs`
 * （不派生进程，理由见 lib/mutate.mjs 的说明）。
 */
await runMutations({
	source: "src/settings.ts",
	suite: runSettingsSuite,
	mutations: [
		{
			name: "cacheFolder 永远取默认值（经典的「存得进读不出」）",
			from: "cacheFolder: pickNonEmptyString(data.cacheFolder, defaults.cacheFolder),",
			to: "cacheFolder: defaults.cacheFolder,",
			expect: "cacheFolder 必须能往返持久化",
		},
		{
			name: "enabled 忽略已存值",
			from: "enabled: pickBoolean(data.enabled, defaults.enabled),",
			to: "enabled: defaults.enabled,",
			expect: "enabled 必须能往返持久化",
		},
		{
			name: "s3.bucket 忽略已存值",
			from: "bucket: pickString(data.bucket, DEFAULT_S3.bucket),",
			to: "bucket: DEFAULT_S3.bucket,",
			expect: "s3.bucket 必须能往返",
		},
		{
			name: "布尔校验被去掉（坏值直接透传）",
			from: 'return typeof value === "boolean" ? value : fallback;',
			to: "return value;",
			expect: "应回落到默认",
		},
		{
			name: "枚举校验被去掉（非法值透传）",
			from: "return guard(value) ? value : fallback;",
			to: "return value;",
			expect: "非法枚举应回落默认",
		},
		{
			// ⚠️ `...data` 必须放在**开头**：放末尾会同时覆盖各字段的校验结果，
			// 于是先触发"坏值应回落"那条断言，报错原因就不是"未知字段被带进来"了。
			name: "未知字段被带进来（不再逐字段白名单）",
			from: "\treturn {\n\t\tenabled: pickBoolean(data.enabled, defaults.enabled),",
			to: "\treturn {\n\t\t...data,\n\t\tenabled: pickBoolean(data.enabled, defaults.enabled),",
			expect: "未知的顶层字段不应被保留",
		},
		{
			name: "凭据字段被允许进入 s3 配置（违反 SecretStorage 约束）",
			from: "\t\tregion: pickNonEmptyString(data.region, DEFAULT_S3.region),",
			to: '\t\tregion: pickNonEmptyString(data.region, DEFAULT_S3.region),\n\t\taccessKeyId: pickString(data.accessKeyId, ""),',
			// 该断言检查的是**合并输出**而不是默认值 —— 真正会漏的是
			// 旧 data.json 里的明文密钥被保留下来
			expect: "不得保留凭据字段",
		},
	],
});
