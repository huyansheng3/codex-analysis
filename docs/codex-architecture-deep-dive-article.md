# OpenAI Codex 桌面应用架构深度解读：当 AI 开始操控你的电脑

> 本文基于对 Codex macOS 桌面应用（版本 26.506.31421）的架构分析，从技术科普视角，解读这款 AI 编程助手背后的系统设计哲学、工程实现细节和安全边界思考。

---

## 引言：AI 不只是聊天，它要动手了

2025 年，AI 编程助手已经从"给你代码建议"进化到了"直接帮你写代码、运行代码、甚至操控你的电脑完成整个开发任务"。OpenAI 的 Codex 桌面应用正是这一趋势的标志性产品——它不仅是一个聊天窗口，更是一个具备文件读写、终端操作、浏览器控制甚至桌面自动化能力的"AI 操作员"。

这背后是怎样的架构设计？一个 AI Agent 如何安全地获得对用户电脑的操控权？这些能力又带来了哪些安全隐患？

本文将从五个维度拆解 Codex 的技术架构：**进程模型与启动机制**、**通信与数据流转**、**插件化能力扩展**、**Computer Use 桌面自动化**、以及**安全边界与攻击面**。这不仅仅是对一款产品的技术解读，更是对"AI Agent 如何与物理世界交互"这一前沿课题的深度思考。

---

## 一、进程模型：不是单兵作战，而是团队协作

### 1.1 多进程架构：Electron 的老故事，Codex 的新演绎

Codex 基于 Electron 41.2.0 构建，这意味着它天然继承了 Chromium 的多进程架构——主进程、渲染进程、GPU 进程各自独立运行。但 Codex 在这个基础上做了大量定制，让它远超一个普通的 Electron 应用。

**核心进程分工如下：**

- **主进程（Main Process）**：1.1 MB 的 `main.js` 是整个应用的指挥中枢，负责窗口管理、IPC 调度、原生 API 调用、Sparkle 自动更新和 Sentry 错误追踪。
- **渲染进程（Renderer Process）**：React SPA 作为用户交互的载体，承载了从对话界面到代码编辑器的全部前端功能。更引人注目的是，渲染进程内嵌了完整的 .NET/WASM 运行时——包括 `dotnet.native.wasm`（1.5 MB）、`Walnut.wasm`（1.7 MB）和 `DocumentFormat.OpenXml` 系列（4.5 MB），用于在浏览器中直接渲染 Office 文档。这意味着 Codex 可以在本地解析 Word、Excel、PowerPoint 文件，而不需要依赖任何外部服务。
- **Worker 线程**：1.2 MB 的 `worker.js` 是一个独立运行的重量级线程，专门处理所有阻塞型操作——HTTP/HTTPS 请求、TCP/TLS 连接、文件系统读写、子进程管理和加密操作。将这些操作从主进程中剥离出来，确保了 UI 响应的流畅性。
- **Preload 层**：作为主进程和渲染进程之间的桥梁，`preload.js` 暴露了 `electronBridge` API，`sandbox-preload.js` 处理 MCP 沙箱通信，而 `comment-preload.js`（35 MB！）承载了完整的浏览器侧边栏评论系统运行时。

**启动流程的优雅设计值得单独一提：**

Codex 的启动不是粗暴的"一把梭"，而是分阶段渐进加载：

1. **Bootstrap 阶段**（`bootstrap.js`，仅 3.7 KB）：轻量级入口，只做最必要的事——设置应用名、检测单实例锁、检查是否在 Apple Silicon 上运行 Intel 版本（是的，它会警告并退出）、初始化 Sparkle 更新框架。
2. **App Session 阶段**（`app-session.js`，4.3 MB）：核心配置和状态管理模块，包含 WASM 绑定层（大量 `__wbindgen_*` 导出函数表明核心逻辑由 Rust 编写，通过 wasm-bindgen 桥接到 JS）、Session 分区管理、SharedObject 共享状态。
3. **Main 阶段**（`main.js`）：真正开始创建窗口、注册 IPC、启动功能模块。

如果启动失败，Codex 不是简单崩溃退出——它会弹出错误对话框，提供"安装已有更新"、"检查新更新"或"退出"三个选项。这种用户友好的错误恢复机制，体现了产品级应用的成熟度。

### 1.2 Session 分区：每个对话都有自己的浏览器空间

Codex 使用 Electron 的 `session.fromPartition()` 创建了精细的浏览器会话隔离：

```
persist:main          → 主窗口的独立会话
persist:worker        → Worker 线程的独立会话
persist:webview       → WebView 的独立会话
persist:thread-{id}   → 每个对话 Thread 的独立会话
```

这意味着每个对话线程都有自己的 Cookie 存储、Cache 和 LocalStorage。你在一个对话中登录的网站状态，不会泄漏到另一个对话中。这种设计既保护了用户隐私，也避免了不同任务之间的状态干扰。

### 1.3 WASM 的双重角色：渲染引擎与核心逻辑的交汇

Codex 中 WASM 的使用非常独特——它同时出现在两个完全不同的上下文中：

**渲染进程中的 WASM**：.NET 运行时通过 WASM 编译到浏览器中运行，使得 Codex 可以在本地解析 Office OpenXML 格式文档。这是一个工程上的巧思——你不需要安装 Office，不需要调用远程 API，WASM 让 .NET 的文档处理能力直接在浏览器沙箱中运行。

**主进程中的 WASM**：通过 `wasm-bindgen` 桥接的 Rust 模块处理核心业务逻辑。大量 `__wbindgen_*` 导出函数的存在表明，Codex 将性能敏感或安全关键的代码用 Rust 编写，编译为 WASM 在主进程中执行。这比纯 JavaScript 实现更安全——WASM 模块的内存布局对 JS 层不可见，攻击者即使通过 XSS 获得 JS 执行权，也很难直接操纵 WASM 内部的数据结构。

---

## 二、通信与数据流转：18 条 IPC 通道织成的神经网络

### 2.1 electronBridge：渲染进程的"外交部门"

渲染进程不能直接调用 Node.js API——这是 Electron 安全模型的基本约束。Codex 通过 `preload.js` 中的 `contextBridge.exposeInMainWorld()` 暴露了一个精心设计的 `electronBridge` 接口，作为渲染进程与主进程沟通的唯一合法渠道。

这个接口的核心方法包括：

- `sendMessageFromView()`：向主进程发送消息，覆盖 50+ 种消息类型
- `sendWorkerMessageFromView()`：直接向 Worker 线程派发任务
- `getSharedObjectSnapshotValue()`：读取主进程和所有渲染进程之间的共享状态
- `showContextMenu()` / `showApplicationMenu()`：触发原生 UI
- `getSentryInitOptions()`：获取错误追踪配置
- `getBuildFlavor()`：获取构建类型（prod/staging/dev/agent）

**SharedObject 机制是一个值得关注的创新：**

SharedObject 是主进程和所有渲染进程之间的双向同步状态管理器。渲染进程通过 `sendMessageFromView({ type: 'shared-object-set', key, value })` 写入，主进程通过广播 `{ type: 'shared-object-updated' }` 通知所有窗口。这比传统的"每个窗口各自请求"模式更高效——状态变更一次推送，所有消费者即时感知。

但这也意味着：任何一个渲染进程写入的 key，所有其他渲染进程都可以立即读取。这个设计在便利性和安全性之间做了权衡。

### 2.2 50+ 消息类型：二级路由的精巧设计

Codex 的 IPC 通道不是"一通道一功能"的粗放设计。它采用了**通道 + 类型二级路由**的模式：

主消息通道 `codex_desktop:message-from-view` 和 `codex_desktop:message-for-view` 通过 JSON payload 的 `type` 字段进行二次分发，涵盖了窗口路由（7 种）、应用状态（12 种）、Hotkey Window 事件（5 种）、更新生命周期（4 种）、命令系统（5 种）、通知（3 种）等 50+ 种消息类型。

这种设计的优势在于：新增消息类型只需要在路由表中增加一个 case，不需要注册新的 IPC 通道。劣势在于：如果主进程对消息类型的校验不够严格，任何渲染进程都可以尝试发送任意类型的消息——这是一个安全隐患，我们后面会详细讨论。

### 2.3 MCP Sandbox Skybridge：插件世界的安全边界

Codex 为 MCP（Model Context Protocol）应用构建了一套完整的沙箱通信体系。

`sandbox-preload.js` 严格验证只有来自 `web-sandbox.oaiusercontent.com` 域名的 HTTPS 连接才能进入沙箱——不允许端口、不允许用户名密码、不允许子域名外的任何域名。这构建了一道坚固的网络边界。

沙箱内通过 **Port-based MessagePassing** 进行通信，11 个白名单端口名覆盖了 MCP 工具调用、资源清理、Widget 代码执行、主题设置等核心功能。每个端口名都经过验证，防止了随意注入额外通信渠道的可能。

### 2.4 Deep Link：从外部世界进入 Codex 的门户

Codex 注册了 `codex://` 自定义协议，支持从浏览器、邮件或其他应用直接跳转到特定功能：

- `codex://newThread?prompt=...`：创建新对话并注入初始 prompt
- `codex://settings`：跳转到设置页面
- `codex://pluginInstall?pluginName=...`：安装插件
- `codex://connectorOAuthCallback`：处理 OAuth 回调

Deep Link 是一把双刃剑——它让 Codex 与外部世界的集成更顺畅，但也打开了从外部注入指令的窗口。如果 prompt 参数未经充分过滤，就可能成为 Agent 注入攻击的入口。

---

## 三、插件化能力扩展：AI 的四肢与感官

### 3.1 Marketplace + Plugin + Skill：三层能力体系

Codex 的能力扩展不是简单的"装个插件"，而是构建了三层递进的能力体系：

**Marketplace Registry**（`marketplace.json`）：插件注册中心，定义了插件的来源、安装策略、认证要求和分类（Engineering / Productivity / Research）。内置的 `openai-bundled` marketplace 包含四个官方插件。

**Plugin Manifest**（`.codex-plugin/plugin.json`）：每个插件的完整描述——名称、版本、作者、功能描述（给 LLM 读的！）、界面信息、MCP Server 配置、Skills 路径。值得注意的是，插件描述是**为 LLM Agent 编写的**——这意味着插件如何被触发、如何被使用，是 AI 自己通过阅读描述来决定的。

**Skills System**（`SKILL.md`）：Markdown 格式的指令文件，为 LLM 提供特定任务的详细操作手册。当 Agent 需要使用某个插件时，它先阅读对应的 SKILL.md，学习正确的操作流程、约束条件和故障排除方法。

这种设计的哲学是：**不是人类教 AI 用工具，而是工具自己向 AI 解释如何被使用。**

### 3.2 四个内置插件：从浏览网页到操控桌面

#### browser-use：应用内浏览器自动化

让 Codex 控制应用内嵌入的浏览器页面，支持 localhost、127.0.0.1 和 file:// URL。它通过 Node REPL MCP Server 暴露浏览器 API——`browser.tabs.list()`、`browser.navigate(url)`、`browser.click(selector)`、`browser.screenshot()` 等。

关键限制：只允许本地 URL，不能直接访问外部网站。这降低了数据泄漏的风险，但也限制了能力范围。

#### chrome：真实浏览器控制

与 browser-use 不同，chrome 插件通过 Chrome Extension + Native Messaging 与用户的真实 Chrome 浏览器交互。这意味着 Codex 可以访问用户已经登录的网站——带着用户的 Cookie、Session 和已安装的扩展。

这是一个高风险高收益的设计：它让 Codex 可以"以用户的身份"浏览网页，但这也意味着理论上可以访问用户的银行账户、社交平台等任何已登录的站点。Codex 通过"首次访问新网站需用户批准"的机制来缓解这一风险。

#### computer-use：macOS 桌面自动化（最重磅的能力）

这是 Codex 最具革命性的能力——让 AI 直接操控 macOS 桌面上的任意应用。它的架构极其复杂，我们将在下一节专门解读。

#### latex-tectonic：LaTeX 编译渲染

一个相对温和的能力扩展——使用 Rust 编写的 Tectonic 引擎编译 LaTeX 文档。但即便是 LaTeX 编译器也存在安全风险：`\write18{shell command}` 可以执行任意 shell 命令。Codex 目前没有对这一风险做特殊防护。

### 3.3 插件生命周期：从发现到安装到运行

插件安装遵循清晰的流程：从 Marketplace 获取元数据 → 复制到本地 plugins 目录 → 读取 plugin.json → 注册 MCP Server → 注册 Skills → 设置认证 → 标记为 AVAILABLE。

内置插件有特殊处理：`computer-use` 自动安装（用户可以选择退出），`in-app-browser` 强制刷新并需要 Feature Flag 启用，`external-browser` 和 `codex-cli` 受构建类型约束。

---

## 四、Computer Use：当 AI 获得了手和眼睛

这是整篇文章最核心、也最值得深思的部分。

### 4.1 双进程架构：服务端与客户端的职责分离

Computer Use 不是在 Electron 进程内直接调用 macOS API——它采用了**双 Swift 原生进程**的架构：

- **SkyComputerUseService**（GUI 服务进程）：独立 macOS 应用（Bundle ID: `com.openai.sky.CUAService`），拥有 Accessibility 和 Screen Recording 系统权限，负责实际的 UI 操作——读取 Accessibility Tree、截图、模拟键盘鼠标输入。它是 LSUIElement 应用（无 Dock 图标，仅菜单栏），低调地运行在后台。
- **SkyComputerUseClient**（CLI MCP Server 进程）：由 Electron 主进程 spawn 的子进程，通过 stdin/stdout JSON-RPC（MCP 协议）与 Codex Agent 通信。它不直接拥有系统权限，而是通过 Apple Events IPC 委托给 Service 进程执行实际操作。

为什么要分成两个进程？

**权限隔离**。在 macOS 的安全模型中，Accessibility 和 Screen Recording 是高敏感权限——一旦授予，进程就可以读取屏幕上所有内容、模拟任意用户输入。将这些权限只授予 Service 进程，而 Client 进程只负责协议翻译，意味着：即使 Client 进程被攻破，攻击者仍然需要绕过 Service 进程的代码签名验证才能获得实际操控权。

这是一个教科书式的**最小权限原则**实践。

### 4.2 九个 MCP Tools：AI 操控桌面的完整接口

Computer Use 向 LLM Agent 暴露了 9 个 MCP Tools，构成了操控 macOS 桌面的完整 API：

| Tool | 功能 | 核心机制 |
|------|------|----------|
| `list_apps` | 列出运行中和最近 14 天使用的应用 | NSWorkspace.runningApplications |
| `get_app_state` | 获取应用的窗口状态、Accessibility Tree 和截图 | AXUIElement + SCShareableContent |
| `click` | 点击 UI 元素或指定坐标 | AXUIElementPerformAction / CGEventPost |
| `perform_secondary_action` | 执行辅助 Accessibility 操作 | AXUIElement secondary actions |
| `set_value` | 设置可编辑 UI 元素的值 | AXUIElementSetAttributeValue |
| `scroll` | 在指定方向滚动 UI 元素 | Accessibility scroll actions |
| `drag` | 从一点拖拽到另一点 | CGEventCreateMouseEvent |
| `press_key` | 按下按键或组合键（支持 xdotool 语法） | CGEventCreateKeyboardEvent |
| `type_text` | 输入文字 | CGEventCreateKeyboardEvent + 键盘布局映射 |

这套 API 的设计哲学是：**先观察，再行动，行动后验证**。

每个 Assistant Turn 开始时，Agent 必须先调用 `get_app_state` 获取当前应用的 Accessibility Tree 和截图，然后分析 UI 结构找到目标元素，执行操作后再次调用 `get_app_state` 验证结果。这不是一次性指令执行，而是持续的"感知-决策-行动-验证"循环。

### 4.3 权限审批：三层防线

Computer Use 的权限管理不是简单的"授予/拒绝"二元选择，而是构建了三层防线：

**第一层：macOS TCC 系统权限。** 用户必须在系统设置中授予 Accessibility 和 Screen Recording 权限。这是硬件级的门槛——即使 Codex 被完全攻破，没有这两个权限，Computer Use 也无法运作。

**第二层：应用级审批。** 每次首次操控一个新应用时，Codex 通过 MCP Elicitation 向用户发出请求："Allow Codex to use {appName}?" 并附带风险警告。用户可以选择"仅允许一次"或"永久允许"。审批状态存储在 SQLite 数据库中，支持 session、forever 和 timed 三种持久化级别。

**第三层：密码管理器硬阻止。** 1Password、Bitwarden、Dashlane、LastPass、NordPass、Proton Pass 等密码管理器被硬编码在阻止列表中——Computer Use 永远不能操控这些应用。这是一个有远见的安全决策：密码管理器是用户数字身份的最后一道防线，AI 不应该有能力触及它。

不过，这个阻止列表基于 Bundle ID 匹配，理论上可以通过修改应用 Bundle ID 来绕过。这是一个"低难度"的绕过点——OpenAI 显然认为这种攻击场景不够现实，不值得投入更多防御资源。

### 4.4 应用特定指令：AI 的"操作手册"

Computer Use 不是对所有应用一视同仁——它为 6 个常用应用内置了专门的操作指令：

Spotify、Notion、Numbers、Clock、Apple Music、iPhone Mirroring，每个应用都有独立的 Markdown 文件（`AppInstructions/{AppName}.md`），包含该应用的 UI 特殊行为、操作注意事项和等待策略。

例如，对 Spotify 的指令包括："播放状态不会立即更新，操作后必须先 `get_app_state` 验证"；"搜索前确保搜索框已获得焦点"；"需要等待网络响应后再验证结果"。

这些指令在首次使用某个应用时，通过 `AppInstructionDeliveryState` 动态注入到 MCP Tool 的描述中，让 Agent 在操作前就能学习该应用的特殊行为。

### 4.5 Turn 生命周期：每次对话都是一场微型任务

一个完整的 Computer Use Turn 不是一个简单的"发指令→执行"，而是包含多个步骤的编排式任务。以"帮我在 Spotify 搜索 Discover Weekly"为例：

1. Agent 读取 SKILL.md 学习操作规范
2. 调用 `list_apps` 发现 Spotify 已运行
3. 调用 `get_app_state("Spotify")` 获取当前 UI 状态和截图
4. Agent 分析 Accessibility Tree 找到 Search 文本框的 element index
5. 调用 `click(elementIndex=42)` 点击搜索框
6. 再次 `get_app_state` 验证搜索框已获得焦点
7. 调用 `type_text("Discover Weekly")` 输入搜索内容
8. 调用 `press_key("Return")` 确认搜索
9. 再次 `get_app_state` 验证搜索结果已加载
10. 调用 `click` 点击播放按钮
11. Turn 结束 → Service 自动停止 session

关键设计细节：**每个 Assistant Turn 结束后，Computer Use session 自动停止**。这意味着 AI 在一轮对话中获得的操控权不会延续到下一轮——每次都需要重新建立 session、重新获取审批。这是一种"任期制"的安全设计。

### 4.6 遥测系统：一切操作都被记录

Computer Use 的所有操作都通过 Protobuf 格式上报到 `chatgpt.com/ces/v1/rgstr`，包括：

- 服务启动事件
- 权限授予完成事件
- MCP Tool 调用事件
- 应用审批请求和结果事件
- Turn 性能指标（首次 get_app_state 耗时、首次写入操作耗时）

这意味着 OpenAI 对 Computer Use 的每一次使用都有完整的遥测记录——既用于产品改进，也用于安全审计。但这也引发了隐私问题：你的桌面操作数据被发送到了 OpenAI 的服务器。

---

## 五、安全边界：便利与风险的永恒博弈

### 5.1 四条完整攻击链

基于架构分析，Codex 存在四条从外部到完全系统控制的攻击链：

**攻击链 1：XSS → API Key 窃取**

渲染进程如果存在 XSS 漏洞（例如 Markdown 预览中的 HTML 注入），攻击者可以通过 `electronBridge.getSharedObjectSnapshotValue("openai-api-key")` 直接读取 OpenAI API Key，并通过 Worker 线程的网络请求外泄到远程服务器。

核心问题：API Key 以明文存储在 Electron Settings 中（路径：`~/Library/Application Support/Codex/`），任何 preload 脚本都可以通过 `ipcRenderer.sendSync("openai-api-key")` 同步读取。Codex 没有使用 macOS Keychain 来保护这个最敏感的凭据。

**攻击链 2：Deep Link → Agent 注入**

用户点击恶意链接 `codex://newThread?prompt=Ignore previous instructions...`，如果 prompt 参数未经充分过滤就直接传递给 Agent，可能导致 Agent 执行恶意指令——而 Agent 有文件读写、Shell 执行等能力。

**攻击链 3：Plugin → RCE**

用户安装恶意插件（包含恶意 MCP Server），MCP Server 作为子进程启动后拥有 Node.js 完全权限，可以通过 `objc-js` 获得对 macOS 的完全系统访问——任意 dlopen、NSClassFromString、objc_msgSend、libffi 调用。

**攻击链 4：Sparkle MITM → RCE**

攻击者在同一网络伪造 Sparkle 更新 Feed，使用自签名密钥签名恶意更新包。如果用户点击"Install Update"，恶意代码以 Codex 权限执行。虽然 Sparkle 使用 Ed25519 签名验证，但如果二进制文件本身被篡改（替换公钥），或存在 DNS 劫持条件，这条攻击链就可以闭合。

### 5.2 objc-js：最强能力与最大风险的交汇点

`objc-js` 是 Codex 与 macOS 原生世界之间的桥梁——它让 JavaScript 代码可以直接调用 Objective-C Runtime 的任何 API。这意味着：

- 启动任意应用（`NSWorkspace.sharedWorkspace().openURL()`）
- 读取系统文件（`NSData.dataWithContentsOfFile()`）
- 模拟键盘输入（Accessibility API 的 `AXUIElement`）
- 加载任意动态库（`dlopen`）
- 执行 shell 命令（`system()`）

**当前防护：无。**

objc-js 的设计哲学是"调用者已被信任"——它假设任何能调用到 objc-js 的代码都是合法的。这在传统的 Electron 应用中可能是合理的，但在一个 AI Agent 可以执行任意代码的系统中，这个假设就变得危险了。

如果攻击者通过 XSS 获得 JS 执行权，再通过 Worker 线程或 Node REPL 达到 Node.js 层，objc-js 就成了从 JS 到完全系统控制的最后一块跳板——而且这块跳板上没有任何护栏。

### 5.3 IPC 无调用者上下文验证

Codex 的 IPC 通道没有验证消息发送者的身份上下文。任何 preload 脚本暴露的渲染进程都可以：

- 发送任意类型的 IPC 消息
- 同步读取 API Key 和 Session Token
- 向 Worker 线程派发任意任务
- 读写 SharedObject 的所有 key

缺少的防护措施包括：消息内容白名单校验、IPC 通道速率限制、凭据读取审计日志、敏感通道的调用者上下文验证。

### 5.4 CSP 的局限：保护渲染进程，但管不了主进程

Codex 为渲染进程配置了严格的 CSP：

```
default-src 'none'
script-src 'self' 'wasm-unsafe-eval'
connect-src 'self' https://ab.chatgpt.com https://cdn.openai.com
```

但 CSP 只能约束渲染进程中的 Web 行为。主进程和 Worker 线程通过 Node.js 直接发起 HTTP 请求，完全不受 CSP 限制——它们可以直接连接任意 URL，外泄窃取的数据。

这是 Electron 应用的通病：**Web 安全模型和 Node.js 安全模型之间存在根本性的割裂**。CSP 保护了浏览器沙箱，但 Node.js 层是一片没有围墙的旷野。

### 5.5 好的设计：Secure Enclave 和代码签名验证

并非所有安全设计都有问题。Codex 在两个关键点上做了正确的事：

**Device Key 使用 Secure Enclave**：`remote-control-device-key.node` 使用 ECDSA P-256 密钥，私钥存储在 Apple Silicon 的 Secure Enclave 硬件中，不可导出。这意味着即使整个系统被攻破，远程控制的签名密钥仍然安全。

**对等授权使用代码签名验证**：`browser-use-peer-authorization.node` 通过 Unix Domain Socket 的 `LOCAL_PEERTOKEN` 获取对等进程的审计令牌，再用 `SecCodeCopyGuestWithAttributes` 验证对方的代码签名，检查 Bundle ID 和 Team ID（`2DC432GLL2`，OpenAI 的 Apple Developer Team ID）。只有 OpenAI 签名的进程才能被信任。

---

## 六、反思：AI Agent 安全的三个根本性问题

在拆解完 Codex 的完整架构后，让我们回到更本质的问题。

### 问题一：AI 的能力边界应该由谁定义？

Codex 的 Computer Use 可以操控任意 macOS 应用（除了密码管理器）。这个"任意"的范围是由 OpenAI 在服务端通过策略配置定义的——`allowed_bundle_ids` 和 `denied_bundle_ids` 列表。但客户端的 `ComputerUsePolicyProvider` 只是从服务端缓存策略，本地没有独立的校验逻辑。

这意味着：如果服务端策略被修改（无论是有意还是被攻破），客户端会忠实地执行新的策略——包括允许操控原本被禁止的应用。

**AI 的能力边界不应该只由远程配置定义，还需要有本地不可篡改的底线。**

### 问题二：凭据安全是否是 AI Agent 的特殊挑战？

传统的 Web 应用中，API Key 明文存储在 localStorage 已经被视为安全隐患。但在 AI Agent 应用中，这个问题被放大了——因为 Agent 有代码执行能力。XSS 不只是"窃取凭据"的终点，而是"窃取凭据→获得 Agent 控制权→操纵用户电脑"的起点。

**AI Agent 应用需要比传统 Web 应用更严格的凭据保护——macOS Keychain、加密存储、生物特征验证访问，这些都是必须的，而不是可选的。**

### 问题三：谁为 AI 的行为负责？

Computer Use 的审批机制让用户对每个新应用的操控做出授权决定。但这个授权信息的措辞是："Allowing Codex to use this app introduces new risks, including those related to prompt injection attacks, such as data theft or loss."

这段文字直接点出了最根本的风险——**prompt injection**。即使你信任 Codex，即使你信任 OpenAI，你仍然可能因为恶意构造的输入导致 AI 执行违背你意图的操作。这不是技术漏洞，而是 AI Agent 的固有风险——它的行为由输入决定，而输入可能被恶意构造。

这个问题没有技术解决方案，只有社会性的解决方案：**透明的风险告知、操作的可审计性、以及用户对 AI 行为的持续监督。**

---

## 结语：从"AI 看代码"到"AI 动手做"

Codex 的架构揭示了一个清晰的演进路径：

- **第一代 AI 编程助手**：看代码、建议修改、回答问题——本质是"信息提供者"
- **第二代 AI 编程助手**（Codex 当前状态）：写代码、运行代码、操控浏览器和桌面——本质是"任务执行者"
- **第三代 AI 编程助手**（未来方向）：理解项目上下文、自主规划任务链、跨工具编排复杂工作流——本质是"自主代理"

每一代演进都指数级地放大了 AI 的能力，但也同样指数级地放大了安全风险。Codex 的架构在工程层面做了大量精巧的设计——双进程隔离、MCP 协议沙箱、三层审批防线、Turn 生命周期管理。但同时也留下了明确的缺口——API Key 明文存储、IPC 无调用者验证、objc-js 无权限检查。

这些缺口不是因为工程师不够聪明，而是因为"便利与安全的权衡"在 AI Agent 场景中被推向了极端——AI 需要足够的能力才能完成任务，但过多的能力就意味着过多的风险。

这不是 Codex 独有的困境，而是整个 AI Agent 行业正在面对的核心挑战。每一个让 AI "更强大"的设计决策，都同时让 AI "更危险"。我们需要的不是停止让 AI 变得更强大，而是在强大之上建立更精密的安全护栏——让 AI 的力量可以被信任地使用。

Codex 给了我们一个很好的起点：它展示了 AI Agent 可以走多远，也坦诚地暴露了走到那里需要付出多少安全代价。接下来，就看整个行业如何在这条路上，一边前行一边修护栏了。

---

*本文仅用于技术研究和教育目的。文中所有架构信息来源于公开可获取的二进制分析，不包含任何非公开的内部文档或源代码。*