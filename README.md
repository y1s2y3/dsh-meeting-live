# 会议纪要插件 · 源码与发布工程

DSH Desktop 的「会议纪要」插件（录音/录屏 → 实时转写 → AI 纪要 → 待办 → 导出）。
本目录是**唯一事实源**：所有修改直接改 `src/`，再用脚本部署 / 打包。

> 上游：基于 `dsh-plugin-meeting-minutes` v1.1.0（MIT，作者 zhangguitao666）做的事本地深度改造。

## 目录

```
src/                     插件源码（直接改这里）
  lib/                   宿主半 + 浏览器半（* .js）
    client.js            浏览器 bundle（手写 React 渲染，前端界面全在这里）
    server.js            本地 HTTP 接口（转写 / 导出 / 媒体落盘 / MP4 转码）
    index.js             插件入口（挂服务、注册工具、浮窗桥）
    orb.js / live-mirror.js   浮窗状态桥 + 实时录音镜像
    dsh-todo.js          写入 DSH 待办（工作轨）的桥接
    tools.js / skill.js  AI 工具与技能定义
  resources/
    meeting-orb.ps1      Windows 桌面浮窗（PowerShell + WPF，必须带 BOM 保存）
  package.json           插件清单（name / dsh.bundle / dsh.client …）
  cordis.patch.yml       插件加载声明
tests/                   离线自测（4 套，改完代码跑一遍）
deploy.mjs               部署到 DSH Desktop profile
package.mjs              打包成可分发的 .tgz
backups/                 deploy 自动备份的线上版本（git 忽略）
dist/                    打包产物（git 忽略）
```

## 日常流程

```powershell
# 1. 改代码：直接编辑 src/ 下的文件
# 2. 部署到本机 DSH Desktop（默认 desktop profile，会自动备份线上版本）
node deploy.mjs
#    只想看会做什么：
node deploy.mjs --dry-run

# 3. 验证（离线自测，不需要启动 DSH）
node tests/smoke-server.mjs
node tests/smoke-client-device.mjs
node tests/smoke-client-pause.mjs
node tests/smoke-bridge.mjs
```

改完何时生效：

| 改动位置 | 生效方式 |
|---|---|
| `lib/client.js`（界面） | 刷新页面 `Ctrl+R` |
| `lib/server.js` / `index.js` / `package.json` / `cordis.patch.yml` | **重启 DSH Desktop** |
| `resources/meeting-orb.ps1` | 下次开始录音时自动重新拉起浮窗，无需重启 |

## 打包给别人用

```powershell
node package.mjs
# 或者改包名/版本：
node package.mjs --name dsh-plugin-meeting-minutes-pro --version 1.2.0
```

产物在 `dist/`：

- `dsh-plugin-meeting-minutes-<版本>.tgz`（内含 `<包名>/` 目录，可直接被 npm/pnpm 安装）
- `安装说明-<版本>.md`（给使用者的安装步骤 + 环境前提）

别人环境要求：Windows 10/11、DSH Desktop ≥ 2.0.17；录屏要 MP4 需 ffmpeg；「写入待办」需
`dsh-memory-evolve` 插件（没装则按钮置灰，其他功能正常）。

## 相对上游 v1.1.0 的主要改造

**界面 / 交互**
- 左侧三个大按钮：实时录音/录屏、录音转写、导入纪要；单行会议列表（每次录音一条，0 字不留空壳）
- 录音弹窗不设 Tab：点哪个入口只显示哪个功能；勾「同步录屏」先选屏幕
- 详情页：封面区右上角集中「编辑信息 / AI 生成纪要 / 导出 HTML / 导出 Markdown / 删除」
- 新增「AI 会议纪要」卡片：固定高度、可展开收起、一键复制全文
- 配色改为浅灰底 + 白卡片 + 浅蓝主题

**录音 / 转写**
- 空识别结果不再中断录音（后端返回 200 + 0 字，时长照计）
- 失败重试 + 连续失败才中断；静音约 20 秒提示；麦克风设备可选并记住
- 暂停＝停采集，同一场会议可继续

**桌面浮窗（Windows）**
- 单窗口实现（球 + 气泡同窗口），球固定右下角；可拖动、记住位置
- 透明度 / 光圈居中 / 麦克风随音量缩放与光晕（参考腾讯会议）
- 停止后自动收浮窗；页面底部黑色录音条已移除；录音中自动收起白色弹窗

**录屏 / 产物**
- 录音同屏录制：视频（屏幕画面 + 麦克风配音）+ 独立音频（WAV 16kHz）
- 结束后本机 ffmpeg 后台转 **MP4（H.264 + AAC）**，转完自动删 WebM
- 文件落在 `~/.dsh/storages/meeting-minutes-media/<会议ID>/`，弹窗内可「在文件夹中显示」

**待办**
- 「写入任务日历」改为「写入待办」：写进 DSH 待办的**工作**轨（`TODOS-work.md`），
  复用 `dsh-memory-evolve` 的存储实现，格式与 `dtodo` 完全一致

## 注意

- `resources/meeting-orb.ps1` **必须保存为带 BOM 的 UTF-8**：Windows PowerShell 5.1 对无 BOM 文件
  按 ANSI 解码，中文注释会破坏语法。
- 插件的 `node_modules` 安装目录会被 `dsh plugin add` 等操作整体覆盖；覆盖后重新
  `node deploy.mjs` 即可恢复全部改动（备份在 `backups/`）。
- 本工程独立存放、单独 git 管理。
