# Codex Task Notify

把 Codex 任务丢出去，然后放心去做别的事。

Codex Task Notify 是一个面向 Codex 长耗时任务的本地通知工具。它会监听 Codex 在本机写入的 session 文件，一旦检测到任务完成，就立即通过 VS Code 弹窗、Windows 桌面通知或 Bark iPhone 推送提醒你。

它解决的是一个很具体的问题：Codex 任务经常需要跑很久，尤其是多个任务并发执行时，你不应该一直盯着窗口、反复切回来确认结果。启动 Codex Task Notify 后，你可以继续写代码、最小化 VS Code、切到其他窗口，甚至去刷手机；任务完成时它会主动提醒你。

## 适合什么场景

你可以用三种方式把任务交给 Codex：

| 使用路径 | 适合场景 | 推荐通知方式 |
| --- | --- | --- |
| IDE 扩展 | 主要在 VS Code / IDE 中使用 Codex，希望整个过程自动化 | VS Code 内置弹窗 + Windows 桌面通知 |
| CLI | 用终端跑 Codex，或希望以 daemon 方式长期监视 | Windows 桌面通知 + Bark |
| Codex 桌面版 | 把任务交给 Codex 桌面版后切走做别的事 | Windows 桌面通知 + Bark |

支持三条通知路径：

| 通知路径 | 适合场景 |
| --- | --- |
| VS Code 内置消息弹窗 | 你还在 VS Code 中工作，或者同时开了多个 Codex 任务，需要知道哪个 thread 完成了。 |
| Windows 桌面通知 | 你把 VS Code 最小化，或者切到浏览器、文档、其他软件继续工作。 |
| Bark iPhone 推送 | 你离开电脑，或者真的想去刷抖音、看手机。 |

## 核心亮点

- **与 Codex 上层入口解耦**：只依赖本机底层 session `.jsonl` 文件，不依赖 Codex CLI、IDE 扩展或桌面版的 UI 状态，也不和个人账号绑定。
- **稳定可靠**：只要 Codex 正常把 session 写到本机，通知系统就能基于文件变化检测任务完成。
- **低延迟**：任务完成后通常 1 秒内触发通知。
- **低开销**：在保持低延迟的同时，监视内核开销接近 0。
- **无感使用**：作为 VS Code 扩展使用时，会自动选择和监视 thread，用户几乎不需要手动干预。
- **配置简单**：默认配置即可使用；不开手机推送时，基本无需额外配置。

## 当前限制

- 当前主要支持 **Windows**。
- 手机推送当前按 **iPhone + Bark** 方案设计。
- Android、macOS、Linux 暂未作为主要支持目标。

## 快速开始

### 方式一：VS Code 扩展使用，推荐

这是最推荐的方式。适合你在 VS Code 或其他基于 VS Code 的 IDE 中使用 Codex。

1. 打开 VS Code。
2. 进入左侧 **Extensions / 扩展** 面板。
3. 搜索：

```text
Codex Task Notify
```

4. 点击安装。
5. 安装后扩展会自动启动监视。
6. 之后你可以正常把任务交给 Codex，然后切去做其他事情。

如果你使用的是本地 `.vsix` 包，也可以通过 VS Code 命令面板安装：

```text
Extensions: Install from VSIX...
```

然后选择 `releases/vsix/` 目录下的 `codex-task-notify-*.vsix` 文件。

### 方式二：CLI daemon 使用

适合你主要用命令行，或者希望单独开一个后台监视进程。

先安装依赖并启动 daemon：

```powershell
npm install
npm run start:daemon
```

启动后，CLI 会开始监视 Codex session 目录。你可以继续在其他终端、IDE 或 Codex 桌面版中运行任务。

常用交互命令：

```text
restart     重启监视
stop        暂停监视
continue    继续监视
quit        退出程序
add         手动添加一个 .jsonl session 文件到热监视队列
rename      给 thread 设置自定义名称
clear_name  清除所有自定义 thread 名称
show        查看当前热监视队列
show_last   查看最近 7 天手动添加过的 session
help        查看命令帮助
```

`add` 适合在自动识别不够明确时使用。输入 `.jsonl` 文件路径后，该 session 会立即进入热监视队列。

### 方式三：配合 Codex 桌面版使用

Codex Task Notify 不需要接入 Codex 桌面版 UI。只要 Codex 桌面版把任务 session 写入本机 `.codex/sessions` 目录，本工具就可以从底层 session 文件识别任务完成事件。

推荐做法：

1. 先启动 VS Code 扩展或 CLI daemon。
2. 在 Codex 桌面版中提交任务。
3. 直接切去做其他事情。
4. 任务完成后，通过 Windows 桌面通知或 Bark iPhone 推送收到提醒。

## 三种通知方式怎么配置

### 1. VS Code 内置消息弹窗

VS Code 弹窗只在使用扩展模式时生效。默认开启。

扩展安装后，它会在 VS Code 中弹出 Codex 任务完成消息。这个方式最适合你仍然在 VS Code 里写代码，或者打开了多个 Codex 任务并发执行的情况。

可以在 VS Code 设置中搜索：

```text
Codex Task Notify
```

常用设置：

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `codexTaskNotify.autoStart` | `true` | VS Code 启动后自动开始监视。 |
| `codexTaskNotify.enableIdePopup` | `true` | 是否显示 VS Code 内置弹窗。 |
| `codexTaskNotify.promptForSessionAlias` | `true` | 新 thread 完成时，是否提示给 thread 起一个自定义名称。 |
| `codexTaskNotify.maxRecentEvents` | `20` | 最近通知事件保留数量。 |

#### 两个交互按键

当一个新的 Codex thread 第一次完成时，扩展会弹出命名提示：

```text
New Codex thread: xxx
```

你会看到两个交互按键：

| 按键 | 用途 |
| --- | --- |
| `Rename` | 给这个 thread 起一个更容易识别的名字，之后通知会优先使用这个名字。 |
| `Keep Auto Name` | 保留自动识别出的 thread 名称，不手动命名。 |

这对多任务并发很有用。比如你同时让 Codex 修 bug、写 README、跑测试，手动命名后通知会更清楚。

#### 状态栏按钮

扩展会在 VS Code 状态栏提供几个快捷按钮：

| 按钮 | 作用 |
| --- | --- |
| `Codex Start` / `Codex On` | 开始或继续监视。 |
| `Codex Pause` / `Codex Stopped` | 暂停监视。 |
| `Watch Current` | 监视当前打开的 `.jsonl` 文件；如果当前没有打开 `.jsonl`，会尝试选择最近写入的 Codex session。 |
| `Choose Session` | 从最近 session 列表中手动选择一个要监视的 session。 |
| `Rename Thread` | 给已有 thread 设置持久自定义名称。 |

#### 命令面板命令

按 `Ctrl + Shift + P` 打开命令面板，搜索 `Codex Task Notify` 可以看到命令：

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

最常用的是：

| 命令 | 作用 |
| --- | --- |
| `Start Monitoring` | 开始监视。 |
| `Stop Monitoring` | 暂停监视。 |
| `Monitor Current Session` | 将当前 session 加入监视。 |
| `Choose Session to Monitor` | 手动选择 session。 |
| `Open Shared Config` | 打开共享配置文件。 |
| `Show Recent Events` | 查看最近通知记录。 |
| `rename` | 给 thread 改名。 |
| `show` | 查看当前热监视队列。 |

### 2. Windows 桌面通知

Windows 桌面通知默认开启。适合你把 VS Code 最小化、切到浏览器、文档或其他软件时使用。

默认配置文件路径：

```text
%USERPROFILE%\.codex-task-notify\config.json
```

默认配置中桌面通知已经启用：

```json
{
  "desktop": {
    "enabled": true,
    "sound": false
  }
}
```

如果你想关闭桌面通知，把 `enabled` 改成 `false`：

```json
{
  "desktop": {
    "enabled": false,
    "sound": false
  }
}
```

也可以用环境变量覆盖：

```dotenv
CODEX_TASK_NOTIFY_DESKTOP_ENABLED=true
CODEX_TASK_NOTIFY_DESKTOP_SOUND=false
```

### 3. Bark iPhone 推送

Bark 用于把 Codex 任务完成消息推送到 iPhone。适合你离开电脑，或者希望任务完成后手机也能收到提醒。

#### 第一步：安装 Bark

1. 在 iPhone 上安装 Bark。
2. 打开 Bark，复制你的 Bark device key。
3. 默认服务地址通常是：

```text
https://api.day.app
```

#### 第二步：打开配置文件

如果你使用 VS Code 扩展，可以直接执行：

```text
Codex Task Notify: Open Shared Config
```

也可以手动打开：

```text
%USERPROFILE%\.codex-task-notify\config.json
```

#### 第三步：填写 Bark 配置

把 `bark.enabled` 改成 `true`，并填入你的 `deviceKey`：

```json
{
  "bark": {
    "enabled": true,
    "serverUrl": "https://api.day.app",
    "deviceKey": "你的 Bark device key",
    "sound": "multiwayinvitation",
    "isArchive": true,
    "encryption": {
      "enabled": false,
      "key": "",
      "iv": ""
    }
  }
}
```

保存后重启监视即可：

- VS Code 扩展：执行 `Codex Task Notify: restart`
- CLI：输入 `restart`

#### 可选：Bark 加密推送

如果你要使用 Bark 加密推送，可以开启 AES-256-GCM 加密：

```json
{
  "bark": {
    "enabled": true,
    "serverUrl": "https://api.day.app",
    "deviceKey": "你的 Bark device key",
    "encryption": {
      "enabled": true,
      "key": "12345678901234567890123456789012",
      "iv": "123456789012"
    }
  }
}
```

注意：

- `key` 必须是 32 个字符。
- `iv` 必须是 12 个字符。
- Bark 客户端侧也需要使用一致的加密配置。

也可以使用环境变量：

```dotenv
CODEX_TASK_NOTIFY_BARK_ENABLED=true
CODEX_TASK_NOTIFY_BARK_SERVER_URL=https://api.day.app
CODEX_TASK_NOTIFY_BARK_DEVICE_KEY=your-bark-device-key
CODEX_TASK_NOTIFY_BARK_SOUND=multiwayinvitation
CODEX_TASK_NOTIFY_BARK_ARCHIVE=true
CODEX_TASK_NOTIFY_BARK_ENCRYPTION_ENABLED=false
CODEX_TASK_NOTIFY_BARK_ENCRYPTION_KEY=
CODEX_TASK_NOTIFY_BARK_ENCRYPTION_IV=
```

## 共享配置

Codex Task Notify 默认会自动创建配置文件：

```text
%USERPROFILE%\.codex-task-notify\config.json
```

关键字段：

| 字段 | 说明 |
| --- | --- |
| `sessionsRoot` | Codex session 文件目录，默认是 `%USERPROFILE%\.codex\sessions`。 |
| `stateFilePath` | 本地状态文件路径，用于记录已通知事件、thread 改名等信息。 |
| `desktop.enabled` | 是否启用 Windows 桌面通知。 |
| `bark.enabled` | 是否启用 Bark 手机推送。 |
| `hotPollIntervalMs` | 热监视检查间隔，默认 5000ms。 |
| `coldPollIntervalMs` | 冷队列检查间隔，默认 30000ms。 |

通常不需要手动修改 `sessionsRoot`。只有在你的 Codex session 目录不在默认位置时才需要改。

## 本地开发

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

启动 CLI daemon：

```powershell
npm run start:daemon
```

打包 VSIX：

```powershell
npm run package:vsix
```

输出目录：

```text
releases/vsix/
```

## 工作原理，简版

Codex Task Notify 的核心逻辑并不依赖 Codex 的 UI，而是监听 Codex 写入本机的 session `.jsonl` 文件。

当 Codex 任务完成时，session 文件中会出现任务完成事件。Codex Task Notify 会检测这些文件变化，解析完成事件，然后把通知分发到已启用的通知通道。

这也是它能同时支持 CLI、IDE 扩展和 Codex 桌面版的原因：只要底层 session 文件一致，上层入口是什么并不重要。

## 项目结构

```text
.
├─ assets/icons/           # 项目图标和 Bark 推送图标素材
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

## 通知内容

通知会优先使用 thread 名称或你手动设置的 thread 名称。

Bark 推送标题默认是：

```text
codex
```

Bark 推送正文类似：

```text
任务 {Thread Name} 已完成，用时 {duration}
```

如果原始 thread 名称包含 VS Code 自动注入的上下文前缀，程序会尽量清洗，只保留更接近真实任务内容的名称。

## 许可证

MIT
