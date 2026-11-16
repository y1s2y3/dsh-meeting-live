# 会议纪要插件 · 源码与发布工程

> 自研版本 · 维护者：**DinosaurYSL**

DSH Desktop 的「会议纪要」插件（录音/录屏 → 实时转写 → AI 纪要 → 待办 → 导出）。
本目录是**唯一事实源**：所有修改直接改 `src/`，再用脚本部署 / 打包。

## 给使用者（不想参与开发）

- **安装与首次使用**：见 [INSTALL.md](INSTALL.md)。
- **发布包**：在 [GitHub Releases](https://github.com/y1s2y3/dsh-meeting-live/releases) 下载 `dsh-meeting-live-<版本>.tgz`（不要直接下「源码压缩包」当插件装，源码是给开发/打包用的）。
- **插件功能与价值**：见 [src/README.md](src/README.md)（这是会随包分发给使用者的那份说明）。
- **仓库**：<https://github.com/y1s2y3/dsh-meeting-live>

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
  README.md              插件用户说明（随包分发）
  LICENSE                MIT 授权文本（随包分发）
tests/                   离线自测（13 套，改完代码跑一遍）
deploy.mjs               部署到 DSH Desktop profile
package.mjs              打包成可分发的 .tgz
INSTALL.md               给使用者的安装/升级/卸载说明
LICENSE                  本仓库授权文本
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
node tests/smoke-tools.mjs          # 工具层：create/get/export/summarize/push_todos
node tests/smoke-file-import.mjs
node tests/smoke-panel-deep.mjs
node tests/smoke-settings-render.mjs
node tests/smoke-win-tencent.mjs    # Windows 专项：腾讯会议目录选择/扫描、docx 解析、ffmpeg 转码
node tests/smoke-cloud-asr.mjs      # 云端转写协议层：三家签名/请求体/响应解析（mock，无需密钥）
node tests/smoke-model-hash.mjs     # 模型文件 SHA-256 清单与本机已下载模型一致性（防镜像替换）
node tests/smoke-update-check.mjs   # 版本更新检查（版本比较 / npm 优先 / GitHub 兜底 / 缓存）
node tests/smoke-summary-rich.mjs   # 详细纪要结构：新字段规范化、prompt 要求、Word/HTML/Markdown 导出
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
node package.mjs --name dsh-meeting-live-pro --version 1.2.0
```

产物在 `dist/`：

- `dsh-meeting-live-<版本>.tgz`（内含 `<包名>/` 目录，可直接被 npm/pnpm 安装）
- `安装说明-<版本>.md`（给使用者的安装步骤 + 环境前提）

别人环境要求：Windows 10/11、DSH Desktop ≥ 2.0.17；ffmpeg 用于录屏、腾讯会议录制（mp4/m4a）自动转写、
对话里转写本地音视频（没装时这些不可用，实时录音转写与文本纪要正常）；「写入待办」需
`dsh-memory-evolve` 插件（没装则按钮置灰，其他功能正常）。

## 主要改造记录

**界面 / 交互**
- 左侧三个大按钮：实时录音/录屏、录音转写、导入纪要；单行会议列表（每次录音一条，0 字不留空壳）
- 录音弹窗不设 Tab：点哪个入口只显示哪个功能；勾「同步录屏」先选屏幕
- 开始录音后不弹「会议进行中」白色弹窗：弹窗自动收起，Windows 直接由桌面浮窗（球 + 气泡）接管，
  其它平台用页面底部录音条；录音中再点入口只提示、不重复弹窗
- 浮窗「停止」按钮点击后立即切「停止中…」并禁用（命令要经心跳约 1 秒才生效），避免误以为没反应
- 浮窗气泡里可直接切换音频输入设备：只切换、不做电平检测；录音中切换会重开采集（会议 / 计时 / 转写不中断，
  有 1–2 秒采集空档），暂停中切换则在点「继续」时生效
- 详情页：封面区右上角集中「编辑信息 / AI 生成纪要 / 导出 HTML / 导出 Markdown / 删除」
- 新增「AI 会议纪要」卡片：固定高度、可展开收起、一键复制全文
- 决策只在「AI 会议纪要」卡片里展示（决策事项分组），详情页不再有单独的「决策清单」模块，避免重复
- 待办提取更稳：没写负责人/截止时间的行动项也会生成（字段留空）；首次纪要 0 待办时自动补抽一次
- 待办支持勾选后「弃用」（**从列表移除**、不写入待办，底部可「恢复全部弃用」），也可以只「重新生成待办」而不动纪要其它内容
- 写入 DSH 待办时带上负责人/截止/备注（不再只有标题），写入后提示去 DSH「待办」面板的「全部 / 工作」轨查看
- 首次使用会弹一次引导：① 下载本地转写模型或配置云端转写（可直接跳到设置）② 提示安装 dsh-memory-evolve（待办写入依赖），风格与插件一致
- 左侧/标题栏图标不再显示待办数字，只保留录音状态点
- Word 导出美化：深蓝标题 + 分隔线、居中的日期/参会人元信息、带底纹的「一句话结论」、彩色章节标题（关键要点 / 风险 / 决策 / 待办 / 原始转写）、表头底纹 + 隔行底纹的待办表格、原始转写自动另起一页
- 录屏「识别」按钮：点击后按钮右侧显示加载转圈，结果用行内小字提示（不再弹成功 toast）
- 原始转写卡片新增「整段重转写」：按 30 秒切片重新识别整场录音，修复实时 5 秒分片造成的
  碎片和漏字；按钮内显示进度（3/38 片），完成后自动刷新；新结果明显短于原转写时保留原文
- 启动自愈：历史会议若转写被覆盖成碎片、但分说话人分段还在，加载数据时自动用分段重建转写
  （实测一场 18 分钟会议从 19 字恢复到 4036 字 / 174 段）
- Toast 收敛：只保留必要提示（后台任务完成、复制/导出/写入待办、删除、错误/警告），
  去掉与界面状态重复的成功提示；同一条提示正在显示时不会重复堆叠
- 设置弹窗三页（模型配置 / 自动识别 / 问题反馈）统一成同一宽度（跟「问题反馈」页一致），
  切页时弹窗不再忽宽忽窄；宽屏下模型页的两列字段也更好填
- 结构化纪要升级为「详细版」（参考腾讯会议 / 通义听悟）：概述 400–800 字多段、章节速览带每章摘要、
  关键词、决策依据、风险应对建议、待确认问题、发言人总结；卡片可展开查看，Word/HTML/Markdown 同步导出
- 配色改为浅灰底 + 白卡片 + 浅蓝主题

**录音 / 转写**
- 会议室/多人远场收音建议（准确率的第一影响因素）：
  - 首选 **USB 全向会议麦克风**（放桌子中央，¥300–1000 级别即可明显好于笔记本内置麦）；
    会议室已有会议系统的，从调音台/会议主机 **line-out** 接电脑的 line-in 或 USB 声卡。
  - 临时方案：手机放桌面中央录音（自带降噪/阵列麦通常好于笔记本），会后用「录音转写」导入，
    或把录音放进「自动识别」的监控目录自动入库。
  - 外接麦时在 Windows 声音设置里关掉「音频增强/回声消除」（会议室外放时这两项会吞掉人声），
    并确认输入音量：说话时电平条应过 1/3。
  - 远场录音建议再开「整段重转写」与「转写纠错 + 术语表」；对准确率要求高时用云端转写。
- 空识别结果不再中断录音（后端返回 200 + 0 字，时长照计）
- 失败重试 + 连续失败才中断；静音约 20 秒提示；麦克风设备可选并记住
- 录音电平持续过低（约 15 秒）时提示一次：远场/小音量是转写准确率下降的主因
- 暂停＝停采集，同一场会议可继续
- 修复「Paraformer 本地引擎每个分片都报音频数据无效、整场录音中断」：
  根因是路由把音频按 `Uint8Array` 而非 `Buffer` 传给引擎；现在单分片解码失败
  按「没识别到」继续，太短的碎片不上送，只有真正的服务故障才会中断

**云端转写（科大讯飞 / 阿里云 / 腾讯云）**
- 设置页会明确显示「当前使用：xxx」；录音弹窗也会显示「本次转写引擎：xxx」，不会不知道在用的是哪个
- 「云端模型」里的厂商 Tab 只切换查看，不再点一下就直接换引擎；要换引擎请点「设为转写引擎」
- 腾讯云接入开发中，排在最后并标记「开发中」：凭据可先填，但暂时不能设为转写引擎
- 三家都是一句话识别接口：单次音频 ≤60 秒（腾讯云另限 3MB、阿里云 2MB）；
  文件转写会自动按 55 秒切片，超长音频不会直接发给云端
- 需要在设置里填对应密钥；未填完整就切到云引擎会明确提示缺哪个字段
- 协议层（签名 / 请求体 / 响应解析 / 错误码）已有离线集成测试；
  真实鉴权与识别结果需填入真实密钥后实测（会产生少量调用费用）
- 讯飞：修复 iat v2 协议格式、按 10ms/帧节流、等整段发完再结束，长音频不再被截断
- 阿里云：Token 缓存 24 小时、每次请求随机 SignatureNonce；接口报错会把服务端错误码/信息透出（如 FREE_TRIAL_EXPIRED）

**桌面浮窗（Windows）**
- 单窗口实现（球 + 气泡同窗口），球固定右下角；可拖动、记住位置
- 透明度 / 光圈居中 / 麦克风随音量缩放与光晕（参考腾讯会议）
- 停止后自动收浮窗；页面底部黑色录音条已移除；录音中自动收起白色弹窗

**自动识别（腾讯会议解析 + 自定义监控目录）**
- **默认关闭**：「腾讯会议解析」和「自定义监控目录」两个开关默认都不启用，新安装不会被自动导入的会议打扰；
  需要时到 设置 → 自动识别 手动打开
- 设置 → 自动识别 拆成两块，各自独立开关：
  - 「腾讯会议解析」：读取腾讯会议本地录制目录（可用「选择文件夹…」手动指定，Windows 默认探测
    「文档\\TencentMeeting」，扫描支持 3 层子目录）
  - 「自定义监控目录」：监控你指定的文件夹，新文件自动转写 / 导入
- Windows 上腾讯会议的 mp4/m4a 录制用 ffmpeg 转码后识别（不再依赖 macOS 的 afconvert）
- docx 纪要改为 Node 内置解压解析（不再依赖 /usr/bin/unzip），Windows 可直接导入

**问题反馈 / 关注与对话指引（设置页第 3 页）**
- 「问题反馈」页：公众号「PM的AI手记」扫码/搜一搜联合引导图**写死在插件里**
  （`resources/feedback-qr.png`，1816×624 横版），不支持用户上传/替换；图片缺失时显示
  占位图 `resources/feedback-qr-placeholder.png` 兜底
- 2 张引导图（`resources/guide-follow.png`、`guide-chat.png`）：怎么关注公众号（微信扫一扫 / 搜一搜
  「PM的AI手记」→ 点关注）、怎么在公众号里对话（点「发消息」→ 发问题/截图 → 等回复），点图看大图
- 常见问题速查（转写引擎、写入待办、自动识别、原文/导出）

**录屏 / 产物**
- 录音同屏录制：视频（屏幕画面 + 麦克风配音）+ 独立音频（WAV 16kHz）
- 结束后本机 ffmpeg 后台合成 **MP4（H.264 + AAC）**，临时文件自动清理（无 ffmpeg 时录屏不可用，只录音频）
- 文件落在 `~/.dsh/storages/meeting-minutes-media/<会议ID>/`，弹窗内可「在文件夹中显示」

**待办**
- 「写入任务日历」改为「写入待办」：写进 DSH 待办的**工作**轨（`TODOS-work.md`），
  复用 `dsh-memory-evolve` 的存储实现，格式与 `dtodo` 完全一致

## 注意

- `resources/meeting-orb.ps1` **必须保存为带 BOM 的 UTF-8**：Windows PowerShell 5.1 对无 BOM 文件
  按 ANSI 解码，中文注释会破坏语法。
- 插件的 `node_modules` 安装目录会被 `dsh plugin add` 等操作整体覆盖；覆盖后重新
  `node deploy.mjs` 即可恢复全部改动（备份在 `backups/`）。
- 本工程独立存放、单独 git 管理；发布前注意：`backups/`、`docs/` 里的示例与截图可能含真实会议内容，不要一起打包。`git` 历史里仍有旧的 `src/README-upstream.md`，对外发布建议重写历史或只发布代码快照。

## 许可

MIT 许可，授权文本见仓库根目录 `LICENSE`（插件包内的为 `src/LICENSE`，随包分发）。
本插件为 **DinosaurYSL** 的**自研版本**。





