# Codex App 项目架构分析报告

> 分析日期：2026-05-14 | App 版本：26.506.31421 (Build 2620) | 来源：`/Applications/Codex.app` ASAR 逆向

---

## 1. 项目概览

| 属性 | 值 |
|------|-----|
| 项目名 | `openai-codex-electron` |
| 产品名 | Codex |
| 作者 | OpenAI |
| 版本 | 26.506.31421 |
| Electron | 41.2.0 |
| 构建工具 | Vite 8.0.3 + electron-forge |
| 语言 | TypeScript 5.9.3 |
| 包管理 | pnpm (workspace monorepo) |
| 平台 | macOS arm64 |

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Codex App                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   RENDERER PROCESS                        │   │
│  │  ┌────────────────────────────────────────────────────┐  │   │
│  │  │  React SPA (webview/index.html)                     │  │   │
│  │  │  ├── index-BCyxq2Zd.js (主入口)                     │  │   │
│  │  │  ├── .NET/WASM Runtime ── Office 文档渲染            │  │   │
│  │  │  │   ├── dotnet.native.wasm (1.5 MB)                │  │   │
│  │  │  │   ├── System.Private.CoreLib.wasm (1.5 MB)       │  │   │
│  │  │  │   ├── Walnut.wasm (1.7 MB)                       │  │   │
│  │  │  │   ├── DocumentFormat.OpenXml.* (4.5 MB)          │  │   │
│  │  │  │   └── Google.Protobuf.wasm (308 KB)              │  │   │
│  │  │  ├── Monaco/CodeMirror 语法高亮                       │  │   │
│  │  │  ├── KaTeX 数学公式渲染                               │  │   │
│  │  │  └── PDF 预览面板                                     │  │   │
│  │  └────────────────────────────────────────────────────┘  │   │
│  │                                                           │   │
│  │  ┌────────────────────────────────────────────────────┐  │   │
│  │  │  Comment Sidebar Runtime (comment-preload.js 35MB)  │  │   │
│  │  │  ├── 浏览器侧边栏评论系统                              │  │   │
│  │  │  ├── 截图标注与编辑器恢复                              │  │   │
│  │  │  └── Agent 浏览器控制交互                              │  │   │
│  │  └────────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                            │                                     │
│              contextBridge / ipcRenderer                        │
│                            │                                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   PRELOAD LAYER                            │   │
│  │  ┌──────────────────┐  ┌─────────────────────────────┐   │   │
│  │  │ preload.js        │  │ sandbox-preload.js           │   │   │
│  │  │ ├── electronBridge│  │ ├── Origin 验证              │   │   │
│  │  │ ├── windowType     │  │ ├── MCP App Sandbox 消息     │   │   │
│  │  │ ├── SharedObject   │  │ ├── Skybridge 协议           │   │   │
│  │  │ ├── Theme Sync     │  │ └── Port-based MessagePassing│   │   │
│  │  │ └── Worker Messages│  │                              │   │   │
│  │  └──────────────────┘  └─────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                            │                                     │
│                  ipcMain (Electron IPC)                          │
│                            │                                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    MAIN PROCESS                           │   │
│  │                                                           │   │
│  │  bootstrap.js ──> app-session.js ──> main.js              │   │
│  │  (入口点)         (核心配置/状态)       (Window/IPC 主逻辑) │   │
│  │                                                           │   │
│  │  核心模块:                                                 │   │
│  │  ├── BrowserWindow 管理 (多窗口 + 工作区)                  │   │
│  │  ├── Session 分区管理 (session.fromPartition)             │   │
│  │  ├── Sparkle 自动更新                                     │   │
│  │  ├── Sentry 错误追踪                                      │   │
│  │  ├── macOS Native Bridge (objc-js)                        │   │
│  │  ├── SSH WebSocket 隧道                                   │   │
│  │  ├── CLI 集成 (codex CLI path)                            │   │
│  │  ├── Tray 图标                                            │   │
│  │  ├── 上下文菜单 (electron-context-menu)                   │   │
│  │  └── 全局快捷键                                           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                            │                                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   NATIVE LAYER                             │   │
│  │  ┌──────────────────┐  ┌──────────────────────────────┐  │   │
│  │  │ Node Addons       │  │ Native Executables            │  │   │
│  │  │ ├── better-sqlite3│  │ ├── launch-services-helper     │  │   │
│  │  │ ├── node-pty      │  │ ├── bare-modifier-monitor      │  │   │
│  │  │ ├── objc-js       │  │ ├── sparkle.node               │  │   │
│  │  │ ├── bufferutil    │  │ ├── browser-use-peer-auth      │  │   │
│  │  │ └── utf-8-validate│  │ └── remote-control-device-key  │  │   │
│  │  └──────────────────┘  └──────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   WORKER THREAD                            │   │
│  │  worker.js (1.2 MB)                                       │   │
│  │  ├── HTTP/HTTPS 客户端                                     │   │
│  │  ├── TCP/TLS 连接管理                                      │   │
│  │  ├── 文件系统操作 (fs/promises)                            │   │
│  │  ├── 子进程管理 (child_process)                            │   │
│  │  ├── 加密操作 (crypto)                                     │   │
│  │  ├── Async Hooks 上下文追踪                                │   │
│  │  └── 诊断通道 (diagnostics_channel)                        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   PLUGIN SYSTEM                            │   │
│  │  marketplace.json → openai-bundled                         │   │
│  │  ├── browser-use: 应用内浏览器自动化                         │   │
│  │  ├── chrome: Chrome 浏览器控制                              │   │
│  │  ├── computer-use: macOS 桌面自动化                         │   │
│  │  └── latex-tectonic: LaTeX 渲染                            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 进程架构详解

### 3.1 Bootstrap 启动流程

```
app.whenReady()
  ├── Intel-on-Apple-Silicon 警告检测
  ├── 设置 app name + userData path
  ├── 检查单实例锁 (requestSingleInstanceLock)
  ├── Sparkle 初始化
  ├── import('./main-DnQgBHvi.js') → runMainAppStartup()
  └── 错误处理 → 显示错误对话框
```

**关键文件**：`.vite/build/bootstrap.js` (3.7 KB) — 轻量级入口，负责启动前检查和主模块加载。

### 3.2 App Session 模块

**文件**：`.vite/build/app-session-tZw_L1R0.js` (4.3 MB)

这是 Codex 的核心配置和状态管理模块，包含：
- **WASM 绑定层** (`__wbindgen_*` exports) — Rust/Go 编译的核心逻辑通过 WASM 集成到主进程
- **Session 分区管理** — 通过 `session.fromPartition` 创建隔离的浏览器会话
- **SharedObject** — 主进程和渲染进程之间的共享状态管理
- **环境变量管理** — CLI 路径检测、用户环境注入

### 3.3 Main 主进程

**文件**：`.vite/build/main-DnQgBHvi.js` (1.1 MB)

核心能力：
- 多 BrowserWindow 管理（`setAlwaysOnTop` + `setVisibleOnAllWorkspaces`）
- macOS 原生 API 调用（通过 objc-js：`NSWindow`, `NSWorkspace`, `NSApplication`）
- SSH WebSocket 隧道（用于远程开发）
- 全局快捷键 + Tray 图标
- 上下文菜单 (`electron-context-menu`)
- Sentry 错误上报 + 崩溃追踪

### 3.4 Preload 层

| 文件 | 大小 | 用途 |
|------|------|------|
| `preload.js` | 2.3 KB | 主 preload，暴露 `electronBridge` API |
| `sandbox-preload.js` | 1.9 KB | MCP App Sandbox 安全验证和 Port 消息传递 |
| `comment-preload.js` | 34.8 MB | 浏览器侧边栏运行时（React + 评论系统） |

**preload.js 暴露的 API**：
```typescript
window.electronBridge = {
  sendMessageFromView,       // → 'codex_desktop:message-from-view'
  getPathForFile,            // webUtils.getPathForFile
  sendWorkerMessageFromView, // → 'codex_desktop:worker:*:from-view'
  subscribeToWorkerMessages, // ← 'codex_desktop:worker:*:for-view'
  showContextMenu,           // 应用上下文菜单
  showApplicationMenu,       // 应用菜单栏
  getSharedObjectSnapshotValue, // 共享状态读取
  getSystemThemeVariant,     // 系统主题
  getSentryInitOptions,      // Sentry 初始化参数
  getBuildFlavor,            // 构建类型
}
```

### 3.5 Worker 线程

**文件**：`.vite/build/worker.js` (1.2 MB)

独立的 Worker 线程，处理：
- 网络 I/O（HTTP/HTTPS/TCP/TLS/WebSocket）
- 文件系统操作（含流式读写）
- 加密操作
- 子进程管理（含 PTY）
- 诊断和性能追踪

---

## 4. 渲染进程（Webview）

### 4.1 入口

`webview/index.html` 加载 React SPA：

```html
<script type="module" src="./assets/index-BCyxq2Zd.js"></script>
<link rel="modulepreload" href="./assets/preload-helper-DDNUbuXK.js">
<link rel="modulepreload" href="./assets/chunk-Bj-mKKzh.js">
<link rel="modulepreload" href="./assets/path-browserify-fgDTXxoN.js">
<link rel="modulepreload" href="./assets/src-CVmnixyG.js">
```

### 4.2 CSP 安全策略

```text
default-src 'none'
img-src 'self' app: blob: data: https:
child-src 'self' blob: https://*.web-sandbox.oaiusercontent.com
frame-src 'self' blob: https://*.web-sandbox.oaiusercontent.com
worker-src 'self' blob:
script-src 'self' 'wasm-unsafe-eval'
connect-src 'self' https://ab.chatgpt.com https://cdn.openai.com
```

### 4.3 .NET/WASM 运行时

Webview 内嵌完整的 .NET 运行时（通过 WASM），用于 Office 文档处理：

| WASM 模块 | 大小 | 用途 |
|-----------|------|------|
| `dotnet.native.wasm` | 1.5 MB | .NET 原生运行时 |
| `System.Private.CoreLib.wasm` | 1.5 MB | .NET Core 基础库 |
| `Walnut.wasm` | 1.7 MB | 内部核心组件（推测：文档解析引擎） |
| `DocumentFormat.OpenXml.*` | 4.5 MB | Office OpenXML 格式支持 |
| `Google.Protobuf.wasm` | 308 KB | Protocol Buffers |
| 其他 `System.*.wasm` | ~2.3 MB | XML, Linq, IO, Security 等 |

---

## 5. 原生模块层

### 5.1 Node Addons (C++)

| 模块 | 路径 | 用途 |
|------|------|------|
| `better-sqlite3` | `node_modules/better-sqlite3` | 本地 SQLite 数据库 |
| `node-pty` | `node_modules/node-pty` | 伪终端 (PTY)，终端模拟 |
| `objc-js` | `node_modules/objc-js` | macOS Objective-C 桥接 |
| `bufferutil` | (workspace dep) | WebSocket buffer 优化 |
| `utf-8-validate` | (workspace dep) | UTF-8 校验优化 |

### 5.2 原生可执行文件

| 文件 | 类型 | 用途 |
|------|------|------|
| `launch-services-helper` | Mach-O arm64 | macOS 应用信息查询（bundleId, displayName） |
| `bare-modifier-monitor` | Mach-O arm64 | 裸修饰键监控（Cmd/Option/Ctrl 单独按下事件） |
| `sparkle.node` | Mach-O bundle | Sparkle 自动更新框架 |
| `browser-use-peer-authorization.node` | Mach-O bundle | 浏览器对等授权 |
| `remote-control-device-key.node` | Mach-O bundle | 远程控制设备密钥 |

### 5.3 objc-js macOS API 使用

通过 objc-js 调用的 macOS API：
- `NSWindow.setAlwaysOnTop` — 窗口置顶
- `NSWindow.setVisibleOnAllWorkspaces` — 所有工作区可见
- `NSWorkspace` — 应用启动和文件关联
- `NSApplication` — 应用生命周期管理
- Accessibility API (`AXUIElement`) — Computer Use 的桌面自动化

---

## 6. 插件系统

### 6.1 架构

```
plugins/openai-bundled/
├── .agents/plugins/marketplace.json    ← 插件注册中心
├── plugins/
│   ├── browser-use/    ← 应用内浏览器（Playwright-based）
│   ├── chrome/         ← Chrome 浏览器控制
│   ├── computer-use/   ← macOS 桌面自动化
│   └── latex-tectonic/ ← LaTeX 编译（Tectonic 引擎）
```

### 6.2 插件详情

| 插件 | 版本 | 类型 | MCP Server | 描述 |
|------|------|------|------------|------|
| browser-use | 0.1.0-alpha2 | Engineering | Node REPL | 应用内浏览器自动化，支持 localhost 测试 |
| chrome | 0.1.7 | Productivity | - | Chrome 浏览器控制，含扩展安装 |
| computer-use | 1.0.780 | Productivity | SkyComputerUseClient | macOS 桌面应用控制（Accessibility API） |
| latex-tectonic | - | Research | - | LaTeX 文档编译渲染 |

### 6.3 Computer Use 架构

```
Codex Computer Use.app/
  └── Contents/SharedSupport/
      └── SkyComputerUseClient.app/    ← 独立的 macOS 应用
          └── Contents/MacOS/
              └── SkyComputerUseClient  ← MCP Server 进程
```

Computer Use 通过独立的 MCP Server 进程实现 macOS 桌面自动化，与主 Electron 进程通过 MCP 协议通信。

---

## 7. 数据流与通信

```
用户输入 (Renderer React SPA)
  │
  ├──→ electronBridge.sendMessageFromView()
  │      └── ipcRenderer.invoke('codex_desktop:message-from-view')
  │             └── ipcMain.handle() → 主进程处理
  │
  ├──→ electronBridge.sendWorkerMessageFromView()
  │      └── Worker Thread (HTTP/文件/Shell 操作)
  │
  ├──→ SharedObject (同步状态)
  │      └── 主进程 ↔ 渲染进程双向同步
  │
  ├──→ MCP App Sandbox
  │      └── sandbox-preload.js → Port 消息传递
  │
  └──→ Plugin MCP Servers
         ├── computer-use: SkyComputerUseClient (macOS 自动化)
         └── browser-use: Node REPL (浏览器自动化)
```

---

## 8. 依赖关系图

```
openai-codex-electron
├── Electron 41.2.0
├── @sentry/electron ── 错误追踪
├── @electron-forge/* ── 构建/打包/签名/公证
├── Vite 8.0.3 ── 前端/主进程打包
├── TypeScript 5.9.3 ── 类型系统
│
├── [Native Addons]
│   ├── better-sqlite3 12.8.0 ── 本地数据库
│   ├── node-pty 1.1.0 ── PTY 终端
│   ├── objc-js 1.5.0 ── macOS 桥接
│   ├── bufferutil ── WebSocket 优化
│   └── utf-8-validate ── UTF-8 校验
│
├── [Workspace Packages]
│   ├── app-server-types ── 服务端类型
│   ├── commands ── 命令系统
│   ├── protocol ── 通信协议
│   ├── shared-node ── 共享 Node 工具
│   └── external-agent-migration ── 外部 Agent 迁移
│
├── [Browser Use Libraries]
│   ├── browser-api ── 浏览器 API
│   ├── browser-backend-common ── 后端通用
│   └── browser-common ── 浏览器通用
│
├── lodash ── 工具函数
├── ws ── WebSocket
├── zod 4.1.13 ── Schema 验证
├── smol-toml ── TOML 解析
├── shlex ── Shell 参数解析
├── ssh-config ── SSH 配置解析
├── which ── 可执行文件查找
├── mime-types ── MIME 类型
├── mdast-util-* ── Markdown AST
└── tslib ── TypeScript 运行时
```

---

## 9. 安全架构

1. **进程隔离**：渲染进程通过 `contextBridge` 暴露有限 API，使用 `sandbox: true`
2. **CSP 限制**：严格的 Content-Security-Policy，只允许特定域名连接
3. **Origin 验证**：sandbox-preload.js 严格验证 `web-sandbox.oaiusercontent.com` 域名
4. **Skybridge 协议**：MCP App 之间通过 Port-based MessagePassing 隔离通信
5. **资源访问**：文件路径通过 `webUtils.getPathForFile` 安全转换

---

## 10. 关键发现总结

1. **WASM 双重用途**：
   - 渲染进程：.NET/WASM 运行时用于 Office 文档渲染
   - 主进程：Rust/Go WASM 模块用于核心业务逻辑

2. **插件化架构**：通过 Codex Plugin 系统（marketplace.json + .codex-plugin/plugin.json）管理扩展，MCP 协议作为插件通信标准

3. **macOS 深度集成**：objc-js 桥接层 + 5 个原生可执行文件，深度使用 macOS Accessibility API、NSWorkspace、Sparkle

4. **多窗口 + 工作区**：Session 分区 + setVisibleOnAllWorkspaces + BrowserWindow 管理，支持跨工作区的窗口布局

5. **Worker 线程分离**：重量级 I/O 操作（网络、文件、子进程）通过独立 Worker 线程执行，避免阻塞主进程
