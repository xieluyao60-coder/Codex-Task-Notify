# Codex Task Notify

Codex Task Notify 是一个面向 Codex 长耗时任务的本地通知系统。它监听 Codex 写入的 session `.jsonl` 文件，在检测到 `task_complete` 事件后，把“任务完成”消息分发到 VS Code 弹窗、Windows 桌面通知和 Bark 手机推送。

这个项目的目标很明确：当多个 Codex 任务在多个窗口并发执行时，不需要反复人工检查窗口，而是在任务完成时主动通知用户。

## 功能概览

- 监听 `~/.codex/sessions` 下的 Codex session JSONL 文件。
- 识别 `task_complete` 事件并提取 thread 名称、任务状态、耗时、摘要等信息。
- 支持 VS Code 扩展和 CLI daemon 两种启动方式。
- 支持 VS Code 内置弹窗、Windows 桌面 toast、Bark iPhone 推送。
- 支持 Bark AES-256-GCM 加密推送、铃声、分组、角标、通知保存、自定义图标。
- 支持手动将指定 `.jsonl` session 加入热查询队列。
- 支持持久化 thread 重命名，通知优先使用用户自定义名称。
- 支持查看热查询队列和最近一周手动加入热查询的 session。
- VS Code 扩展默认只保留 `Codex On` 与 `Rename Thread` 两个状态栏入口，其余操作走命令面板。

## 当前架构

核心逻辑位于 `src/shared`，CLI 和 VS Code 扩展共用同一套 runtime。

当前监视策略是冷热队列加归档发现器：

1. 启动时扫描 `sessionsRoot` 和同级的 `archived_sessions`，把未归档 session 写入冷查询队列，并把归档状态持久化到 state。
2. 使用 `fs.watch` 监视当天日期的 session 目录；当天有新 `.jsonl` 文件出现时，立即加入热查询队列。
3. 为避免单次 create/change 事件被遗漏，当天目录还会在事件触发后做一次短延迟补扫，并按热查询周期持续轻量补扫。
4. 使用 `fs.watch` 监视 `archived_sessions`；发现归档文件后，把对应 session 从冷热队列移除，并更新归档索引。
5. 冷查询队列默认每 `30000ms` 检查一次未归档文件的大小和修改时间；发生变化时，将其加入热查询队列。
6. 热查询队列默认每 `5000ms` 检查一次文件变化；只有文件发生变化时，才继续读取 JSONL 并解析 `task_complete`。
7. 已通知过的事件会写入本地 state，避免重复通知。

历史测试中，单纯依赖文件系统 change 事件在 Windows 上存在随机高延迟，所以当前版本保留了热查询兜底机制。

## 项目结构

```text
.
├─ assets/icons/           # 项目图标和 Bark 推送图标素材
├─ docs/internal/          # 本地交接文档，默认不提交
├─ releases/vsix/          # 已打包的 VS Code 扩展包
├─ scripts/                # 打包脚本
├─ src/
│  ├─ daemon.ts            # CLI daemon 入口
│  ├─ extension.ts         # VS Code 扩展入口
│  ├─ latencyProbe.ts      # 延迟探测工具
│  ├─ shared/              # 共享 runtime、配置、通知、Bark、watcher
│  └─ test/smoke.ts        # smoke test
├─ tools/                  # 调试/追踪脚本
├─ .env.example            # 环境变量模板
├─ package.json
└─ tsconfig.json
```

## 安装依赖

```powershell
npm install
```

构建：

```powershell
npm run build
```

运行 smoke test：

```powershell
npm run smoke
```

## 配置方式

程序默认会读取共享配置文件：

```text
%USERPROFILE%\.codex-task-notify\config.json
```

同时也支持 `.env` 覆盖敏感配置。仓库只提交 `.env.example`，真实 `.env` 已加入 `.gitignore`，不要提交。

创建本地 `.env`：

```powershell
Copy-Item .env.example .env
```

常用环境变量：

```dotenv
CODEX_TASK_NOTIFY_SESSIONS_ROOT=C:\Users\YOUR_NAME\.codex\sessions
CODEX_TASK_NOTIFY_STATE_FILE_PATH=C:\Users\YOUR_NAME\.codex-task-notify\state.json
CODEX_TASK_NOTIFY_COLD_POLL_INTERVAL_MS=30000
CODEX_TASK_NOTIFY_HOT_POLL_INTERVAL_MS=5000
CODEX_TASK_NOTIFY_HOT_SESSION_IDLE_MS=7200000

CODEX_TASK_NOTIFY_DESKTOP_ENABLED=true
CODEX_TASK_NOTIFY_DESKTOP_SOUND=false

CODEX_TASK_NOTIFY_BARK_ENABLED=false
CODEX_TASK_NOTIFY_BARK_SERVER_URL=https://api.day.app
CODEX_TASK_NOTIFY_BARK_DEVICE_KEY=your-bark-device-key
CODEX_TASK_NOTIFY_BARK_SOUND=multiwayinvitation
CODEX_TASK_NOTIFY_BARK_ARCHIVE=true
CODEX_TASK_NOTIFY_BARK_ICON_URL=https://example.com/icon.png
CODEX_TASK_NOTIFY_BARK_ENCRYPTION_ENABLED=true
CODEX_TASK_NOTIFY_BARK_ENCRYPTION_KEY=12345678901234567890123456789012
CODEX_TASK_NOTIFY_BARK_ENCRYPTION_IV=123456789012
```

`.env` 的优先级高于 `config.json`。如果设置了 `CODEX_TASK_NOTIFY_ENV`，程序会优先从该路径读取环境变量文件。

兼容性说明：

- 当前版本会自动兼容“整份 `.env` 被误压成一行”的情况，只要键名仍然是 `CODEX_TASK_NOTIFY_*=`，加载器会在启动时自动拆回多行。
- 如果扩展启动后完全没有任何通知，优先检查 `.env` 是否损坏，以及 `Codex Task Notify` 输出面板里是否有 watcher 启动日志。

## CLI 使用

启动 daemon：

```powershell
npm run start:daemon
```

启动后可在终端输入以下命令：

```text
restart    关闭并重新开始监视
stop       停止监视
continue   继续开始监视
quit       退出程序
add        添加需要热查询监视的 .jsonl 文件
rename     给 thread 重新命名
clear_name 清除所有 thread 重命名
show       展示当前热查询队列
show_last  展示最近一周手动加入热查询的 session
help       列出所有可用命令
```

`add` 支持直接输入 `.jsonl` 路径。加入后，该 session 会进入热查询队列。

## VS Code 扩展使用

扩展激活后会创建输出面板：

```text
Codex Task Notify
```

扩展命令：

```text
Codex Task Notify: Start Monitoring
Codex Task Notify: Stop Monitoring
Codex Task Notify: restart
Codex Task Notify: continue
Codex Task Notify: quit
Codex Task Notify: add
Codex Task Notify: Monitor Current Session
Codex Task Notify: Choose Session to Monitor
Codex Task Notify: Open Shared Config
Codex Task Notify: Show Recent Events
Codex Task Notify: rename
Codex Task Notify: clear_name
Codex Task Notify: show
Codex Task Notify: show_last
Codex Task Notify: help
```

扩展状态栏按钮：

```text
Codex On / Off    单按钮启动或停止监视
Rename Thread     给 thread 设置持久自定义名称
```

为降低干扰，`Watch Current`、`Choose Session` 等入口已经从状态栏隐藏，但仍可通过命令面板调用。

目前 VS Code 不提供稳定 API 让一个扩展直接读取另一个 Codex 扩展 Webview 当前打开的 thread。因此手动选择 session 的策略仍然是：

1. 如果当前编辑器打开的是 `.jsonl`，直接加入该文件。
2. 否则选择 `sessionsRoot` 下最近写入的 `.jsonl`。
3. 如果不确定，使用 `Choose Session` 手动选择。

## 通知内容

默认通知标题和正文会优先使用 thread 名称。

Bark 推送标题固定为：

```text
codex
```

Bark 推送正文格式：

```text
任务{Thread Name}已完成，用时{duration}
```

如果原始 thread 名称包含 VS Code 自动注入的上下文前缀，例如 `# Context from my IDE setup`，程序会尽量清洗，只保留真实用户请求内容。

## Bark 推送说明

Bark 推送实现位于 `src/shared/bark.ts`。

已支持字段：

- `title`
- `body`
- `sound`
- `group`
- `badge`
- `isArchive`
- `icon`
- `ciphertext`
- `iv`

加密方式：

```text
AES-256-GCM
```

约束：

- `CODEX_TASK_NOTIFY_BARK_ENCRYPTION_KEY` 必须是 32 个字符。
- `CODEX_TASK_NOTIFY_BARK_ENCRYPTION_IV` 必须是 12 个字符。
- Bark 图标 URL 应使用稳定的直链图片地址，避免使用会过期的跳转链接。

## 打包 VSIX

打包命令：

```powershell
npm run package:vsix
```

输出目录：

```text
releases/vsix/
```

输出文件名格式：

```text
codex-task-notify-{version}.vsix
```

历史包目前保留在 `releases/vsix`，便于回滚和安装测试。

## 延迟调试

项目包含两个辅助工具：

```text
src/latencyProbe.ts
tools/trace-watcher-change.js
```

它们用于定位：

- Codex 写入 `task_complete` 的时间
- watcher/change 事件触发时间
- 监视系统解析并通知的时间

历史结论是：Codex 写入 `task_complete` 通常很快，主要风险在于“如何及时发现哪个 session 文件发生了变化”。

## 已知限制

- Windows 文件系统事件在长时间运行和递归监听场景下可能出现随机延迟；当前版本只在“当天 session 目录”和 `archived_sessions` 两个低层级目录使用 `fs.watch`，并为当天目录增加了补扫兜底。
- 已归档 Codex 会话目前更像是移动到 `.codex/archived_sessions`，不是在原 session 文件中写入 `archived` 字段。
- 冷查询会覆盖所有未归档 session；如果未归档历史 session 很多，`CODEX_TASK_NOTIFY_COLD_POLL_INTERVAL_MS` 可以适当调大。

## 开发命令

```powershell
npm run build
npm run smoke
npm run start:daemon
npm run package:vsix
```

## 许可证

MIT
