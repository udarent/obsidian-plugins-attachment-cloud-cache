# demo-assets —— 演示动图里那张照片

`photo.jpg` 是 README 演示动图（`docs/demo.gif`）里"粘贴的那张照片"。

## 来源与许可

| | |
|---|---|
| 作品 | **Lake and Mountain**（Moraine Lake，Banff National Park，加拿大） |
| 作者 | James Wheeler（Pexels 上的 [@souvenirpixels](https://www.pexels.com/@souvenirpixels/)） |
| 页面 | https://www.pexels.com/photo/417074/ |
| 许可 | [Pexels License](https://www.pexels.com/license/)：免费商用、**不要求署名**、可修改；不得转售原图、不得暗示作者为本项目背书 |

## 处理

| 步骤 | 说明 |
|---|---|
| 下载 | `images.pexels.com/.../417074.jpeg?w=1600`（1600×1078） |
| 裁切 | 居中裁成 **3:2**（和笔记里那张图的版式一致） |
| 缩放 | 到 **640×427**（成片 900 宽时，这一栏正文约 640 —— 不再二次缩放） |
| 去元数据 | 用 Pillow 重新编码，**exif 全部丢掉**（原图的相机 / GPS 不该跟着动图一起公开） |
| 体积 | JPEG q84 / progressive ≈ **56 KB** |

## 为什么放在仓库里

录制脚本（`scripts/capture-demo.mjs`）每次都要读它 —— 不入库的话，换台机器就重录不出来。
56 KB，比一张截图大不了多少。

## 之前那张（已废弃）

2026-10-24 之前用的是 1.2.0 动图里那张（琥珀玻璃球 / 蓝调地面）。它的**原文件已经找不到了**
（当年在演示库里，库清理时一起没了），只能从旧 GIF 里裁出 **211×140** —— 放大到 400 宽仍然明显发糊，
所以用户改口径「原图找不到就重新在网上找一张」，换成了上面这张。
