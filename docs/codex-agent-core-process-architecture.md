# Codex Agent 核心进程架构深度分析

> 来源：main.js、app-session.js、worker.js、bootstrap.js 及所有反编译重建源码的交叉分析
> 版本：26.506.31421 (Build 2620)
> 核心问题：当 AI Agent 需要多工作区并发时，Codex 如何设计进程模型？

---

## 0. 先给结论：Codex 和 VSCode 走的是完全不同的路

在深入细节之前，先用一张对比表说清楚关键差异：

| 维度 | VSCode | Codex |
|------|--------|-------|
| **Agent Loop 位置** | 本地 Extension Host 进程 | **本地 Worker Thread（HTTP 客户端）** |
| **LLM API 请求** | 扩展进程中直接发 HTTP | **Worker Thread 发 HTTP + CODEX_API_BASE_URL 可重定向** |
| **OpenAI 服务端角色** | N/A | **会话持久化 + 多设备同步 + 事件广播**（不是 Agent 大脑） |
| **进程模型** | 1 workspace = 1 Extension Host | **N workspaces = 1 Electron 主进程** |
| **新工作区启动** | 启动新进程 → 加载扩展 → 慢 | **创建本地 Thread Context → 即时** |
| **工作区隔离** | OS 进程隔离（强） | **Session 分区 + Agent 上下文感知** |
| **第三方 API 支持** | 扩展自行处理 | **改 CODEX_API_BASE_URL 即可，Worker Thread 直接路由** |

**核心洞察（修正后）**：Codex 的 Agent Loop 运行在**本地 Worker Thread** 中，LLM HTTP 请求从本地发出。OpenAI 服务端不是 Agent 大脑，而是**会话同步层**——负责持久化对话历史、多设备消息同步、Thread 事件广播和 Automation 定时触发。这使得第三方 API 接入极其简单：只需改变 Worker Thread 的 HTTP 请求目标 URL。

---

## 1. 完整进程地图

### 1.1 所有进程一览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Codex 完整进程地图                              │
│                                                                     │
│  ┌──────────────────────────────────────────────────────┐           │
│  │         OpenAI Server (chatgpt.com)                   │           │
│  │                                                      │           │
│  │  不是 Agent Loop 运行位置！                            │           │
│  │  实际角色：会话同步 + 事件广播 + 认证                   │           │
│  │  ┌────────────────────────────────────────────────┐  │           │
│  │  │  Session Manager                               │  │           │
│  │  │  - 对话历史持久化（跨设备同步）                    │  │           │
│  │  │  - 用户认证 / Session Token 管理                 │  │           │
│  │  │  - Feature Flag 分发                            │  │           │
│  │  │  - Thread 事件广播（goal/updated, plan/changed） │  │           │
│  │  │  - Automation Heartbeat 定时触发                 │  │           │
│  │  │  - Thread-Follower RPC 转发（Steer/Interrupt）   │  │           │
│  │  └────────────────────────────────────────────────┘  │           │
│  └──────────────────────┬───────────────────────────────┘           │
│                         │ WebSocket / SSE                          │
│                         │ ← 仅传输：会话同步、事件广播、             │
│                         │           Thread-Follower 控制信号        │
│                         │ ← 不传输：LLM 推理请求（本地发 HTTP）      │
│  ═══════════════════════╪═══════════════════════════════════════    │
│                         │ 本地 macOS 进程                            │
│                         │                                           │
│  ┌──────────────────────┴───────────────────────────────┐           │
│  │              Electron 主进程 (Main Process)           │           │
│  │  main.js (1.1 MB)                                    │           │
│  │  ┌──────────────────────────────────────────────┐    │           │
│  │  │  App Session (app-session.js, 4.3 MB)        │    │           │
│  │  │  - Rust WASM 核心逻辑                        │    │           │
│  │  │  - Session 分区管理                          │    │           │
│  │  │  - SharedObject 全局状态                     │    │           │
│  │  │  - Feature Flag 系统                         │    │           │
│  │  │  - Sparkle 自动更新                          │    │           │
│  │  └──────────────────────────────────────────────┘    │           │
│  │                                                      │           │
│  │  ┌──────────────────────────────────────────────┐    │           │
│  │  │  Thread-Follower Handler                     │    │           │
│  │  │  - 15 种 Thread 控制请求                      │    │           │
│  │  │  - Steer / Interrupt / Compact / ...         │    │           │
│  │  └──────────────────────────────────────────────┘    │           │
│  │                                                      │           │
│  │  ┌──────────────────────────────────────────────┐    │           │
│  │  │  Remote Connections Handler                  │    │           │
│  │  │  - SSH Config 解析                           │    │           │
│  │  │  - Remote Control Enrollment                 │    │           │
│  │  │  - Device Key (Secure Enclave ECDSA P-256)   │    │           │
│  │  └──────────────────────────────────────────────┘    │           │
│  └──────┬──────────────┬───────────────┬────────────────┘           │
│         │              │               │                            │
│         ▼              ▼               ▼                            │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────────┐          │
│  │ Worker   │  │ Renderer     │  │ BrowserWindow x N    │          │
│  │ Thread   │  │ (React SPA)  │  │ (Primary/Host/Thread/ │          │
│  │ (1.2 MB) │  │              │  │  Aux/Preview/Hotkey)  │          │
│  │          │  │ - Chat UI    │  │                      │          │
│  │ ★ Agent  │  │ - Code Editor│  │ 每个 Thread 可以有    │          │
│  │   Loop   │  │ - .NET/WASM  │  │ 独立的 BrowserWindow  │          │
│  │ ★ HTTP   │  │   (Office)   │  └──────────────────────┘          │
│  │   客户端  │  └──────────────┘                                     │
│  │ - Files  │                                                       │
│  │ - Shell  │                                                       │
│  │ - Crypto │                                                       │
│  └────┬─────┘                                                       │
│       │                                                             │
│       │ spawn (MCP Server 子进程)                                    │
│       │                                                             │
│  ┌────┴──────────────────────────────────────────┐                  │
│  │  MCP Server 子进程 (每个插件可启动多个)         │                  │
│  │                                                │                  │
│  │  ┌──────────────────────────────────────────┐  │                  │
│  │  │ SkyComputerUseClient (Swift CLI)         │  │                  │
│  │  │ - MCP JSON-RPC via stdin/stdout          │  │                  │
│  │  │ - Apple Events → SkyComputerUseService   │  │                  │
│  │  └──────────────────────────────────────────┘  │                  │
│  │                                                │                  │
│  │  ┌──────────────────────────────────────────┐  │                  │
│  │  │ Browser Use MCP Server                   │  │                  │
│  │  │ - Node REPL 运行时                        │  │                  │
│  │  │ - browser.tabs / navigate / click / ...  │  │                  │
│  │  └──────────────────────────────────────────┘  │                  │
│  │                                                │                  │
│  │  ┌──────────────────────────────────────────┐  │                  │
│  │  │ Chrome MCP Server (Native Messaging)     │  │                  │
│  │  │ - 通过 Chrome Extension 控制真实浏览器     │  │                  │
│  │  └──────────────────────────────────────────┘  │                  │
│  └────────────────────────────────────────────────┘                  │
│                                                                     │
│  ┌────────────────────────────────────────────────┐                  │
│  │  SkyComputerUseService (独立 macOS App)         │                  │
│  │  Bundle ID: com.openai.sky.CUAService          │                  │
│  │  - LSUIElement (无 Dock，仅菜单栏)              │                  │
│  │  - 持有 Accessibility + Screen Recording 权限  │                  │
│  │  - 通过 Apple Events 接收 Client 指令          │                  │
│  │  - 执行实际 UI 操作 (CGEvent/AXUIElement)      │                  │
│  └────────────────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 进程数量

- **1 个** Electron 主进程（始终存在）
- **1 个** Worker 线程（始终存在，**Agent Loop 在此运行**）
- **N 个** Renderer/BrowserWindow（按 Thread/窗口数量动态创建）
- **N 个** MCP Server 子进程（按启用的插件动态 spawn）
- **0-N 个** Swift 原生进程（Computer Use 的双进程架构）

---

## 2. 核心架构决策：本地 Worker Thread 是 Agent 的"大脑"

### 2.1 修正：Agent Loop 在本地，不在服务端

```
┌──────────────────────────────────────────────────────────────────┐
│  本地 Worker Thread (1.2 MB)                                     │
│                                                                  │
│  ★ Agent Loop 在此运行 ★                                         │
│                                                                  │
│  while (thread.active) {                                         │
│    // 1. 构建请求 payload                                        │
│    const payload = {                                              │
│      model: thread.config.model,                                 │
│      messages: [...systemPrompt, ...conversationHistory],         │
│      tools: buildToolList(thread.registeredPlugins),             │
│      stream: true,                                               │
│    };                                                            │
│                                                                  │
│    // 2. 从本地发 HTTP 请求到 LLM API                            │
│    const response = await httpPost(                              │
│      apiBaseUrl + "/v1/chat/completions",  ← 本地发请求          │
│      payload,                                                     │
│      { headers: { Authorization: `Bearer ${apiKey}` } }          │
│    );                                                            │
│                                                                  │
│    // 3. 处理响应中的 tool calls                                 │
│    for (const tc of response.tool_calls) {                       │
│      const result = await executeToolLocally(tc);  ← 本地执行    │
│      messages.push({ role: "tool", content: result });           │
│    }                                                             │
│                                                                  │
│    // 4. 同步到服务端（持久化 + 多设备）                           │
│    await ws.send({ type: "sync", messages, goal, plan });        │
│  }                                                               │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  OpenAI Server (chatgpt.com)                                      │
│                                                                  │
│  不是 Agent 大脑，是"协作基础设施"                                 │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ 1. 对话历史持久化 → 换设备继续对话                           │  │
│  │ 2. Thread 事件广播 → goal/updated, plan/changed 推到所有窗口 │  │
│  │ 3. Thread-Follower RPC → 一个设备 Steer，其他设备同步感知    │  │
│  │ 4. Automation 定时触发 → Heartbeat XML 推送到本地            │  │
│  │ 5. Feature Flag 分发 → 功能开关集中管理                      │  │
│  │ 6. 用户认证 → Session Token 签发和验证                       │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 证据链：为什么 Agent Loop 在本地

**证据 1：CODEX_API_BASE_URL 必须在本机生效**

```bash
# 如果 Agent Loop 在服务端，这个环境变量毫无意义
# 服务端不可能去读客户端的 CODEX_API_BASE_URL
export CODEX_API_BASE_URL="http://localhost:11434/v1"  # Ollama
export CODEX_API_ENDPOINT="localhost"                   # → localhost:8000/api

# 这两个变量只有在本地 Worker Thread 发 HTTP 请求时才会被使用
```

**证据 2：Worker 线程包含了完整的 HTTP 客户端**

```
worker.js (1.2 MB) 引入的模块:
http, https, net, tls, stream, zlib
→ 这些是完整的 HTTP 客户端 + 加密能力
→ 如果 LLM 请求在服务端发，Worker 不需要这些
```

**证据 3：第三方 API 接入只需要改环境变量**

如果 Agent Loop 在服务端，接入第三方 API 需要服务端支持；但实际上用户只需设置两个环境变量即可。这与"本地发 HTTP 请求"的模型完全一致。

**证据 4：get-copilot-api-proxy-info 的存在**

Settings 中有专门存储 API 代理信息的 key，说明 Worker Thread 需要知道自己应该把请求发到哪里。

**证据 5：Agent 模式 (CODEX_BUILD_FLAVOR=agent) 可在低依赖下运行**

```
Agent 模式下:
- externalBrowserUseAllowed = false   // 不需要外部浏览器
- ambientSuggestions = false          // 不需要环境建议
- 用户数据隔离: <userData>/agent/<agentRunId>

→ 这种"自包含"模式说明本地可以独立运行 Agent Loop
```

---

## 3. 第三方 API 接入：LLM 请求如何路由

### 3.1 apiBaseUrl 的解析优先级

```typescript
// Worker Thread 发 LLM 请求时，目标 URL 由以下优先级决定：

function resolveApiBaseUrl(): string {
  // 优先级 1: CODEX_API_BASE_URL 环境变量（最高）
  const baseUrl = process.env.CODEX_API_BASE_URL?.trim();
  if (baseUrl) return baseUrl;
  // 例如: export CODEX_API_BASE_URL=http://localhost:11434/v1

  // 优先级 2: CODEX_API_ENDPOINT 环境变量
  const endpoint = process.env.CODEX_API_ENDPOINT?.trim();
  if (endpoint === "localhost") {
    return "http://localhost:8000/api";  // 开发环境
  }
  // 可能还有其他预设端点

  // 优先级 3: 默认值
  return "https://api.openai.com/v1";
}
```

### 3.2 第三方 API 的完整请求流

```
用户配置:
  export CODEX_API_BASE_URL="http://localhost:11434/v1"
  export OPENAI_API_KEY="ollama"

用户在 Codex 中输入: "帮我读 README.md 并总结"

┌─ Worker Thread (本地) ──────────────────────────────────────────┐
│                                                                  │
│  Step 1: 构建 LLM 请求                                           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ POST http://localhost:11434/v1/chat/completions          │   │
│  │ ← 目标是本地 Ollama，不是 api.openai.com                  │   │
│  │                                                          │   │
│  │ {                                                        │   │
│  │   "model": "gpt-5",       ← 如果本地模型不支持，会报错    │   │
│  │   "messages": [                                          │   │
│  │     { "role": "system", "content": "You are Codex..." }, │   │
│  │     { "role": "user", "content": "帮我读 README 并总结" }│   │
│  │   ],                                                     │   │
│  │   "tools": [                                             │   │
│  │     { "name": "read_file", ... },                        │   │
│  │     { "name": "execute_command", ... }                   │   │
│  │   ],                                                     │   │
│  │   "stream": true                                         │   │
│  │ }                                                        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Step 2: 本地 LLM 返回 tool call                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ {                                                        │   │
│  │   "choices": [{                                          │   │
│  │     "message": {                                         │   │
│  │       "tool_calls": [{                                   │   │
│  │         "name": "read_file",                             │   │
│  │         "arguments": { "path": "/Users/xxx/README.md" }  │   │
│  │       }]                                                 │   │
│  │     }                                                    │   │
│  │   }]                                                     │   │
│  │ }                                                        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Step 3: 本地执行 tool                                           │
│  Worker → fs.readFileSync("/Users/xxx/README.md")               │
│  → 返回文件内容到消息历史                                         │
│                                                                  │
│  Step 4: 继续循环                                                 │
│  POST http://localhost:11434/v1/chat/completions                │
│  ← 把 tool result 追加到 messages                               │
│  ← LLM 看到文件内容后生成总结                                     │
│                                                                  │
│  Step 5: 同步到服务端                                             │
│  WebSocket → OpenAI Server: "对话历史已更新"                     │
│  → 如果你用另一台 Mac，可以看到这段对话                           │
└──────────────────────────────────────────────────────────────────┘
```

### 3.3 与 OpenAI API 格式的兼容性

任何实现了 OpenAI-compatible `/v1/chat/completions` 端点的服务都可以接入：

| 服务 | CODEX_API_BASE_URL 示例 | tool calling 支持 |
|------|------------------------|-------------------|
| Ollama | `http://localhost:11434/v1` | ✅ (0.3+) |
| LM Studio | `http://localhost:1234/v1` | ✅ |
| vLLM | `http://localhost:8000/v1` | ✅ |
| DeepSeek | `https://api.deepseek.com/v1` | ✅ |
| Anthropic (via gateway) | 需兼容代理层 | 需格式转换 |
| 企业内部部署 | `https://internal-llm.company.com/v1` | 取决于实现 |

---

## 4. OpenAI 服务端 vs 本地的职责划分（修正后）

| 职责 | OpenAI Server | 本地 Worker Thread | 本地 MCP 子进程 |
|------|:---:|:---:|:---:|
| **LLM HTTP 请求** | | ✅ | |
| **Agent Loop 循环** | | ✅ | |
| **Tool 执行（文件、Shell）** | | ✅ | |
| **Computer Use（桌面操控）** | | | ✅ (Swift) |
| **Browser Use（浏览器操控）** | | | ✅ (Node REPL) |
| **apiBaseUrl 解析** | | ✅ | |
| **API Key 读取** | | ✅ | |
| **对话历史持久化** | ✅ | | |
| **多设备消息同步** | ✅ | | |
| **Feature Flag 分发** | ✅ | | |
| **Thread 事件广播** | ✅ | | |
| **Thread-Follower RPC 转发** | ✅ | | |
| **Automation Heartbeat 触发** | ✅ | | |
| **Sparkle 自动更新** | | ✅ (主进程) | |

### 4.1 服务端断连的降级行为

由于 Agent Loop 在本地、LLM 请求也从本地发出，服务端断连的后果是**有限的**：

```
服务端不可用时的降级路径：
┌──────────────────────────────────────────────────────┐
│  ✅ 仍然可用:                                         │
│  - Agent Loop 继续运行                                │
│  - LLM API 请求正常（本地发 HTTP）                     │
│  - Tool 执行正常（文件读写、Shell 命令）               │
│  - Computer Use / Browser Use 正常                    │
│                                                      │
│  ❌ 不可用:                                           │
│  - 对话历史无法跨设备同步                              │
│  - Thread 事件广播失效（多窗口状态不一致）              │
│  - Thread-Follower（跨设备 Steer）不可用               │
│  - Automation 定时触发可能失效                        │
│  - Feature Flag 无法更新                              │
└──────────────────────────────────────────────────────┘
```

### 4.2 两种运行模式对比

```
完整模式（默认）:
┌──────────────────┐     WebSocket      ┌──────────────────┐
│  OpenAI Server   │◄──────────────────►│  Worker Thread   │
│  - 会话持久化     │    - 事件广播      │  - Agent Loop    │
│  - 多设备同步     │    - RPC 转发      │  - LLM HTTP      │
│  - Feature Flag  │    - Heartbeat     │  - Tool 执行     │
└──────────────────┘                    └──────────────────┘
                                               │
                                    POST /v1/chat/completions
                                               │
                                    ┌──────────┴──────────┐
                                    │  LLM API            │
                                    │  (OpenAI / 第三方)   │
                                    └─────────────────────┘

Agent 模式 (CODEX_BUILD_FLAVOR=agent):
  和完整模式相同，但服务端交互更少
  - externalBrowserUseAllowed = false
  - ambientSuggestions = false
  - 用户数据隔离：<userData>/agent/<agentRunId>
  → 更接近于"自包含 Agent 运行时"

纯本地模式（第三方 API + Agent flavor）:
┌──────────────────┐                    ┌──────────────────┐
│  OpenAI Server   │  ← 仅最基础的同步   │  Worker Thread   │
│  (降级角色)       │                    │  - Agent Loop    │
└──────────────────┘                    │  - LLM HTTP      │
                                        │  - Tool 执行     │
                                        └──────────────────┘
                                               │
                                    POST /v1/chat/completions
                                               │
                                    ┌──────────┴──────────┐
                                    │  本地 Ollama /       │
                                    │  LM Studio / vLLM   │
                                    └─────────────────────┘
```

---

## 5. 工作区隔离：Agent 上下文感知 + Session 分区

### 5.1 三层隔离模型

```
Layer 1: Agent 上下文感知（本地，最实际）
┌──────────────────────────────────────────────────────┐
│  Worker Thread                                       │
│                                                      │
│  Thread A (Project-1)    Thread B (Project-2)        │
│  ┌──────────────────┐    ┌──────────────────┐        │
│  │ System Prompt    │    │ System Prompt    │        │
│  │ workspaceRoot:   │    │ workspaceRoot:   │        │
│  │  /project-1      │    │  /project-2      │        │
│  │ messages: [...]  │    │ messages: [...]  │        │
│  │ goal: {...}      │    │ goal: {...}      │        │
│  │ plan: {...}      │    │ plan: {...}      │        │
│  └──────────────────┘    └──────────────────┘        │
│                                                      │
│  通过 workspaceRoot + 对话上下文隔离                   │
│  非 OS 进程隔离，不强制文件系统沙箱                    │
└──────────────────────────────────────────────────────┘

Layer 2: Electron Session 分区（本地，浏览器状态隔离）
┌──────────────────────────────────────────────────────┐
│  persist:main          → 主窗口                      │
│  persist:worker        → Worker 线程                 │
│  persist:webview       → WebView                     │
│  persist:thread-{id}   → 每个对话 Thread             │
│                                                      │
│  每个 partition 有独立的 Cookie、Cache、LocalStorage │
└──────────────────────────────────────────────────────┘

Layer 3: 服务端持久化（远程，跨设备同步）
┌──────────────────────────────────────────────────────┐
│  OpenAI Server                                       │
│  - 每个 Thread 有独立的持久化对话历史                  │
│  - 多设备通过 WebSocket 同步                          │
│  - Thread 之间无共享状态                              │
└──────────────────────────────────────────────────────┘
```

### 5.2 多 Thread 并发的冲突避免

```
Worker 线程是单例，所有 Thread 的 tool call 在此执行：

Thread 1 → "读 /project-1/package.json"
Thread 2 → "运行 pytest --cwd /project-2"
Thread 3 → "打开浏览器预览 localhost:3000"

冲突避免机制：
1. requestId 追踪每个 tool call 的归属
2. 文件操作通过绝对路径/cwd 区分项目
3. Shell 命令在独立 node-pty 实例中执行
4. Thread-Follower 每个请求有独立的 pendingMap + 超时

→ 不需要 OS 进程隔离即可防止混淆
```

---

## 6. Agent Loop 核心逻辑

### 6.1 本地 Agent Loop 的完整实现（推断）

```typescript
// Worker Thread 中的 Agent Loop
// 从 Thread-Follower + MCP Tool 注册 + Goal 系统 + HTTP 客户端推断

class LocalAgentLoop {
  private apiBaseUrl: string;
  private apiKey: string;

  constructor() {
    this.apiBaseUrl = this.resolveApiBaseUrl();
    this.apiKey = this.resolveApiKey();
  }

  private resolveApiBaseUrl(): string {
    // 优先级: CODEX_API_BASE_URL > CODEX_API_ENDPOINT > 默认
    const env = process.env.CODEX_API_BASE_URL?.trim();
    if (env) return env;
    if (process.env.CODEX_API_ENDPOINT === "localhost") {
      return "http://localhost:8000/api";
    }
    return "https://api.openai.com/v1";
  }

  private resolveApiKey(): string {
    // 从 Electron Settings 读取（明文存储，参见安全报告）
    return electronSettings.get("openai-api-key");
  }

  async run(thread: Thread): Promise<void> {
    while (thread.state === "running") {
      // 1. 处理外部控制信号
      //    Thread-Follower 请求通过 WebSocket 从服务端转发到本地
      this.processPendingControls(thread);

      // 2. 构建 LLM 请求
      const payload = {
        model: thread.config.model,
        messages: [
          this.buildSystemPrompt(thread),
          ...thread.messages,
        ],
        tools: this.buildToolList(thread),
        stream: true,
      };

      // 3. 从本地发 HTTP 请求 ← 关键！
      const response = await fetch(
        `${this.apiBaseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      // 4. 处理流式响应
      const result = await this.processStreamResponse(response);

      // 5. 处理 tool calls
      if (result.toolCalls.length > 0) {
        for (const tc of result.toolCalls) {
          // 5a. 审批检查
          if (this.requiresApproval(tc)) {
            const approved = await this.requestApproval(tc);
            if (!approved) continue;
          }

          // 5b. 本地执行
          const toolResult = await this.executeTool(tc);

          // 5c. 追加到对话历史
          thread.messages.push({
            role: "assistant",
            tool_calls: [tc],
          });
          thread.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: toolResult,
          });
        }
        // 继续循环（下一次 LLM 调用会处理 tool result）
      } else {
        // 6. 文本响应 → 完成
        if (thread.hasGoal && result.text) {
          const directive = this.parseRemarkDirective(result.text);
          if (directive) {
            await this.updateInbox(thread, directive);
          }
        }
        break;
      }

      // 7. 同步到服务端
      await this.syncToServer(thread);
    }
  }

  private async executeTool(tc: ToolCall): Promise<string> {
    // 根据 tool name 路由到不同的执行器
    switch (tc.name) {
      // 本地 Worker Thread 直接执行
      case "read_file":
        return fs.readFileSync(tc.arguments.path, "utf8");
      case "write_file":
        fs.writeFileSync(tc.arguments.path, tc.arguments.content);
        return "File written successfully";
      case "execute_command":
        return this.executeInPty(tc.arguments.command, tc.arguments.cwd);

      // 转发到 MCP Server 子进程
      case "click":
      case "type_text":
      case "get_app_state":
        return this.sendToMcpServer("computer-use", tc);
      case "browser.navigate":
      case "browser.screenshot":
        return this.sendToMcpServer("browser-use", tc);
    }
  }
}
```

### 6.2 Steer vs Send：Agent Loop 层面的差异

```
普通 Send（新增 user message）:
  messages.push({ role: "user", content: "帮我把按钮颜色改成蓝色" })
  → 下一轮 LLM 调用会看到新消息
  → 正常继续

Steer（方向修正，不新增消息）:
  // Agent 正在执行 Plan Step 2: "重构用户管理模块"
  // 用户点击 Steer: "跳过 Step 2，直接做 Step 3"

  // 不是 append 新 user message
  // 而是修改 Agent 内部状态:
  plan.steps[2].status = "skipped"
  plan.currentStep = 3

  // System Prompt 注入:
  // "User has steered: skip refactoring, proceed to step 3."
  // "Continue from where you left off, but adjust direction."

  → 不改写对话历史，Agent 保持已有上下文
  → Thread-Follower steer-turn 请求通过服务端 RPC 到达本地
```

---

## 7. Tool 注册和调度机制

### 7.1 三层 Tool 注册体系

```
Layer 1: Worker Thread 内置工具（代码中硬编码）
  └── read_file / write_file / search_files / execute_command
  └── 直接调用 Node.js fs / node-pty

Layer 2: Plugin MCP Tools（插件 manifest 声明）
  └── computer-use: 9 个 MCP Tools（list_apps, click, type_text, ...）
  └── browser-use: browser.tabs / navigate / click / screenshot
  └── chrome: 真实 Chrome 控制
  └── latex-tectonic: LaTeX 编译
  └── 第三方插件: 用户安装的任意 MCP Server

Layer 3: Skill 注入（SKILL.md → System Prompt）
  └── 每个插件的 SKILL.md 作为 System Prompt 的附加指令
  └── LLM 通过阅读 SKILL.md 了解何时调用哪个工具
```

### 7.2 Tool Call 的完整执行路径

```
  Worker Thread (Agent Loop)
  ─────────────────────────────
       │
       │ 1. LLM 返回 tool_call: { name: "click", arguments: { elementIndex: 42 } }
       │
       ├── 2. 审批检查 ──→ 通过
       │
       ├── 3. 路由: "click" → computer-use MCP Server
       │
       ▼
  ┌─────────────────────────────┐
  │ SkyComputerUseClient        │  ← spawn 的子进程
  │ stdin: {"method":           │
  │   "tools/call", ...}        │
  └──────────┬──────────────────┘
             │ Apple Events IPC
             ▼
  ┌─────────────────────────────┐
  │ SkyComputerUseService       │  ← 独立 macOS App
  │ AXUIElementPerformAction(   │
  │   element, click)           │
  └──────────┬──────────────────┘
             │
  ┌──────────┴──────────────────┐
  │ 结果: { success: true,     │
  │   screenshot: "base64..." } │
  └──────────┬──────────────────┘
             │
  Worker Thread ←── tool_result
       │
       │ 4. 追加到 messages
       │ 5. 下一轮 LLM 调用
       │ 6. 同步到服务端
```

### 7.3 审批拦截点

```
Tool Call 到达 → ┌─ 审批检查 1: 权限模式 ──────────────────┐
                 │  fullAccess → 直接执行                   │
                 │  default → 高风险操作需用户审批            │
                 │  custom → 按 config.toml 规则             │
                 └──────────────────────────────────────────┘
                              │
                              ▼
                 ┌─ 审批检查 2: 应用级审批 (Computer Use) ──┐
                 │  首次使用某 App → McpElicitation 弹窗     │
                 │  密码管理器 → 硬阻止                       │
                 │  组织策略 → denied_bundle_ids 检查         │
                 └──────────────────────────────────────────┘
                              │
                              ▼
                 ┌─ 审批检查 3: 文件/命令审批 ────────────────┐
                 │  写文件 → file-approval-decision           │
                 │  执行命令 → command-approval-decision      │
                 └──────────────────────────────────────────┘
                              │
                              ▼
                        执行 Tool
```

---

## 8. 对比：VSCode 如果走 Codex 的路

### 8.1 当前 VSCode 架构的问题

```
VSCode 进程模型:
  主进程 (1)
  ├── Extension Host (1 per workspace)
  │   └── 所有扩展共享此进程
  │       └── GitHub Copilot 扩展
  │           └── Agent Loop (本地)
  │               └── LLM API 调用
  │                   └── 本地 Tool 执行

  问题：
  1. 新工作区 = 新 Extension Host = 加载所有扩展 → 5-7s
  2. Agent Loop 在扩展进程中，等网络 IO 浪费资源
  3. 工作区崩溃影响 Extension Host
  4. 每个工作区独占一个进程
```

### 8.2 Codex 方案对自研项目的启示

```typescript
// 推荐架构：
// 本地层：单个 Worker Thread 跑 Agent Loop + Tool 执行
// 服务端：轻量协作层（会话持久化 + 多设备同步 + 事件广播）

interface RecommendedArchitecture {
  // === 本地层（单例，服务所有工作区） ===

  workerThread: {
    // Agent Loop（本地 HTTP 客户端）
    agentLoop: {
      resolveApiBaseUrl(): string;  // 支持重定向到第三方 API
      run(thread: Thread): Promise<void>;
    };

    // Tool Executor
    toolExecutor: {
      registeredTools: Map<string, ToolHandler>;
      onToolCall(call: ToolCall): Promise<ToolResult>;
      activeWorkspaceRoot: string;
    };
  };

  // === 服务端（轻量协作） ===

  server: {
    // 会话服务
    sessionManager: {
      persistMessages(threadId: string, messages: Message[]): Promise<void>;
      syncToDevices(threadId: string): Promise<void>;
    };

    // 事件广播
    eventBus: {
      broadcast(event: ThreadEvent): void;
    };
  };

  // === 关键差异 ===

  // VSCode 模式：
  //   新项目 → 新 Extension Host 进程 → 加载扩展 → Agent 开始工作
  //   时间：进程启动 ~2s + 扩展加载 ~3-5s = 5-7s

  // Codex 模式：
  //   新项目 → 创建本地 Thread Context → 同步 workspace root → Agent 开始工作
  //   时间：context 初始化 ~100ms + 首次 LLM API 调用 ~取决于模型

  // Codex 模式（第三方 API）：
  //   新项目 → 创建本地 Thread Context → Agent Loop 发 HTTP 到本地 LLM
  //   延迟：全部在本地，无外网依赖
}
```

---

## 9. 安全与隔离的权衡总结

### 9.1 Codex 的设计取舍

| 维度 | Codex 的选择 | 代价 |
|------|-------------|------|
| **Agent Loop 位置** | 本地 Worker Thread | 无（正确选择） |
| **LLM API 请求** | 本地发 HTTP，URL 可配置 | API Key 明文存储（安全问题） |
| **工作区隔离** | Agent 上下文感知 + Session 分区 | 本地文件系统无强制隔离 |
| **进程模型** | 1 个 Electron + N 个 MCP 子进程 | 子进程崩溃可能影响工具可用性 |
| **状态管理** | 本地为主 + 服务端持久化 | 服务端断连时降级为单机模式 |
| **第三方 API** | 改环境变量即可 | 依赖 API 兼容 OpenAI 格式 |

### 9.2 对自研项目的建议

1. **Agent Loop 放在本地 Worker 线程**。LLM HTTP 请求从本地发出，通过 apiBaseUrl 配置支持第三方 API。服务端只做会话同步。

2. **工作区不应该等于进程**。用 session ID + workspace root 的软隔离替代进程级硬隔离。新增工作区 O(1) 开销。

3. **Tool 注册动态化**。通过 MCP 协议让工具可动态注册、按需加载。Worker Thread 根据 tool name 路由到正确的执行器。

4. **审批分层**。高风险操作（Shell 命令、文件写入）有独立的审批路径，不依赖单一权限模型。

5. **保留进程隔离用于真正的沙箱需求**。Computer Use 的双进程架构正确——高权限操作放在独立进程中。

6. **服务端做轻量协作层**。对话持久化 + 多设备同步 + 事件广播，不参与 LLM 推理。服务端断连时 Agent 降级为单机模式继续工作。

---

## 附录 A：关键文件大小对照

| 文件 | 大小 | 角色 |
|------|------|------|
| bootstrap.js | 3.7 KB | 启动入口 |
| main.js | 1.1 MB | 主进程核心 |
| app-session.js | 4.3 MB | Rust WASM 业务逻辑 |
| worker.js | 1.2 MB | Worker 线程（Agent Loop + HTTP 客户端） |
| preload.js | 2.4 KB | Electron Bridge |
| comment-preload.js | 35 MB | 浏览器侧边栏 + i18n |
| sandbox-preload.js | 8 KB | MCP 沙箱通信 |
| objc-js .node | 639 KB | ObjC Runtime 桥接 |
| better-sqlite3 .node | 1.9 MB | 本地数据库 |
| node-pty .node | 105 KB | 伪终端 |
| app.asar | 137 MB | 完整打包 |

## 附录 B：Agent Loop 在本地 Worker Thread 的证据

1. `CODEX_API_BASE_URL` 环境变量只在本地生效（服务端不会读客户端环境变量）
2. `CODEX_API_ENDPOINT="localhost"` → `http://localhost:8000/api`（本地开发路由）
3. Worker 线程包含完整的 http/https 模块（HTTP 客户端能力）
4. `get-copilot-api-proxy-info` Settings key 说明有 API 代理配置需求
5. `CODEX_BUILD_FLAVOR=agent` 模式可在低服务端依赖下运行
6. API Key 从本地 Electron Settings 读取（服务端不需要它）

## 附录 C：OpenAI Server 的实际职责

1. 对话历史持久化（跨设备同步）
2. Thread 事件广播（goal/updated, plan/changed → 所有窗口）
3. Thread-Follower RPC 转发（跨设备 Steer/Interrupt）
4. Automation Heartbeat 定时触发 → 推送 Heartbeat XML 到本地
5. Feature Flag 集中分发
6. 用户认证 / Session Token 签发和验证
7. Remote Control Device Key enrollment
