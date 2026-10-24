/**
 * 把 `demo-frames/` 里的 PNG 序列合成 README 的演示动图（`docs/demo.gif`）。
 *
 * ## 为什么用 ffmpeg，而不是自己拼 GIF
 *
 * GIF 只有 256 色，"逐帧量化"会让整片抖动闪烁；ffmpeg 的 **palettegen ＋ paletteuse**
 * 是两遍法：先用全片统计出一套调色板，再逐帧映射 —— 一份调色板保证不闪，`dither=bayer`
 * 在小体积下也够用。字幕用 **ASS**（`subtitles` 滤镜，ffmpeg 自带 libass）：
 * 时间是视频时间轴的，不是逐帧叠图 —— 帧率/去重怎么变都不用改字幕。
 *
 * ## 帧与时长
 *
 * `timeline.json` 记着每帧的真实抓取时刻 ⇒ 这里按"到下一帧的间隔"给每帧 duration。
 * **完全相同的帧先去掉**（录的是界面变化，静止段落留着只是让文件变大）。
 *
 * ## 字幕
 *
 * `timeline.json` 的 `marks`（录制脚本打的点）就是字幕分段：一条从它自己的时刻
 * 持续到下一条。文案在 `CAPTIONS` 里，**按 mark 的顺序对**（改了顺序这里会报错，
 * 不会静默错位）。
 *
 * ## 用法
 *
 *     node scripts/capture-demo-gif.mjs
 *     FFMPEG_PATH=/path/to/ffmpeg node scripts/capture-demo-gif.mjs
 *
 * ffmpeg 找不到时按 `FFMPEG_PATH` → 托管工作区的 `ffmpeg-static` → `PATH` 里的 `ffmpeg`
 * 依次尝试（本机没有系统级 ffmpeg，走的是中间那条）。
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const FRAMES = join(REPO, "demo-frames");
const TIMELINE = join(FRAMES, "timeline.json");
const OUT = join(REPO, "docs/demo.gif");

/** 成片宽度（README 的正文列大约这么宽；再大只是让文件变重）。 */
const WIDTH = 900;
/**
 * 底部字幕条的高度（成片像素）。
 *
 * ⭐ 2026-10-24 用户口径：「以前那种方式更好」—— 指的是 **1.2.0 那版**：整条深色横带
 * 压在画面底部（不是紧跟文字的黑框）。旧图 1080 宽时它是 60px、颜色 `#111218`，
 * 按宽度折算到 900 宽 ≈ 50px。下面 `PAD` 那块滤镜就是照这个复刻的。
 */
const BAND = 52;
/** 字幕条底色（抄旧图的实测值，不是随手挑的黑）。 */
const BAND_COLOR = "0x111218";

/** 调色板颜色数：128 够用，256 在字节数上肉眼可见地更贵。 */
const COLORS = 128;
/** 每帧最短停留（毫秒）：GIF 的延时精度是 10ms，太短会看不清。 */
const MIN_MS = 140;

function resolveFfmpeg() {
	const candidates = [
		process.env.FFMPEG_PATH,
		"C:/Users/chenyue/.workbuddy/binaries/node/workspace/node_modules/ffmpeg-static/ffmpeg.exe",
		"ffmpeg",
	].filter(Boolean);
	for (const candidate of candidates) {
		if (candidate.includes("/") && !existsSync(candidate)) continue;
		try {
			execFileSync(candidate, ["-hide_banner", "-version"], { stdio: "ignore" });
			return candidate;
		} catch {
			// 试下一个
		}
	}
	throw new Error("找不到 ffmpeg —— 用 FFMPEG_PATH 指一个，或 npm i -g ffmpeg-static 后用它的路径");
}

/** `1:02:03.45` 形式的 ASS 时间。 */
function assTime(ms) {
	const total = Math.max(0, Math.round(ms / 10) * 10);
	const cs = Math.floor((total % 1000) / 10);
	const s = Math.floor(total / 1000) % 60;
	const m = Math.floor(total / 60000) % 60;
	const h = Math.floor(total / 3600000);
	const pad = (value, size = 2) => String(value).padStart(size, "0");
	return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

function writeCaptions(marks, size) {
	const lines = [
		"[Script Info]",
		"ScriptType: v4.00+",
		`PlayResX: ${size.width}`,
		`PlayResY: ${size.height + BAND}`,
		"WrapStyle: 2",
		"ScaledBorderAndShadow: yes",
		"",
		"[V4+ Styles]",
		"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, " +
			"Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, " +
			"Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
		// BorderStyle=1（只描边不带框）＋ 全透明描边：字是压在**整条字幕带**上的，
		// 再套一个框就成了"框上框"（第一版就是这样，用户说不如以前）。
		"Style: Caption,Arial,19,&H00FFFFFF,&H00FFFFFF,&H00111218,&H00111218," +
			"-1,0,0,0,100,100,0,0,1,0,0,2,30,30,16,1",
		"",
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
	];
	// 最后一句挂到片尾之后（少给了会出现"末尾一帧没字幕"的闪一下）
	const lastEnd = marks[marks.length - 1].at + 6000;
	for (const [index, mark] of marks.entries()) {
		// 第一句从 0 开始：录制脚本打第一个点之前还有几百毫秒（切模式、定位光标），
		// 留白会让人以为"开头没字幕"。
		const start = index === 0 ? 0 : mark.at;
		const end = index + 1 < marks.length ? marks[index + 1].at : lastEnd;
		lines.push(
			`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${String(mark.label).replace(/\{/g, "(").replace(/\}/g, ")")}`
		);
	}
	const path = join(FRAMES, "captions.ass");
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

/**
 * 逐帧时长（毫秒）。
 *
 * ⚠️ **在字幕分段的时刻把帧切开**：GIF 是离散帧，字幕只能从某一帧开始生效。
 * 如果一条字幕落在某帧停留的中间，它要等下一帧才出现（实测：第一句晚了一整拍，
 * 看上去像"开头没有字幕"）。所以按 mark 的时刻把那一帧**复制成两段**（同一张图），
 * 字幕于是正好卡在帧边界上。
 */
function writeConcatList(frames, cuts) {
	const edges = frames.map((frame, index) => ({
		file: frame.file,
		start: frame.at,
		end: index + 1 < frames.length ? frames[index + 1].at : frame.at + 1200,
	}));
	const segments = [];
	for (const edge of edges) {
		const inner = cuts.filter((at) => at > edge.start + 1 && at < edge.end - 1).sort((a, b) => a - b);
		let from = edge.start;
		for (const at of inner) {
			segments.push({ file: edge.file, start: from, end: at });
			from = at;
		}
		segments.push({ file: edge.file, start: from, end: edge.end });
	}

	const lines = [];
	for (const segment of segments) {
		lines.push(`file '${join(FRAMES, segment.file).replace(/\\/g, "/")}'`);
		lines.push(`duration ${Math.max(MIN_MS, segment.end - segment.start) / 1000}`);
	}
	// concat 的老脾气：最后一条 duration 要靠再写一遍同一张图才生效
	lines.push(`file '${join(FRAMES, segments[segments.length - 1].file).replace(/\\/g, "/")}'`);
	const path = join(FRAMES, "frames.txt");
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

const timeline = JSON.parse(readFileSync(TIMELINE, "utf8"));
const { frames, marks, width, height } = timeline;
if (!frames?.length) throw new Error("没有帧 —— 先跑 scripts/capture-demo.mjs");
if (!marks?.length) throw new Error("没有字幕分段");
if (marks.some((mark) => typeof mark.label !== "string" || mark.label === "")) {
	throw new Error("有一条 mark 没有 label —— 它就没有字幕（空字幕比配错字幕更没用）");
}

// ── 去掉与上一张**完全相同**的帧（录的是界面变化；静止段落不必占帧）──
const hashOf = (file) => createHash("sha1").update(readFileSync(join(FRAMES, file))).digest("hex");
const kept = [];
let lastHash = null;
for (const frame of frames) {
	const hash = hashOf(frame.file);
	if (hash === lastHash) continue;
	lastHash = hash;
	kept.push(frame);
}
// ⚠️ **不要删**被去掉的帧：它们只是不进 GIF。删掉之后这一轮就不可复算
//（重跑要重新录制十几秒），而 `demo-frames/` 本来就不入库。
console.log(`· 去重：${frames.length} → ${kept.length} 帧`);

// 缺帧要在跑 ffmpeg 之前说清（不然报错是 ffmpeg 的一句 ENOENT，看不出是"帧没录全"）
const missing = kept.filter((frame) => !existsSync(join(FRAMES, frame.file)));
if (missing.length > 0) {
	throw new Error(`缺 ${missing.length} 帧（${missing[0].file}…）—— 重跑 scripts/capture-demo.mjs`);
}

const listPath = writeConcatList(
	kept,
	marks.map((mark) => mark.at)
);
const assPath = writeCaptions(marks, { width, height });
const ffmpeg = resolveFfmpeg();

mkdirSync(dirname(OUT), { recursive: true });
const filter = [
	`scale=${WIDTH}:-2:flags=lanczos`,
	// ⭐ 底部铺一条整宽的深色带（旧版那种），字幕画在带上 —— 见 BAND 的注释
	`pad=iw:ih+${BAND}:0:0:color=${BAND_COLOR}`,
	`ass=${assPath.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1\\\\:")}`,
	"split[base][pal]",
	`[pal]palettegen=max_colors=${COLORS}:stats_mode=diff[p]`,
	"[base][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
].join(",");

console.log("· ffmpeg 编码中…");
execFileSync(
	ffmpeg,
	[
		"-hide_banner",
		"-loglevel",
		"warning",
		"-y",
		"-f",
		"concat",
		"-safe",
		"0",
		"-i",
		listPath,
		"-vf",
		filter,
		"-loop",
		"0",
		OUT,
	],
	{ stdio: "inherit" }
);

const bytes = readFileSync(OUT).length;
console.log(`✓ ${OUT} — ${WIDTH}×? / ${(bytes / 1024).toFixed(0)} KB`);
