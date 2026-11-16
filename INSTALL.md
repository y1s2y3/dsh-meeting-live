# 安装与使用（给使用者）

> 本插件是 DSH Desktop（DeepSeek Harness）的「会议纪要」插件：录音/录屏 → 实时转写 → AI 结构化纪要 → 待办 → 导出。
> 只想安装使用、不参与开发的话，看这一个文件就够了。

## 一、环境前提

| 前提 | 是否必须 | 说明 |
| :-- | :-- | :-- |
| DSH Desktop | 必须 | ≥ 2.0.17（插件加载器版本要求） |
| Windows 10 / 11 | 推荐 | 桌面浮窗、腾讯会议目录解析、录屏在 Windows 上最完整；其他平台可用部分功能 |
| ffmpeg | 可选但建议 | 录屏、腾讯会议录制（mp4/m4a）自动转写、在对话里转写本地音视频需要；不装不影响录音、实时转写、文本纪要 |
| `dsh-memory-evolve` | 可选 | 「写入待办」需要；没装则该按钮置灰，其他功能正常 |
| 麦克风 | 实时录音需要 | 会议室建议接 USB 全向会议麦克风，笔记本内置麦在 3 人以上、2 米外基本不可用 |

## 二、安装

### 2.1 方式一：下载发布包安装（推荐）

1. 在 [GitHub Releases](https://github.com/y1s2y3/dsh-meeting-live/releases) 下载 `dsh-meeting-live-<版本>.tgz`（附带的 `安装说明-<版本>.md` 里有同样的步骤）。
2. 解压 tgz，得到 `dsh-meeting-live/` 目录；把它复制到
   `%USERPROFILE%\.dsh\profiles\desktop\node_modules\` 下（最终路径为
   `...\node_modules\dsh-meeting-live\`）。
3. 编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：
   - 在 `dependencies` 里加一行：`"dsh-meeting-live": "<版本号>"`
   - 在 `dsh.profile.bundles` 数组里加：`"dsh-meeting-live"`
4. **完全退出并重启 DSH Desktop**（不是刷新页面，是退出应用后重开）。
5. 左侧栏出现「会议纪要」图标即安装成功。

### 2.2 方式二：桌面端插件页

如果当前 DSH 版本的「插件」页支持**从本地文件安装**，可以直接选择下载好的 tgz；
如果只能安装在线包/市场插件，请按 2.1 手工安装。

### 2.3 方式三：从源码安装（开发者）

```powershell
git clone https://github.com/y1s2y3/dsh-meeting-live.git
cd <仓库目录>
node deploy.mjs        # 自动备份线上版本并复制到 desktop profile
```

改代码后同样用 `node deploy.mjs` 部署；界面改动刷新页面即可，宿主侧改动需要重启 Desktop。

## 三、首次使用

1. 打开左侧「会议纪要」：首次引导会检查本地模型与依赖。
2. **准备转写模型**：下载本地 Paraformer 模型（约 245 MB，离线识别、音频不出本机），或到「设置 → 模型配置」填写云端转写密钥（讯飞 / 阿里云）。
3. **可选：安装 ffmpeg**（首次引导第 3 步会检测并给出命令）：
   ```powershell
   winget install Gyan.FFmpeg
   ```
   装完重启 DSH Desktop。也可以用已有的 ffmpeg：放进 PATH 或设置环境变量 `FFMPEG_PATH`。
4. **可选：安装 `dsh-memory-evolve`**，安装后才能一键「写入待办」。
5. 点「实时录音/录屏」说几句话确认出字；结束时点「AI 生成纪要」，确认待办后「写入待办」。

## 四、升级与卸载

- **检查新版本**：插件内「设置 → 问题反馈 → 版本与更新 → 检查更新」可查看是否有新版本（只提示，不自动安装）；
  有新版本时点「下载」打开 Releases 页面。
- **升级**：完全退出 DSH Desktop → 用新版本覆盖 `node_modules\dsh-meeting-live\` → 重启。
- **卸载**：删除 `node_modules\dsh-meeting-live\`，并从 profile 的 `package.json` 里删掉
  `dependencies`、`dsh.profile.bundles` 中的 `dsh-meeting-live`，然后重启。
- **数据不会自动删除**：会议数据与录音在本机
  `%USERPROFILE%\.dsh\storages\meeting-minutes.json` 和 `meeting-minutes-media\` 下，
  需要清理时手动删除。

## 五、数据与隐私（摘要）

- 默认本地识别，**音频不出本机**；只有切到云端转写时音频才会上传对应厂商。
- 会议总结会把转写文本发给你配置的模型接口（DSH 默认模型或自填的 OpenAI 兼容接口）。
- 云端密钥与会议数据明文保存在本机用户目录，公用电脑不建议填写；建议开启磁盘加密。
- **录音/录屏前请先告知参会人并取得同意**；涉密会议请只用本地模型，不要切云端转写。

## 六、常见问题

- **没装 ffmpeg**：录屏不可用（只录音频）、腾讯会议 mp4/m4a 与监控目录非 WAV 音视频无法自动转写；实时录音转写、页面导入、文本纪要不受影响。
- **「写入待办」按钮是灰的**：装并启用 `dsh-memory-evolve`。
- **腾讯会议录完没自动识别**：设置 → 自动识别 → 打开腾讯会议解析并确认录制目录；只导入 14 天内新录制。
- **模型下载失败**：网络受限时重试，或改用云端转写（设置 → 模型配置 → 云端模型）。
- **更多问题**：见插件内「设置 → 问题反馈」，或仓库 README 的常见问题章节。

## 七、许可与来源

MIT 许可，授权文本见仓库根目录 `LICENSE`（插件包内为 `LICENSE`）。
本地识别模型的来源与各自许可见插件 README 第 9.1 节。
