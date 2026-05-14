# Codex 主进程架构深度分析

> 来源：`app.asar/.vite/build/` 中 bootstrap.js, app-session.js, main.js 的静态逆向
> 版本：26.506.31421 (Build 2620)

---

## 1. 启动流程

### 1.1 Bootstrap 阶段

**文件**：`.vite/build/bootstrap.js` (3,754 bytes)

```typescript
// 反编译重建的启动流程
const appSession = require("./app-session-tZw_L1R0.js");
const workspaceDropHandler = require("./workspace-root-drop-handler-CVOJlSpQ.js");
const electron = require("electron");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");

// Step 1: 解析构建 flavor
const buildFlavor = resolveBuildFlavor();  // 从 CODEX_BUILD_FLAVOR 或 package.json codexBuildFlavor 读取
// 可能值: "prod" | "staging" | "dev" | "agent"

// Step 2: 设置 macOS 特定行为
const isMacOS = process.platform === "darwin";
setupMacOSBehavior(isMacOS);

// Step 3: 设置应用名和用户数据路径
electron.app.setName(getAppName(buildFlavor));
electron.app.setPath("userData", resolveUserDataPath({
  appDataPath: electron.app.getPath("appData"),
  buildFlavor,
  env: process.env,
}));

// Agent 模式下用户数据路径：<userData>/agent/<agentRunId>

// Step 4: Windows AppUserModelId
if (process.platform === "win32") {
  electron.app.setAppUserModelId(getWindowsAppId(buildFlavor));
}

// Step 5: 单实例锁
const useSingleInstanceLock = shouldUseSingleInstanceLock({ isMacOS, isPackaged: electron.app.isPackaged });
if (useSingleInstanceLock && !electron.app.requestSingleInstanceLock()) {
  // 第二个实例 → 退出，通过 second-instance 事件传递参数
  electron.app.exit(0);
}

// Step 6: 启动完成
electron.app.whenReady().then(async () => {
  // 6a: Intel-on-Apple-Silicon 警告
  if (await shouldShowIntelWarning({ appName, environment, ... })) {
    electron.app.quit();
    return;
  }

  // 6b: 初始化 Sparkle 自动更新
  await sparkleManager.initialize();

  // 6c: 加载主进程主模块
  const { runMainAppStartup } = await import("./main-DnQgBHvi.js");
  await runMainAppStartup();

  // 6d: 错误处理 → 显示错误对话框并触发更新/退出
});
```

### 1.2 启动错误恢复

```typescript
// 如果主进程启动失败，显示错误对话框
enum DialogAction {
  InstallUpdate = "install-update",       // 安装待处理的更新
  CheckForUpdates = "check-for-updates",  // 检查更新
  Quit = "quit",                          // 退出应用
}

async function showStartupErrorDialog(error: Error) {
  const { sparkleManager } = getAppSession();

  // 动态确定可用按钮
  const availableActions = sparkleManager.getIsUpdateReady()
    ? [DialogAction.InstallUpdate, DialogAction.Quit]
    : sparkleManager.hasUpdater()
      ? [DialogAction.CheckForUpdates, DialogAction.Quit]
      : [DialogAction.Quit];

  const result = await electron.dialog.showMessageBox({
    type: "error",
    buttons: availableActions.map(a => actionLabels[a]),
    defaultId: 0,
    cancelId: availableActions.length - 1,
    message: `${electron.app.getName()} failed to start.`,
    detail: error instanceof Error ? error.message : "The main desktop app failed during startup.",
  });

  const action = availableActions[result.response] ?? DialogAction.Quit;
  switch (action) {
    case DialogAction.InstallUpdate:
      await sparkleManager.installUpdatesIfAvailable();
      break;
    case DialogAction.CheckForUpdates:
      await sparkleManager.checkForUpdates();
      break;
    case DialogAction.Quit:
      electron.app.quit();
      break;
  }
}
```

---

## 2. App Session 模块

**文件**：`.vite/build/app-session-tZw_L1R0.js` (4.3 MB)

这是 Codex 的核心运行时模块，负责：

### 2.1 WASM 绑定层

app-session.js 导出了大量 `__wbindgen_*` 函数，表明它包含一个由 Rust/C++ 编译的 WASM 模块（通过 wasm-bindgen 工具链）：

```typescript
// WASM 导出的函数（部分列表）
exports.__wbg_String_8f0eb39a4a4c2f66     // WASM ↔ JS String 桥接
exports.__wbg_buffer_609cc3eee51ed158     // WASM ↔ JS Buffer 桥接
exports.__wbg_call_672a4d21634d4a24       // WASM 调用 JS 函数
exports.__wbg_get_67b2ba62fc30de12        // WASM 属性访问
exports.__wbg_set_3f1d0b984ed272ed        // WASM 属性设置
exports.__wbg_instanceof_Map_f3469ce2244d2430  // Map 类型检查
exports.__wbg_instanceof_Uint8Array_17156bcf118086a9  // TypedArray 检查
exports.__wbindgen_bigint_from_i64        // BigInt 支持
exports.__wbindgen_bigint_from_u64
exports.__wbindgen_boolean_get            // Boolean 转换
exports.__wbindgen_string_new             // String 创建
exports.__wbindgen_is_function            // 类型检查
exports.__wbindgen_is_object
exports.__wbindgen_is_string
exports.__wbindgen_is_undefined
exports.__wbindgen_throw                  // 错误抛出
```

### 2.2 BuildFlavor 枚举

```typescript
enum BuildFlavor {
  Prod = "prod",
  Staging = "staging",
  Dev = "dev",
  Agent = "agent",
}

function resolveBuildFlavor(): BuildFlavor {
  // 优先级：
  // 1. process.env.CODEX_BUILD_FLAVOR
  // 2. package.json codexBuildFlavor
  // 3. 默认为 Prod
}

function isInternal(buildFlavor: BuildFlavor): boolean {
  // Staging 和 Agent 被视为内部构建
  return buildFlavor === BuildFlavor.Staging || buildFlavor === BuildFlavor.Agent;
}
```

### 2.3 用户数据路径解析

```typescript
function resolveUserDataPath({
  appDataPath,
  buildFlavor,
  env,
}: {
  appDataPath: string;
  buildFlavor: BuildFlavor;
  env: NodeJS.ProcessEnv;
}): string {
  // 1. 环境变量覆盖（用于开发/测试）
  const override = env.CODEX_ELECTRON_USER_DATA_PATH?.trim();
  if (override) return path.resolve(override);

  // 2. 基础路径：<appData>/<appName>
  const basePath = path.join(appDataPath, getAppName(buildFlavor));

  // 3. Agent 模式：<basePath>/agent/<agentRunId>
  if (buildFlavor === "agent") {
    const agentRunId = env.CODEX_ELECTRON_AGENT_RUN_ID?.trim() ?? null;
    if (agentRunId != null) {
      return path.join(basePath, "agent", agentRunId);
    }
  }

  return basePath;
}
```

---

## 3. Session 分区管理

主进程使用 `session.fromPartition()` 创建隔离的浏览器会话：

```typescript
// 从 main.js 提取的 partition 调用模式
const mainSession = electron.session.fromPartition("persist:main");
const workerSession = electron.session.fromPartition("persist:worker");
const webviewSession = electron.session.fromPartition("persist:webview");

// 动态 partition（基于用户/线程 ID）
const threadSession = electron.session.fromPartition(`persist:thread-${threadId}`);
```

**分析**：
- 使用 `persist:` 前缀，表示数据持久化到磁盘
- 不同功能模块使用不同 partition 实现存储隔离
- 线程级别的 partition 表明每个对话可能有独立的浏览器 Session

---

## 4. BrowserWindow 管理

### 4.1 窗口类型

```typescript
// 从 IPC 消息类型和窗口路由反向推导的窗口类型
type WindowIdentifier =
  | "PrimaryWindow"              // 主应用窗口
  | "HostWindow"                 // 特定 Host 的窗口
  | "HomeWindow"                 // Home Tab 窗口
  | "ThreadWindow"               // 对话 Thread 窗口
  | "AuxWindow"                  // 辅助/次级窗口
  | "FocusedWindow"              // 当前焦点窗口
  | "FocusedInAppWindow"         // 应用内焦点窗口
  | "LastActivePrimaryWindow"    // 最近活跃的主窗口
  | "FreshLocalWindow"           // 新建本地会话窗口
  | "PreviewWindow";             // 预览/叠加层窗口
```

### 4.2 macOS 窗口属性

```typescript
// 从 objc-js 调用中提取的 macOS NSWindow 配置
interface MacOSWindowConfig {
  // setAlwaysOnTop(level) - 窗口置顶级别
  alwaysOnTopLevel?: number;  // 0 = 普通, 1 = 浮动

  // setVisibleOnAllWorkspaces(true) - 所有桌面工作区可见
  visibleOnAllWorkspaces?: boolean;

  // 预览窗口的特殊模式
  surfaceMode?: "editor" | "preview";

  // preview 模式下：setIgnoresMouseEvents(true)
  // 使窗口对鼠标事件透明
}
```

### 4.3 setWindowOpenHandler

```typescript
// main.js 中 3 处 setWindowOpenHandler 调用
// 拦截 window.open() 请求，根据 URL 决定是否允许新窗口

webContents.setWindowOpenHandler(({ url }) => {
  // 解析 URL
  // 白名单检查
  // 返回 { action: "allow" | "deny" }
});
```

---

## 5. 应用菜单

### 5.1 完整菜单结构

从 main.js 中还原的菜单模板（含快捷键和条件显示逻辑）：

```typescript
const menuTemplate = [
  // File Menu
  {
    id: "file",
    label: "File",
    submenu: [
      { label: "New Thread", accelerator: "CmdOrCtrl+T" },
      { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", visible: multiWindowEnabled },
      { label: "Open Folder", accelerator: "CmdOrCtrl+O" },
      { label: "Open Recent", role: "recentDocuments" },
      { label: "Open in WSL", accelerator: "CmdOrCtrl+Shift+W", visible: wslEnabled },
      { type: "separator" },
      { label: "Settings", accelerator: "CmdOrCtrl+," },
      { type: "separator" },
      { role: "quit" },
    ],
  },

  // Edit Menu (标准)
  { id: "edit", role: "editMenu" },

  // View Menu
  {
    id: "view",
    label: "View",
    submenu: [
      { label: "Zoom In", accelerator: "CmdOrCtrl+=" },
      { label: "Zoom Out", accelerator: "CmdOrCtrl+-" },
      { label: "Actual Size", accelerator: "CmdOrCtrl+0" },
      { type: "separator" },
      { label: "Toggle Full Screen", accelerator: "Ctrl+Cmd+F" },
      { type: "separator" },
      // 调试菜单项（仅内部版本）
      { label: "Reload Window", visible: allowDebugMenu },
      { label: "Toggle Debug Menu", visible: allowDebugMenu },
      { label: "Open Deeplink from Clipboard", visible: allowDebugMenu },
      { label: "Toggle Query Devtools", visible: allowDebugMenu },
      { label: "Toggle React Scan", visible: allowDebugMenu },
      { type: "separator" },
      { label: "Check for Updates" },
      { type: "separator" },
      { label: "Log Out" },
    ],
  },

  // Window Menu (标准 macOS)
  { id: "window", role: "windowMenu" },

  // Help Menu
  {
    id: "help",
    label: "Help",
    submenu: [
      { label: "Codex Documentation",    url: "https://developers.openai.com/codex/app" },
      { label: "What's new",              url: "https://developers.openai.com/codex/changelog" },
      { label: "Automations",             url: "https://developers.openai.com/codex/app/automations" },
      { label: "Local Environments",      url: "https://developers.openai.com/codex/app/local-environments" },
      { label: "Worktrees",               url: "https://developers.openai.com/codex/app/worktrees" },
      { label: "Skills",                  url: "https://developers.openai.com/codex/skills" },
      { label: "Model Context Protocol",  url: "https://developers.openai.com/codex/mcp" },
      { label: "Troubleshooting",         url: "https://developers.openai.com/codex/app/troubleshooting" },
      { type: "separator" },
      { label: "Send Feedback", accelerator: "CmdOrCtrl+Shift+M" },
      { type: "separator" },
      { label: "Keyboard Shortcuts" },
    ],
  },
];
```

### 5.2 上下文菜单

```typescript
// 动态上下文菜单（基于选中内容和元素类型）
const contextMenuTemplate = {
  // 基础编辑操作
  cut: { label: "Cut", accelerator: "CmdOrCtrl+X" },
  copy: { label: "Copy", accelerator: "CmdOrCtrl+C" },
  paste: { label: "Paste", accelerator: "CmdOrCtrl+V" },
  selectAll: { label: "Select All", accelerator: "CmdOrCtrl+A" },

  // 媒体操作（条件显示）
  saveImage: { label: "Save Image" },
  saveImageAs: { label: "Save Image As..." },
  saveVideo: { label: "Save Video" },
  saveVideoAs: { label: "Save Video As..." },
  copyLink: { label: "Copy Link" },
  saveLinkAs: { label: "Save Link As..." },
  copyImage: { label: "Copy Image" },
  copyImageAddress: { label: "Copy Image Address" },
  copyVideoAddress: { label: "Copy Video Address" },

  // 开发工具
  inspectElement: { label: "Inspect Element", visible: allowDevtools },

  // macOS 服务
  lookUp: { label: "Look Up" },
  searchWithGoogle: { label: "Search with Google" },

  // 拼写
  spelling: { label: "Spelling Suggestions" },

  // 系统服务
  services: { role: "services" },
};
```

---

## 6. Feature Flag 系统

### 6.1 Desktop Features

```typescript
interface DesktopFeatures {
  inAppBrowserUse: boolean;         // 应用内浏览器可用
  externalBrowserUseAllowed: boolean; // 外部浏览器可用
  computerUse: boolean;             // Computer Use 功能
  ambientSuggestions: boolean;      // 环境建议
  artifactsPane: boolean;           // Artifacts 面板
  allowDevtools: boolean;           // DevTools 允许
  allowDebugMenu: boolean;          // 调试菜单允许
  allowWindowReload: boolean;       // 窗口重载允许
  enableSparkle: boolean;           // Sparkle 更新（macOS only）
}
```

### 6.2 功能检测条件

```typescript
// 基于平台和构建类型的条件
function resolveFeatures({
  platform,
  buildFlavor,
  isPackaged,
}: {
  platform: NodeJS.Platform;
  buildFlavor: BuildFlavor;
  isPackaged: boolean;
}): DesktopFeatures {
  return {
    inAppBrowserUse: true,
    externalBrowserUseAllowed: buildFlavor !== "agent",
    computerUse: platform === "darwin" && (isInternal(buildFlavor) || buildFlavor === "prod"),
    ambientSuggestions: buildFlavor !== "agent",
    artifactsPane: true,
    allowDevtools: !isPackaged || isInternal(buildFlavor),
    allowDebugMenu: !isPackaged || isInternal(buildFlavor),
    allowWindowReload: !isPackaged || isInternal(buildFlavor),
    enableSparkle: platform === "darwin" && isPackaged,
  };
}
```

---

## 7. 环境变量

| 变量 | 用途 | 影响范围 |
|------|------|----------|
| `CODEX_API_BASE_URL` | 覆盖 API 基础 URL | 所有 API 请求 |
| `CODEX_API_ENDPOINT` | API 端点选择（"localhost"=dev） | 开发环境 |
| `CODEX_CLI_PATH` | Codex CLI 可执行文件路径 | Shell/终端功能 |
| `CODEX_APP_SERVER_FORCE_CLI` | 强制使用 CLI 模式（SSH） | SSH 隧道 |
| `CODEX_ELECTRON_AGENT_RUN_ID` | Agent 运行 ID | 用户数据隔离 |
| `CODEX_ELECTRON_USER_DATA_PATH` | 覆盖用户数据目录 | 文件系统 |
| `CODEX_ELECTRON_DISABLE_QUIT_CONFIRMATION` | 跳过退出确认 | 自动化 |
| `CODEX_ELECTRON_DEV_PARENT_PID` | 开发模式父进程 PID | Dev 模式 |
| `CODEX_ELECTRON_DEV_WEBVIEW_PID` | 开发模式 WebView PID | Dev 模式 |
| `CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH` | 跳过 CU 规范刷新 | Computer Use |
| `CODEX_ELECTRON_ENABLE_W` | 启用 WSL | Windows |
| `CODEX_TRACE_SHORTCUT` | 启用追踪录制快捷键 | 调试 |
| `CODEX_NATIVE_DESKTOP_APP_ICON_PATH` | 自定义 Dock 图标路径 | Windows |
| `OPENAI_API_KEY` | API Key | 认证 |
| `NODE_ENV` | Node 环境 | 全局 |
| `ELECTRON_RENDERER_URL` | Dev 服务器 URL | 开发模式 |

---

## 8. SSH WebSocket 隧道

```typescript
// 从 app-session.js 和 main.js 提取的 SSH 隧道相关代码

const SSH_WEBSOCKET_V0 = "ssh_websocket_v0";

// 环境变量过滤（传递给 SSH 连接时清理）
const BLOCKED_ENV_VARS = new Set([
  "INIT_CWD", "npm_command", "npm_execpath", "npm_node_execpath",
  "PNPM_PACKAGE_NAME", "PNPM_SCRIPT_SRC_DIR",
]);
const BLOCKED_ENV_PREFIXES = ["npm_config_", "npm_lifecycle_", "npm_package_"];

// SSH 用户环境加载（300ms 超时 + 5000ms 总体超时）
async function loadSSHUserEnv(): Promise<{ status: "loaded" | "failed" | "timed_out"; userEnv?: Record<string, string> }> {
  // 1. 从 app-server 获取 SSH 环境
  // 2. 超时保护: 5000ms 整体, 300ms 作为 abort 触发
  // 3. 失败重试逻辑
  // 4. 开发环境不过滤 npm 环境变量
}

// CLI 路径检测
function resolveCliPath(): string | null {
  // 1. process.env.CODEX_CLI_PATH
  // 2. which("codex") in PATH
  // 3. 内置路径 fallback
}
```

---

## 9. Tray 和全局快捷键

```typescript
// Tray 图标（macOS 菜单栏）
const tray = new electron.Tray(trayIconPath);
// 在 main.js 中检测到 1 处 Tray() 实例化

// 全局快捷键（2 处 globalShortcut 调用）
// 用于 Hotkey Window 和 Dictation 功能
```

---

## 10. Worker 线程

**文件**：`.vite/build/worker.js` (1.2 MB)

Worker 线程的模块依赖展示了它处理的任务：

```typescript
// Worker 线程引入的 Node.js 内置模块
const worker_threads = require("worker_threads");
const child_process = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const stream = require("stream");
const zlib = require("zlib");
const readline = require("readline");
const string_decoder = require("string_decoder");
const url = require("url");
const dns = require("dns/promises");
const buffer = require("buffer");
const async_hooks = require("async_hooks");
const diagnostics_channel = require("diagnostics_channel");
const events = require("events");
const tslib = require("tslib");
```

Worker 线程的职责范围：
- **HTTP 客户端**：所有出站 API 请求
- **TCP/TLS 连接**：远程控制、SSH 隧道
- **文件系统**：大文件读写、流式处理
- **子进程管理**：Shell 命令执行、PTY
- **诊断**：性能追踪、内存监控
- **异步上下文追踪**：async_hooks 用于请求链路追踪
