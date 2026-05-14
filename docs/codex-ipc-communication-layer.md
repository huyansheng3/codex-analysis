# Codex IPC 通信层完整逆向

> 来源：`app.asar` 解压后 `.vite/build/` 中 main.js, preload.js, sandbox-preload.js, comment-preload.js 的静态分析
> 版本：26.506.31421 (Build 2620)

---

## 1. IPC 架构概览

Codex 使用 Electron 的标准 IPC 机制，但在其上构建了多层抽象：

```
┌──────────────────────────────────────────────────────────────┐
│  Renderer (React SPA)                                         │
│  ├── electronBridge (window.electronBridge)                   │
│  │   ├── sendMessageFromView() ──────────────────────────┐    │
│  │   ├── sendWorkerMessageFromView() ────────────┐       │    │
│  │   ├── getSharedObjectSnapshotValue() ──┐      │       │    │
│  │   └── subscribeToWorkerMessages() ─┐   │      │       │    │
│  └── window.postMessage() ────────────┤   │      │       │    │
│                                        │   │      │       │    │
│  ┌────────────────────────────────────┼───┼──────┼───────┼─┐  │
│  │ Sandbox Renderer (MCP Apps)        │   │      │       │ │  │
│  │ └── Port-based MessageChannel ───┐ │   │      │       │ │  │
│  └──────────────────────────────────┼─┼───┼──────┼───────┼─┘  │
├─────────────────────────────────────┼─┼───┼──────┼───────┼─── │
│  Preload Layer                      │ │   │      │       │    │
│  ├── preload.js                     │ │   │      │       │    │
│  │   └── contextBridge.exposeInMainWorld()  │      │       │    │
│  ├── sandbox-preload.js ────────────┘ │   │      │       │    │
│  └── comment-preload.js ──────────────┘   │      │       │    │
├───────────────────────────────────────────┼──────┼───────┼─── │
│  Main Process                              │      │       │    │
│  ├── ipcMain.handle('codex_desktop:...')  │      │       │    │
│  ├── ipcMain.on('codex_desktop:...') ─────┘      │       │    │
│  ├── SharedObject (内存同步) ──────────────────────┘       │    │
│  └── Worker Thread ───────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Preload Bridge API (electronBridge)

**文件**：`.vite/build/preload.js` (2,374 bytes)

### 2.1 完整接口定义

从 preload.js 反编译重建的 TypeScript 接口：

```typescript
// 窗口类型标识（硬编码为 "electron"）
type WindowType = "electron";

// 主进程暴露给渲染进程的完整 API
interface ElectronBridge {
  // 窗口类型
  windowType: WindowType;  // 固定值 "electron"

  // === 消息通信 ===

  // 从 View 发送消息到主进程 (Renderer → Main)
  sendMessageFromView(message: ViewMessage): Promise<void>;
  // IPC: ipcRenderer.invoke('codex_desktop:message-from-view', message)

  // 监听来自主进程的消息 (Main → Renderer)
  // 实际通过 window.addEventListener('message', ...) 接收
  // IPC: ipcRenderer.on('codex_desktop:message-for-view', handler)

  // === 工作线程通信 ===

  // 向 Worker 线程发送消息
  sendWorkerMessageFromView(workerName: string, message: unknown): Promise<void>;
  // IPC: ipcRenderer.invoke(`codex_desktop:worker:${workerName}:from-view`, message)

  // 订阅 Worker 线程的消息
  subscribeToWorkerMessages(
    workerName: string,
    callback: (message: unknown) => void
  ): () => void;  // 返回取消订阅函数
  // IPC: ipcRenderer.on(`codex_desktop:worker:${workerName}:for-view`, handler)

  // === 文件系统 ===

  // 将 file:// URL 转换为本地文件路径
  getPathForFile(fileUrl: string): string | null;
  // 使用 electron.webUtils.getPathForFile()

  // === 共享状态 (SharedObject) ===

  // 获取共享状态快照的某个 key
  getSharedObjectSnapshotValue(key: string): unknown;
  // IPC: ipcRenderer.sendSync('codex_desktop:get-shared-object-snapshot')

  // 设置共享状态（通过 sendMessageFromView 的 type='shared-object-set'）
  // 实际调用: sendMessageFromView({ type: 'shared-object-set', key, value })

  // === 菜单 ===

  // 显示原生上下文菜单
  showContextMenu(options: ContextMenuOptions): Promise<void>;
  // IPC: ipcRenderer.invoke('codex_desktop:show-context-menu', options)

  // 在指定位置显示应用菜单（菜单栏下拉）
  showApplicationMenu(menuId: string, x: number, y: number): Promise<void>;
  // IPC: ipcRenderer.invoke('codex_desktop:show-application-menu', { menuId, x, y })

  // === 主题 ===

  // 获取系统主题变体（light/dark）
  getSystemThemeVariant(): "light" | "dark";
  // IPC: ipcRenderer.sendSync('codex_desktop:get-system-theme-variant')

  // 订阅系统主题变化
  subscribeToSystemThemeVariant(callback: () => void): () => void;
  // IPC: ipcRenderer.on('codex_desktop:system-theme-variant-updated', handler)

  // === Sentry ===

  // 获取 Sentry 初始化选项（包含 codexAppSessionId）
  getSentryInitOptions(): SentryInitOptions;

  // 获取 App Session ID
  getAppSessionId(): string;

  // 触发测试 Sentry 错误
  triggerSentryTestError(): Promise<void>;
  // IPC: ipcRenderer.invoke('codex_desktop:trigger-sentry-test')

  // === 构建信息 ===

  // 获取构建 flavor（prod/staging/dev/agent）
  getBuildFlavor(): string;
  // IPC: ipcRenderer.sendSync('codex_desktop:get-build-flavor')

  // === Fast Mode ===

  // 获取 Fast Mode 的 rollout metrics
  getFastModeRolloutMetrics(data: unknown): Promise<unknown>;
  // IPC: ipcRenderer.invoke('codex_desktop:get-fast-mode-rollout-metrics', data)
}
```

### 2.2 SharedObject 机制

SharedObject 是主进程和所有渲染进程之间的双向同步状态：

```typescript
// 渲染进程设置值（通过 sendMessageFromView）
sendMessageFromView({ type: "shared-object-set", key: "someKey", value: someValue });
// 渲染进程删除值
sendMessageFromView({ type: "shared-object-set", key: "someKey" });  // value === undefined

// 主进程通知值已更新（广播到所有渲染进程）
// 通过 'codex_desktop:message-for-view' 发送 { type: "shared-object-updated", key, value }
```

---

## 3. 完整 IPC 通道列表

### 3.1 codex_desktop:* 通道（18 个）

| # | 通道名 | 方向 | 方式 | 用途 |
|---|--------|------|------|------|
| 1 | `codex_desktop:message-from-view` | R→M | invoke | 通用消息（渲染→主进程） |
| 2 | `codex_desktop:message-for-view` | M→R | on | 通用消息（主进程→渲染） |
| 3 | `codex_desktop:browser-sidebar-runtime-message` | 双向 | invoke | 浏览器侧边栏运行时消息 |
| 4 | `codex_desktop:mcp-app-sandbox-guest-message` | Guest→M | postMessage | MCP App 沙箱客户消息 |
| 5 | `codex_desktop:mcp-app-sandbox-host-message` | M→Guest | postMessage | MCP App 沙箱宿主消息 |
| 6 | `codex_desktop:show-context-menu` | R→M | invoke | 显示原生上下文菜单 |
| 7 | `codex_desktop:show-application-menu` | R→M | invoke | 显示应用菜单栏下拉 |
| 8 | `codex_desktop:get-sentry-init-options` | R→M | sendSync | 获取 Sentry 配置（同步） |
| 9 | `codex_desktop:get-build-flavor` | R→M | sendSync | 获取构建类型（同步） |
| 10 | `codex_desktop:get-system-theme-variant` | R→M | sendSync | 获取系统主题（同步） |
| 11 | `codex_desktop:get-shared-object-snapshot` | R→M | sendSync | 获取共享状态快照（同步） |
| 12 | `codex_desktop:get-fast-mode-rollout-metrics` | R→M | invoke | 获取 Fast Mode 数据 |
| 13 | `codex_desktop:system-theme-variant-updated` | M→R | on | 主题变化通知（广播） |
| 14 | `codex_desktop:trigger-sentry-test` | R→M | invoke | 触发 Sentry 测试错误 |
| 15 | `codex_desktop:worker:*:from-view` | R→M | invoke | Worker 消息（渲染→Worker） |
| 16 | `codex_desktop:worker:*:for-view` | M→R | on | Worker 消息（Worker→渲染） |

### 3.2 Settings 持久化通道（sendSync + returnValue，约 40 个）

这些通过 `ipcMain.on(channel, (e) => { e.returnValue = ... })` 同步模式持久化：

```typescript
// 窗口状态
"electron-main-window-bounds"           // 主窗口位置/大小

// Agent 配置
"codex-agents-md"                        // Agent 使用 Markdown
"codex-agents-md-save"                   // 保存 Agent MD 设置
"codex-command-keymap-state"             // 快捷键映射

// 路径和凭据
"codex-home"                             // Codex Home 目录
"openai-api-key"                         // ⚠️ OpenAI API Key
"x-codex-client-session-token"           // ⚠️ 客户端 Session Token

// OAuth
"app-connect-oauth-callback-url"         // OAuth 回调 URL

// Browser Use
"browser-use-approval-mode-write"        // 浏览器使用审批模式
"browser-use-origin-state-read"          // 浏览器 Origin 状态

// Computer Use
"computer-use-app-approval-remove"       // 移除应用审批
"computer-use-app-approvals-read"        // 读取应用审批列表
"computer-use-app-approvals-visibility"  // 审批可见性
"computer-use-sound-mode-read"           // 声音模式读取
"computer-use-sound-mode-write"          // 声音模式写入

// Dictation (语音输入)
"global-dictation-capture-fn-hotkey"     // 录音快捷键
"global-dictation-copy-history-item"     // 历史记录
"global-dictation-force-lock-changed"    // 强制锁定状态
"global-dictation-in-app-started"        // 应用内录音已启动
"global-dictation-record-history-item"   // 记录历史
"global-dictation-set-toggle-hotkey"     // 切换快捷键

// Remote Control
"set-remote-connection-auto-connect"     // 远程连接自动连接
"set-remote-control-connections-enabled" // 远程控制开关

// Thread/Agent
"thread-follower-command-approval-decision"  // 命令审批
"thread-follower-file-approval-decision"     // 文件审批
"thread-follower-set-collaboration-mode"     // 协作模式
"thread-follower-submit-user-input"          // 用户输入提交
"list-pending-automation-run-threads"        // 待处理自动化线程

// 其他
"generate-commit-pull-request-message"   // 生成 Commit/PR 消息
"get-copilot-api-proxy-info"             // Copilot API 代理信息
"node-repl-active-execs-kill"            // 终止 Node REPL 执行
"primary-runtime-update-run-now"         // 运行时更新
"native-window-context-hotkey-state"     // 窗口上下文快捷键状态
"native-window-context-set-hotkey"       // 设置窗口上下文快捷键
"hotkey-window-collapse-to-home"         // 热键窗口折叠
```

---

## 4. 消息类型系统 (Message Types)

主消息通道 (`codex_desktop:message-from-view` / `codex_desktop:message-for-view`) 通过 JSON payload 的 `type` 字段进行二级路由：

### 4.1 窗口路由（7 个）

```typescript
type WindowRoutingMessage =
  | { type: "open-in-main-window"; /* ... */ }
  | { type: "open-current-main-window"; /* ... */ }
  | { type: "open-in-new-window"; /* ... */ }
  | { type: "open-in-hotkey-window"; /* ... */ }
  | { type: "open-in-browser"; /* ... */ }
  | { type: "open-in-targets"; /* ... */ }
  | { type: "open-in-browser-button"; /* ... */ }
  | { type: "close-active-app-shell-tab"; /* ... */ };
```

### 4.2 应用状态（12 个）

```typescript
type AppStateMessage =
  | { type: "electron-app-state-snapshot-request" }
  | { type: "electron-window-focus-changed"; focused: boolean }
  | { type: "window-fullscreen-changed"; isFullscreen: boolean }
  | { type: "electron-desktop-features-changed"; features: DesktopFeatures }
  | { type: "electron-onboarding-skip-workspace-result"; /* ... */ }
  | { type: "electron-onboarding-pick-workspace-or-create-default-result"; /* ... */ }
  | { type: "persisted-atom-updated"; key: string; value: unknown }
  | { type: "custom-prompts-updated" }
  | { type: "shared-object-updated"; key: string; value: unknown }
  | { type: "global-state-updated" }
  | { type: "workspace-root-options-updated" }
  | { type: "active-workspace-roots-updated" };
```

### 4.3 Hotkey Window 事件（5 个）

```typescript
type HotkeyWindowMessage =
  | { type: "hotkey-window-enabled-changed"; enabled: boolean }
  | { type: "mac-menu-bar-enabled-changed"; enabled: boolean }
  | { type: "hotkey-window-transition-done" }
  | { type: "hotkey-window-collapse-to-home" }
  | { type: "hotkey-window-home-pointer-interaction"; /* ... */ }
  | { type: "hotkey-window-transition"; /* ... */ };
```

### 4.4 更新生命周期（4 个）

```typescript
type UpdateMessage =
  | { type: "app-update-ready-changed"; ready: boolean }
  | { type: "app-update-lifecycle-state-changed"; state: string }
  | { type: "app-update-install-progress-changed"; progress: number };
```

### 4.5 命令系统（5 个）

```typescript
type CommandMessage =
  | { type: "command-menu" }
  | { type: "file-search-command-menu" }
  | { type: "chat-search-command-menu" }
  | { type: "run-command"; commandId: string }
  | { type: "step-window-zoom"; direction: "in" | "out" }
  | { type: "reset-window-zoom" };
```

### 4.6 通知（3 个）

```typescript
type NotificationMessage =
  | { type: "desktop-notification-show"; notification: DesktopNotification }
  | { type: "desktop-notification-hide"; id: string }
  | { type: "desktop-notification-action"; id: string; action: string };
```

### 4.7 调试（3 个）

```typescript
type DebugMessage =
  | { type: "debug-run-app-action-request"; /* ... */ }
  | { type: "debug-run-app-action-response"; /* ... */ }
  | { type: "debug-window-origin-conversation-changed"; /* ... */ };
```

### 4.8 其他消息（10+ 个）

```typescript
type MiscMessage =
  | { type: "computer-use-capture-updated" }
  | { type: "primary-runtime-install-progress"; progress: number }
  | { type: "pinned-threads-updated" }
  | { type: "fetch-stream-error"; error: unknown }
  | { type: "trace-recording-state-changed" }
  | { type: "avatar-overlay-open-state-changed" }
  | { type: "avatar-overlay-layout-changed" }
  | { type: "terminal-error"; error: string }
  | { type: "native-window-context-shortcut" }
  | { type: "global-dictation-in-app-start" }
  | { type: "global-dictation-in-app-stop" }
  | { type: "worker-app-event"; event: unknown };
```

---

## 5. Browser Sidebar Runtime 协议

**文件**：`.vite/build/comment-preload.js` (35 MB)

这是浏览器侧边栏评论/标注系统的完整 IPC 协议：

### 5.1 编辑器生命周期

```typescript
// 编辑器打开/关闭
"browser-sidebar-runtime-open-editor"      // 打开代码编辑器
"browser-sidebar-runtime-close-editor"     // 关闭编辑器
"browser-sidebar-runtime-restore-editor"   // 恢复编辑器状态
"browser-sidebar-runtime-focus-editor"     // 聚焦编辑器

// 评论操作
"browser-sidebar-runtime-create-comment-at-point"  // 在光标位置创建评论
"browser-sidebar-runtime-select-comment"           // 选中/高亮评论
"browser-sidebar-runtime-update-anchor"            // 更新评论锚点位置
"browser-sidebar-runtime-exit-comment-mode"        // 退出评论模式
```

### 5.2 截图系统

```typescript
"browser-sidebar-runtime-prepare-comment-screenshot"   // 准备截图
"browser-sidebar-runtime-comment-screenshot-ready"     // 截图就绪
"browser-sidebar-runtime-clear-comment-screenshot"     // 清除截图
```

### 5.3 预览叠加层

```typescript
"browser-sidebar-runtime-open-comment-preview"   // 打开评论预览
"browser-sidebar-runtime-close-comment-preview"  // 关闭评论预览
```

### 5.4 评论叠加层（完整 CRUD）

```typescript
// Session 管理
"browser-sidebar-comment-overlay-session"          // 叠加层会话

// 评论 CRUD
"browser-sidebar-comment-overlay-submit"           // 提交评论
"browser-sidebar-comment-overlay-delete"           // 删除评论
"browser-sidebar-comment-overlay-prepare"          // 准备叠加层
"browser-sidebar-comment-overlay-mounted"          // 叠加层已挂载
"browser-sidebar-comment-overlay-close"            // 关闭叠加层

// 状态事件
"browser-sidebar-comment-overlay-preview-open-changed"  // 预览状态变化
"browser-sidebar-comment-overlay-anomaly"               // 异常检测
"browser-sidebar-comment-mode-site-status"              // 站点评论模式状态
```

### 5.5 浏览控制

```typescript
"browser-sidebar-browser-use-viewport"         // 浏览器视口
"browser-sidebar-browser-use-capture-surface"  // 捕获表面（屏幕截图）
"browser-sidebar-browser-use-state"            // 浏览器状态
"browser-sidebar-browser-use-cursor-state"     // 光标状态
"browser-sidebar-runtime-mouse-navigation"     // 鼠标导航（前进/后退）
```

### 5.6 内部状态同步

```typescript
"browser-sidebar-runtime-sync"     // 状态同步
"browser-sidebar-sync"             // 通用同步
"browser-sidebar-owner-sync"       // Owner 专属同步
"browser-sidebar-state"            // 侧边栏状态
"browser-sidebar-command"          // 命令执行
"browser-sidebar-find-state"       // 查找状态
"browser-sidebar-manager"          // 侧边栏管理器
"browser-sidebar-load-url"         // URL 加载
"browser-sidebar-load-error-page"  // 错误页加载
"browser-sidebar-local-servers"    // 本地服务器管理
"browser-sidebar-usage"            // 使用统计
"browser-sidebar-scroll"           // 滚动同步
```

---

## 6. MCP Sandbox 通信

**文件**：`.vite/build/sandbox-preload.js` (1,978 bytes)

### 6.1 Origin 验证

```typescript
// 允许的沙箱域名
const SANDBOX_DOMAIN = "web-sandbox.oaiusercontent.com";
const SANDBOX_SUBDOMAIN_PATTERN = `.${SANDBOX_DOMAIN}`;

// 只允许 HTTPS，不允许端口、用户名、密码
function validateOrigin(urlString: string): URL | null {
  const url = new URL(urlString);
  if (url.protocol !== "https:") return null;
  if (url.port !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hostname !== SANDBOX_DOMAIN && !url.hostname.endsWith(SANDBOX_SUBDOMAIN_PATTERN))
    return null;
  return url;
}
```

### 6.2 Skybridge 协议

MCP App 通过特殊的 URL 参数检测来启用 Skybridge：

```typescript
// URL 格式: https://{sandbox-domain}/?app=skybridge&locale={locale}&deviceType=desktop&unsafeSkipTargetOriginCheck=true

interface SkybridgeParams {
  app: "skybridge";
  locale: string;           // 非空
  deviceType: "desktop";    // 固定值
  unsafeSkipTargetOriginCheck: "true";  // 跳过额外的 Origin 检查
}

// 允许的 MCP App 端口消息类型
const ALLOWED_PORT_NAMES = [
  "notifyMcpAppsHostContext",
  "notifyMcpAppsToolCancelled",
  "notifyMcpAppsToolInput",
  "notifyMcpAppsToolResult",
  "requestMcpAppsResourceTeardown",
  "runWidgetCode",
  "setAdditionalGlobals",
  "setSafeArea",
  "setTheme",
  "setWidgetData",
  "setWidgetView",
];
```

### 6.3 Init 流程

```typescript
// 1. 沙箱 frame 的 sandbox-preload.js 监听来自宿主 window 的 'init' 消息
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!isSkybridgeOrigin()) return;
  if (event.data?.type !== "init") return;

  const { ports, replyPort } = event.data;  // MessagePort 数组
  const initId = extractInitId(window.location.href);  // 从 URL hash 提取

  // 验证所有 port 名称都在白名单内
  const portNames = [...ALLOWED_PORT_NAMES];
  if (portNames.some(name => !isValidPort(ports[name]))) return;

  // 通过 IPC 发送 init 到主进程
  ipcRenderer.postMessage(
    "codex_desktop:mcp-app-sandbox-guest-message",
    { origin, initId, portNames, type: "init" },
    [...Object.values(ports), replyPort]  // 转移 MessagePort
  );
});
```

---

## 7. Deep Link 路由表 (codex://)

Codex 注册了 `codex://` 自定义协议，路由分发在 main.js 中：

```typescript
type DeepLinkRoute =
  // 应用配置
  | { kind: "applyCodexAppConfig"; /* ... */ }
  // 插件操作
  | { kind: "pluginInstall"; pluginName: string }
  | { kind: "pluginDetail"; pluginName: string }
  // 自动化
  | { kind: "automations"; /* ... */ }
  // OAuth
  | { kind: "connectorOAuthCallback"; code: string; state: string }
  // 会话
  | { kind: "localConversation"; conversationId: string }
  | { kind: "newThread"; path?: string; originUrl?: string; prompt?: string }
  // 导航
  | { kind: "settings"; section?: string }
  | { kind: "skills"; /* ... */ };
```

---

## 8. 安全攻击面

### 8.1 IPC 注入

| 风险 | 严重度 | 说明 |
|------|--------|------|
| 渲染进程可控的 `sendMessageFromView` | Medium | 如果 XSS 存在于渲染进程，可调用任意 IPC 方法 |
| Settings 通道无验证 | High | `openai-api-key` 和 `x-codex-client-session-token` 通过 sendSync 访问，任何渲染进程都可读取 |
| SharedObject 无访问控制 | Medium | 任何 preload 暴露的渲染进程都能读写 shared object |

### 8.2 Deep Link 注入

| 风险 | 严重度 | 说明 |
|------|--------|------|
| `codex://newThread?prompt=<injection>` | Medium | Prompt 参数可能触发 agent 执行 |
| `codex://connectorOAuthCallback` | Low | OAuth state 参数需防 CSRF |
| `codex://applyCodexAppConfig` | High | 可能修改应用配置 |

### 8.3 Sandbox Escape

| 风险 | 严重度 | 说明 |
|------|--------|------|
| `unsafeSkipTargetOriginCheck=true` | Low | 设计如此，但 URL 解析器 bug 可能导致绕过 |
| Port 白名单完备性 | Low | 11 个 allowed ports 需要审计 |
| regex initId 验证 `^[A-Za-z0-9_-]{1,128}$` | Low | 限制合理 |

### 8.4 凭据暴露

| 存储位置 | 凭据 | 风险 |
|----------|------|------|
| Electron Settings (`openai-api-key`) | API Key | 任何 preload 脚本可同步读取 |
| Electron Settings (`x-codex-client-session-token`) | Session Token | 同上 |
| macOS Keychain | Device Key (Secure Enclave) | 硬件保护，较安全 |
| SharedObject | 运行时凭据 | 所有渲染进程共享 |
