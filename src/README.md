# 会议纪要（Meeting Minutes）

> DSH Desktop（DeepSeek Harness）插件：**录音 / 录屏 → 实时转写 → AI 结构化纪要 → 待办 → 导出**。
> 本包基于 `dsh-plugin-meeting-minutes` v1.1.0（MIT，上游作者 zhangguitao666）深度改造；
> 上游原始说明见同目录 `README-upstream.md`。

## 能做什么

- **实时录音 / 录屏**：边说边出字（约 6–10 秒延迟）；可勾选「同步录屏」，先选屏幕再开始；
  会议结束后生成 **带配音的 MP4 视频** + **独立 WAV 音频**。
- **录音转写**：导入已有的音频 / 视频文件，自动转成文字并保存到会议。
- **导入纪要**：粘贴腾讯会议纪要文本，或导入 txt / md / json。
- **AI 结构化纪要**：一句话结论、概述、关键要点、决策事项、风险、待办（含负责人/截止/优先级）；
  详情页有独立「AI 会议纪要」卡片（固定高度、可展开收起、一键复制）。
- **待办**：一键写入 DSH 待办（**工作**类型），与 `dtodo` 面板同一套存储。
- **导出**：单场会议导出为独立 HTML 或 Markdown 文档。
- **自动入库**：本机录制文件自动导入成待整理会议。
- **桌面浮窗（Windows）**：置顶小圆球 + 气泡卡片，显示录音状态/时长/实时文本，可暂停/停止；
  麦克风图标随音量起伏。

## 环境前提

| 前提 | 必须？ | 说明 |
|---|---|---|
| Windows 10 / 11 | 必须 | 桌面浮窗为 PowerShell + WPF 实现 |
| DSH Desktop ≥ 2.0.17 | 必须 | 插件加载器要求 |
| ffmpeg | 录屏要 MP4 才需要 | 缺 ffmpeg 时录屏只生成 WebM；自动探测 PATH / winget 目录 |
| `dsh-memory-evolve` | 可选 | 「写入待办」依赖它；没装则按钮置灰，其他功能正常 |

## 安装

1. 把本包解压到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-meeting-minutes\`；
2. 编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：把包名加入 `dependencies`
   与 `dsh.profile.bundles`；
3. 完全重启 DSH Desktop。

## 产物位置

- 会议数据：`%USERPROFILE%\.dsh\storages\meeting-minutes.json`
- 录屏 / 音频：`%USERPROFILE%\.dsh\storages\meeting-minutes-media\<会议ID>\`
- 浮窗运行态：`%LOCALAPPDATA%\dsh-meeting-orb\desktop\`

## 许可

MIT。上游版权归原作者；本包为其修改版，不声称获得上游背书。