/**
 * 极小的类型守卫工具。
 *
 * ## 为什么单独一个文件
 *
 * 这个判断在三个地方都要用（设置合并、缓存索引校验、错误对象解析），
 * 而它最容易出错的点恰恰是"看起来显然"：`typeof value === "object"` 对
 * `null` 与**数组**都成立，于是 `data.foo` 会读到一堆下标键，
 * 或者读一个 `null` 的属性直接抛错。三份拷贝意味着三处都要记得处理这两件事。
 *
 * 所以这里只放**一个**实现，并用提前返回把两种拒绝理由分开写 ——
 * 一眼能看出"数组也在这里被拦下"，而不是塞在一个布尔表达式里靠读的人自己发现。
 */

/**
 * 是否是"能安全按属性读值"的普通对象。
 *
 * 排除 `null`（`typeof null === "object"`）与数组（配置/索引结构里数组不是对象）。
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null) return false;
	if (Array.isArray(value)) return false;
	return typeof value === "object";
}
