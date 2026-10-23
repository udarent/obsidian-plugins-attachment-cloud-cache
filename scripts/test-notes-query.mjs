import { withLoadedTs } from "./lib/load-ts.mjs";
import { runNotesQuerySuite } from "./lib/notes-query-suite.mjs";

/**
 * 「从宿主读事实」的查询测试。
 *
 * 这一层是**五处唯一判据之一**的落点：它回答"这份文件还有没有人引用"。
 * 判错的后果是静默的（占用报告的数字错、命令该处理的跳过），所以按
 * **来源 × 写法**逐格穷举，而不是只测"能返回集合"。
 *
 * 断言在 `lib/notes-query-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs(["src/plugin/notes-query"], async (mod) => {
	const stats = await runNotesQuerySuite(mod);
	console.log(
		`Notes-query tests passed (${stats.sources} sources — host link index, our own body parsing ` +
			`over ${stats.spellings} spellings (wikilink / markdown / frontmatter / inline HTML / reference definition), ` +
			`and canvas text nodes; scheme-bearing targets never count as local references; ambiguous basenames ` +
			`are not guessed; percent-encoded, table-escaped and parenthesised (\`…(1).pdf\`) forms resolve; ` +
			`the error default of vaultPathExists points the safe way; the single-note view (behind the ` +
			`"only the current note" filter) answers with the very same rules, so a code block, an inline ` +
			`code span or a comment never counts there either while a frontmatter link still does; ` +
			`and the debug switch is actually wired - ` +
			`asking for it yields exactly one stage line with its counts, leaving it out yields none).`
	);
});
