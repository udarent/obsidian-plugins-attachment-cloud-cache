"""把 `capture-demo.mjs` 截下的帧合成 `docs/demo.gif`（叠字幕 + 缩放 + 体积控制）。

为什么不用 ffmpeg：本机没有；而"按时间轴分段叠中文字幕"用 Pillow 反而更直接。

用法（隔离 venv）：
    <venv>/python scripts/capture-demo-gif.py

输入：`demo-frames/timeline.json` + `f0000.png…`
输出：`docs/demo.gif`
"""

from __future__ import annotations

import io
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
FRAMES = REPO / "demo-frames"
OUT = REPO / "docs" / "demo.gif"

TARGET_W = 960  # 最终宽度（README 首屏，别太大）
BAR_H = 58  # 底部字幕条高度
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",  # 微软雅黑
    r"C:\Windows\Fonts\Deng.ttf",  # 等线
    r"C:\Windows\Fonts\simhei.ttf",
]
BAR_BG = (24, 24, 28)
BAR_FG = (245, 245, 248)
ACCENT = (122, 162, 247)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit("找不到中文字体（试过 msyh / Deng / simhei）")


def main() -> None:
    meta = json.loads((FRAMES / "timeline.json").read_text(encoding="utf-8"))
    frames = meta["frames"]
    marks = meta["marks"]
    if not frames:
        raise SystemExit("没有帧")

    # 每段字幕：从它自己的时刻起，到下一段开始
    caps: list[tuple[int, str]] = []
    for index, mark in enumerate(marks):
        start = int(mark["at"])
        end = int(marks[index + 1]["at"]) if index + 1 < len(marks) else 10**9
        caps.append((start, end, str(mark["label"])))  # type: ignore[arg-type]

    def caption_at(ms: int) -> str:
        for start, end, label in caps:
            if start <= ms < end:
                return label
        return caps[0][2] if ms < caps[0][0] else caps[-1][2]

    width, height = int(meta["width"]), int(meta["height"])
    scale = TARGET_W / width
    out_w = TARGET_W
    out_h = int(round(height * scale)) + BAR_H

    font = load_font(int(BAR_H * 0.42))
    frames_out: list[Image.Image] = []
    durations: list[int] = []

    for index, frame in enumerate(frames):
        shot = Image.open(FRAMES / frame["file"]).convert("RGB")
        shot = shot.resize((out_w, out_h - BAR_H), Image.LANCZOS)

        canvas = Image.new("RGB", (out_w, out_h), BAR_BG)
        canvas.paste(shot, (0, 0))

        draw = ImageDraw.Draw(canvas)
        # 字幕条：左边一小段强调色，右边文字（同一帧里只画一次，减少抖动）
        draw.rectangle([0, out_h - BAR_H, out_w, out_h], fill=BAR_BG)
        draw.rectangle([0, out_h - BAR_H, 5, out_h], fill=ACCENT)
        text = caption_at(int(frame["at"]))
        box = draw.textbbox((0, 0), text, font=font)
        draw.text(
            (24, out_h - BAR_H + (BAR_H - (box[3] - box[1])) / 2 - box[1]),
            text,
            font=font,
            fill=BAR_FG,
        )
        frames_out.append((canvas, int(frame["at"])))

    # ⭐ 去掉"和上一帧一模一样"的帧：录的是界面变化，静止段落留着只是让文件变大
    #（Pillow 存 GIF 时也会自己合并相同帧，但那会让帧数变得不可预期 —— 这里显式做，
    # 于是"每一帧停留多久"由它到下一帧的时间差决定，和真实操作节奏一致）。
    kept: list[tuple[Image.Image, int]] = []
    for canvas, at in frames_out:
        if kept:
            same = ImageChops.difference(kept[-1][0], canvas).getbbox() is None
            if same:
                continue
        kept.append((canvas, at))

    durations = []
    for index, (_canvas, at) in enumerate(kept):
        nxt = kept[index + 1][1] if index + 1 < len(kept) else int(frames[-1]["at"]) + int(meta.get("frameMs", 120))
        durations.append(max(120, nxt - at))
    frames_out = [canvas for canvas, _at in kept]
    print(f"· 去重后 {len(frames_out)} 帧（原始 {len(frames)}）")

    # GIF 调色板：用整体自适应盘（每帧各自量化会让颜色闪烁）
    palette = frames_out[0].quantize(colors=128, method=Image.MEDIANCUT)
    quantized = [f.quantize(palette=palette, dither=Image.NONE) for f in frames_out]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    quantized[0].save(
        OUT,
        save_all=True,
        append_images=quantized[1:],
        duration=durations,
        loop=0,
        optimize=False,
        disposal=1,
    )
    size_kb = OUT.stat().st_size / 1024
    total_s = sum(durations) / 1000
    print(f"✓ {OUT}  {out_w}×{out_h}  {len(quantized)} 帧  {total_s:.1f}s  {size_kb:.0f} KB")


if __name__ == "__main__":
    main()
