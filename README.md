# Codex Task Notify

Codex Task Notify 是一个本地任务通知系统，目标是解决 Codex 长任务、多窗口并发时必须反复手动查看会话状态的问题。它会监听本机 session `.jsonl` 文件，在任务完成后，把通知发到 VS Code、Windows 桌面和 Bark 手机推送。

当前实现同时支持：

- VS Code 扩展模式
- CLI daemon 模式
- 共用一套底层 runtime / watcher / notification 逻辑

## 当前能力

- 识别 `task_complete`
- 在任务通知中附带本次任务 token 消耗
- 支持 VS Code 内置弹窗
- 支持 Windows 桌面通知
- 支持 Bark iPhone 推送
- 支持 Bark AES-256-GCM 加密、分组、角标、铃声、自定义图标、自动保存
- 支持 thread 持久化重命名
- 支持手动把任意 `.jsonl` 文件加入热查询队列
- 支持查看当前热查询队列
- 支持查看最近 7 天手动加入热查询的 session
- 支持查询当前 5h / 7d 限额快照
- 支持低限额主动提醒
- 支持用户自定义 5h / 7d 低限额提醒阈值

## 当前架构

核心代码位于 `src/shared`，CLI 和 VS Code 扩展共用同一套 runtime。

### 1. 会话发现

- 启动时扫描 `sessionsRoot`，建立未归档 session 索引
- 同时扫描 `archived_sessions`，建立已归档索引
- 使用 `fs.watch` 监听当天 session 目录
- 当天有新 `.jsonl` 出现时，立刻加入热查询队列
- 使用 `fs.watch` 监听 `archived_sessions`
- 发现 session 被归档后，立刻从冷热队列移除

### 2. 冷热查询

- 冷查询：默认每 `30000ms` 扫描一次所有未归档 session，只检查文件大小和修改时间
- 冷查询发现变化时，把对应 session 推入热查询队列
- 热查询：默认每 `5000ms` 扫描一次热队列，只在文件变化时继续解析 JSONL
- 当天目录除了依赖 `fs.watch`，还会做短延迟补扫和周期轻扫，避免单次事件漏接

### 3. 事件解析

- 完成通知依赖 `task_complete`
- token 与限额快照走独立的 usage 解析链路
- `src/shared/usage.ts` 负责把 provider-specific 的使用量事件归一化
- 当前已接入 Codex 的 `token_count`
- 对 Codex 会优先使用 `total_token_usage` 与 turn 基线做差，避免重复累加 `last_token_usage`
- 后续如果扩展到 Claude Code 或 API 用户，只需要新增 usage / trigger adapter，不需要改通知层

### 4. 限额提醒

- watcher 在解析 `token_count` 时会顺手得到 `rate_limits`
- runtime 直接复用这条已有链路做阈值判断，不新增任何扫描
- 限额扫描、阈值配置、提醒通知三层逻辑彼此解耦
- 当前默认规则：
  - 5h 剩余额度 `<= 10%` 时提醒
  - 7d 剩余额度 `<= 5%` 时提醒
- 跨过阈值时只提醒一次；如果额度恢复到阈值以上，再次跌破时会重新提醒

## 通知内容

### 任务完成通知

正文格式：

```text
任务“Thread Name”已完成，用时xxx，消耗token为xxx
```

说明：

- VS Code 弹窗和 Bark 正文会直接带 thread 名
- Windows 桌面通知通常把 thread 名放在标题里，正文显示“任务已完成，用时xxx，消耗token为xxx”

### 限额主动提醒

标题：

```text
Codex限额警告
```

正文格式：

```text
您的Codex 5h额度只剩xxx
您的Codex 7d额度只剩xxx
```

补充：

- Bark 的限额提醒会使用单独的铃声，默认 `horn`
- Bark 的限额提醒图标单独配置，默认留空
- 任务通知与限额提醒互不影响

## 余额展示

5h 和 7d 限额不会塞进任务完成通知里，而是单独展示：

- VS Code 状态栏有 `Check Balance` 按钮
- CLI 与扩展都支持 `check balance`
- 终端不会主动持续打印限额，只在你手动调用命令时输出

## 项目结构

```text
.
├─ assets/icons/           # 扩展图标、Bark 图标资源
├─ docs/internal/          # 本地内部文档，默认不提交
├─ releases/vsix/          # 打包后的 VSIX
├─ scripts/                # 打包脚本
├─ src/
│  ├─ daemon.ts            # CLI 入口
│  ├─ extension.ts         # VS Code 扩展入口
│  ├─ latencyProbe.ts      # 延迟探针
│  ├─ shared/
│  │  ├─ bark.ts
│  │  ├─ config.ts
│  │  ├─ format.ts
│  │  ├─ notifications.ts
│  │  ├─ quotaAlerts.ts    # 限额阈值判定层
│  │  ├─ runtime.ts
│  │  ├─ sessionWatcher.ts
│  │  ├─ store.ts
│  │  ├─ types.ts
│  │  └─ usage.ts          # token / balance 归一化层
│  └─ test/smoke.ts
├─ tools/
├─ .env.example
├─ package.json
└─ tsconfig.json
```

## 安装与构建

安装依赖：

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

## 配置

共享配置文件默认位置：

```text
%USERPROFILE%\.codex-task-notify\config.json
```

同时支持 `.env` 覆盖敏感配置。仓库只提交 `.env.example`，真实 `.env` 已加入 `.gitignore`。

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

CODEX_TASK_NOTIFY_QUOTA_ALERTS_ENABLED=true
CODEX_TASK_NOTIFY_TRIGGER_5H_REMAINING_PERCENT=10
CODEX_TASK_NOTIFY_TRIGGER_7D_REMAINING_PERCENT=5
CODEX_TASK_NOTIFY_QUOTA_ALERT_BARK_SOUND=horn
# CODEX_TASK_NOTIFY_QUOTA_ALERT_BARK_ICON_URL=
```

补充说明：

- `.env` 优先级高于 `config.json`
- 如果设置了 `CODEX_TASK_NOTIFY_ENV`，程序会优先读取该路径
- 当前版本兼容“整份 `.env` 被误压成一行”的情况，会在启动时自动拆回多行

## CLI 使用

启动 daemon：

```powershell
npm run start:daemon
```

启动后可输入以下命令：

```text
restart
stop
continue
quit
check balance
set trigger
add
rename
clear_name
show
show_last
help
```

命令说明：

- `restart`：关闭并重新开始监视
- `stop`：停止监视
- `continue`：继续开始监视
- `quit`：退出程序
- `check balance`：查询当前最新 5h / 7d 限额快照
- `set trigger`：设置 5h / 7d 低限额提醒阈值
- `add`：手动添加一个 `.jsonl` 到热查询队列
- `rename`：给 thread 重命名
- `clear_name`：清除所有手动重命名
- `show`：展示当前热查询队列
- `show_last`：展示最近 7 天手动加入热查询的 session
- `help`：显示命令列表

## VS Code 扩展使用

扩展激活后会创建输出面板：

```text
Codex Task Notify
```

### 命令面板命令

```text
Codex Task Notify: Start Monitoring
Codex Task Notify: Stop Monitoring
Codex Task Notify: restart
Codex Task Notify: continue
Codex Task Notify: quit
Codex Task Notify: check balance
Codex Task Notify: set trigger
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

### 状态栏按钮

当前默认保留四个交互入口：

- `Codex On / Off`
- `Check Balance`
- `Set Trigger`
- `Rename Thread`

说明：

- `Codex On / Off`：一键启动或停止监视
- `Check Balance`：查看当前最新的 5h / 7d 剩余额度快照
- `Set Trigger`：设置 5h / 7d 低限额提醒阈值
- `Rename Thread`：给 thread 设置持久化自定义名称

其他功能入口如 `add`、`show`、`show_last` 仍可通过命令面板调用。

## Bark 推送

任务通知标题固定为：

```text
codex
```

限额提醒标题固定为：

```text
Codex限额警告
```

支持字段：

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

- `CODEX_TASK_NOTIFY_BARK_ENCRYPTION_KEY` 必须是 32 字符
- `CODEX_TASK_NOTIFY_BARK_ENCRYPTION_IV` 必须是 12 字符
- `icon` 应使用稳定直链图片地址

## 打包 VSIX

```powershell
npm run package:vsix
```

输出目录：

```text
releases/vsix/
```

文件名格式：

```text
codex-task-notify-{version}.vsix
```

## 延迟调试

项目内置两个辅助工具：

```text
src/latencyProbe.ts
tools/trace-watcher-change.js
```

用于定位：

- `task_complete` 写入时间
- watcher 发现文件变化的时间
- 最终通知发出的时间

历史排查结论是：`task_complete` 本身通常写得很快，真正容易出现随机高延迟的是“新会话发现”和“文件变化发现”阶段，所以当前版本保留了 `fs.watch + 热查询补扫 + 冷热轮转` 的组合方案。

## 已知限制

- Windows 文件系统事件不是严格实时、严格不丢失的，所以当天目录除了 `fs.watch` 外还需要补扫兜底
- 已归档 session 当前是通过进入 `archived_sessions` 被识别，而不是依赖原 `.jsonl` 内部的 `archived` 字段
- 当前余额快照来源于 Codex session 日志中的 `token_count.rate_limits`
- 如果未来接入 Claude Code 或 API 用户，需要新增对应 usage / trigger adapter；提醒逻辑本身可以复用

## 开发命令

```powershell
npm run build
npm run smoke
npm run start:daemon
npm run package:vsix
```

## License

MIT
