# Codex Agent 核心进程架构深度分析

> 来源：main.js、app-session.js、worker.js、bootstrap.js 及所有反编译重建源码的交叉分析
> 版本：26.506.31421 (Build 2620)
> 核心问题：当 AI Agent 需要多工作区并发时，Codex 如何设计进程模型？

---

## 0. 先给结论：Codex 和 VSCode 走的是完全不同的路

在深入细节之前，先用一张对比表说清楚关键差异：

| 维度 | VSCode | Codex |
|------|--------|-------|
| **Agent/扩展宿主** | 本地 Extension Host 进程 | **服务端 Agent Loop + 本地 Tool Executor** |
| **进程模型** | 1 workspace = 1 Extension Host | **N workspaces = 1 Electron 主进程** |
| **新工作区启动** | 启动新进程 → 加载扩展 → 慢 | **创建服务端 Thread → 即时** |
| **工作区隔离** | OS 进程隔离（强） | **Session 分区 + 服务端 Thread 隔离** |
| **工具执行** | 扩展进程中直接执行 | **Worker 线程 + MCP 子进程** |
| **Agent Loop** | 本地扩展代码 | **服务端 LLM 驱动，客户端只执行 Tool Call** |
| **状态管理** | 扩展内存 | **服务端 Conversation State + 本地 SharedObject** |

**核心洞察**：Codex 把 Agent Loop（LLM 推理 + 工具选择 + 上下文管理）全部放在服务端，本地 Electron 应用的角色是"被调用的工具执行器"而非"Agent 大脑"。这从根本上避免了 VSCode 的"多工作区 = 多进程"问题。

---

## 1. 完整进程地图

### 1.1 所有进程一览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Codex 完整进程地图                              │
│                                                                     │
│  ┌──────────────────────────────────────────────────────┐           │
│  │              OpenAI Server (chatgpt.com)              │           │
│  │  ┌────────────────────────────────────────────────┐  │           │
│  │  │  Agent Loop (per Thread)                       │  │           │
│  │  │  - LLM 推理 (GPT-5 / o4)                       │  │           │
│  │  │  - Tool Choice (选择调用哪个 MCP Tool)          │  │           │
│  │  │  - Context Management (对话历史、System Prompt) │  │           │
│  │  │  - Plan Generation & Tracking                  │  │           │
│  │  │  - Streaming Response                          │  │           │
│  │  └────────────────────────────────────────────────┘  │           │
│  └──────────────────────┬───────────────────────────────┘           │
│                         │ WebSocket / SSE                          │
│                         │ (tool call → client → tool result → server)│
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
│  │ - HTTP   │  │ - Code Editor│  │ 每个 Thread 可以有    │          │
│  │ - TCP    │  │ - .NET/WASM  │  │ 独立的 BrowserWindow  │          │
│  │ - Files  │  │   (Office)   │  └──────────────────────┘          │
│  │ - Shell  │  └──────────────┘                                     │
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
│                                                                     │
│  ┌────────────────────────────────────────────────┐                  │
│  │  原生 .node 模块 (6 个)                         │                  │
│  │  - objc-js (639 KB)    : JS ↔ ObjC Runtime     │                  │
│  │  - better-sqlite3 (1.9 MB) : 本地数据库         │                  │
│  │  - node-pty (105 KB)   : 伪终端                │                  │
│  │  - sparkle.node        : 自动更新               │                  │
│  │  - browser-use-peer-auth: Touch ID + 签名验证   │                  │
│  │  - remote-control-device-key: Secure Enclave    │                  │
│  └────────────────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 进程数量：不是"一个"，而是"按需分层"

关键数字：
- **1 个** Electron 主进程（始终存在）
- **1 个** Worker 线程（始终存在，随主进程生命周期）
- **N 个** Renderer/BrowserWindow（按 Thread/窗口数量动态创建）
- **N 个** MCP Server 子进程（按启用的插件动态 spawn）
- **0-N 个** Swift 原生进程（Computer Use 的双进程架构）
- **N 个** 服务端 Agent Loop 实例（每个 Thread 一个，运行在 OpenAI 服务器）

---

## 2. 核心架构决策：Agent Loop 在服务端

### 2.1 为什么不在本地跑 Agent Loop？

这是 Codex 架构中最关键的决策。对比两种方案：

```
方案 A：本地 Agent Loop（如 VSCode 扩展）
┌──────────────────────────────────────┐
│  本地进程                            │
│  ┌────────────────────────────────┐  │
│  │  Agent Loop                    │  │
│  │  while (running) {             │  │
│  │    response = await LLM(...)   │  │  ← 等待 LLM（网络 IO）
│  │    if (response.toolCalls) {   │  │
│  │      result = executeTool(...) │  │  ← 本地执行工具
│  │      sendToolResult(result)    │  │
│  │    }                           │  │
│  │  }                             │  │
│  └────────────────────────────────┘  │
│                                      │
│  问题：                               │
│  - 每个工作区需要一个进程跑 Loop       │
│  - 进程中大部分时间在等网络 IO        │
│  - N 个工作区 = N 个进程 = 资源浪费   │
└──────────────────────────────────────┘

方案 B：服务端 Agent Loop（Codex 的实际方案）
┌─────────────────────────┐    ┌──────────────────────────────┐
│  OpenAI Server          │    │  本地 Codex App              │
│  ┌───────────────────┐  │    │                              │
│  │  Agent Loop       │  │    │  ┌────────────────────────┐  │
│  │  (per Thread)     │◄─┼────┼──┤  Tool Executor         │  │
│  │                   │  │    │  │  - Shell 命令           │  │
│  │  LLM → Tool Choice│──┼────┼─►│  - 文件读写             │  │
│  │   ↑         ↓     │  │    │  │  - Computer Use MCP     │  │
│  │   │    Tool Result│◄─┼────┼──┤  - Browser Use          │  │
│  │   └───────────────┘  │    │  │  - Chrome Control       │  │
│  └───────────────────┘  │    │  └────────────────────────┘  │
│                         │    │                              │
│  Thread 1: Agent Loop   │    │  所有 Thread 共享同一个      │
│  Thread 2: Agent Loop   │    │  Tool Executor               │
│  Thread 3: Agent Loop   │    │                              │
└─────────────────────────┘    └──────────────────────────────┘

优势：
- 新增 Thread/工作区 → 服务端创建 Agent Loop → O(1) 本地开销
- 本地只有一个 Electron 进程，不需 fork
- Agent Loop 紧邻 LLM，减少网络往返
- 本地只做 Tool Execution，职责单一
```

### 2.2 证据链

从多个维度验证这一架构：

**证据 1：Thread-Follower 的"远程控制"语义**

```typescript
// 15 个 Thread-Follower 请求类型全部是 "请求 → 转发到 Server → 等待 Server 响应"
// 如果 Agent Loop 在本地，就不需要这些 RPC 请求类型

// main.js 中的核心转发逻辑：
async forwardThreadFollowerRequest(origin, request, pendingMap, timeoutEventName) {
  // 1. 分配 requestId
  // 2. 加入 pendingMap + 设置超时
  // 3. 转发到 Server → 这是关键：请求的目标是 remote Server
  // 4. 等待 Server 响应或超时
}
```

**证据 2：Worker 线程不包含 LLM 调用逻辑**

Worker 线程 (1.2 MB) 的模块依赖分析：
```
child_process, fs, http, https, net, tls, stream, zlib
→ 这些是 I/O、网络、加密相关的模块
→ 没有 LLM SDK / tokenizer / prompt construction 相关代码
```

**证据 3：app-session.js 的 WASM 是业务逻辑，不是 Agent Loop**

```
app-session.js (4.3 MB) 的 WASM 导出：
- __wbindgen_* 函数 → JS ↔ WASM 桥接
- 处理 Session 管理、Feature Flag、配置解析
→ 没有 Agent 循环控制流相关的导出
```

---

## 3. 工作区隔离：服务端 Thread + 本地 Session 分区

### 3.1 三层隔离模型

```
Layer 1: 服务端隔离 (最强)
┌──────────────────────────────────────────────────────┐
│  OpenAI Server                                       │
│                                                      │
│  Thread A (Project-1)    Thread B (Project-2)        │
│  ┌──────────────────┐    ┌──────────────────┐        │
│  │ System Prompt    │    │ System Prompt    │        │
│  │ Conversation     │    │ Conversation     │        │
│  │ History          │    │ History          │        │
│  │ Available Tools  │    │ Available Tools  │        │
│  │ Goal State       │    │ Goal State       │        │
│  │ Plan Steps       │    │ Plan Steps       │        │
│  └──────────────────┘    └──────────────────┘        │
│                                                      │
│  Thread 之间完全隔离，无共享状态                       │
│  每个 Thread 有独立的 Agent Loop 实例                 │
└──────────────────────────────────────────────────────┘

Layer 2: Electron Session 分区 (中)
┌──────────────────────────────────────────────────────┐
│  本地 Electron 主进程                                │
│                                                      │
│  persist:main          → 主窗口                      │
│  persist:worker        → Worker 线程                 │
│  persist:webview       → WebView                     │
│  persist:thread-{id}   → 每个对话 Thread             │
│                                                      │
│  每个 partition 有独立的:                             │
│  - Cookie 存储                                       │
│  - Cache                                             │
│  - LocalStorage                                     │
│  - Service Worker                                    │
└──────────────────────────────────────────────────────┘

Layer 3: 本地 Tool Execution 隔离 (弱，共享进程)
┌──────────────────────────────────────────────────────┐
│  Worker 线程 (单例)                                  │
│  - 所有 Thread 的 Tool Call 在此执行                 │
│  - 文件系统操作共享同一 OS 进程                      │
│  - Shell 命令共享同一用户身份                        │
│                                                      │
│  这意味着本地层不做工作区隔离：                       │
│  - Project-1 的 tool call 可以访问 Project-2 的文件  │
│  - 隔离依赖服务端 Agent Loop 的工作区认知            │
└──────────────────────────────────────────────────────┘
```

### 3.2 实际的工作区感知机制

Codex 的工作区隔离不是靠 OS 进程边界，而是靠 **Agent 的上下文感知**：

```typescript
// 从 main.js 中提取的工作区相关状态
type WorkspaceStateMessage =
  | { type: "workspace-root-options-updated" }
  | { type: "active-workspace-roots-updated" };
```

Agent 的 System Prompt 中包含了当前工作区路径，Agent 在执行 tool call 时知道自己的工作目录是什么。隔离是通过**约定和 Agent 行为规范**而非强制沙箱来实现的。

### 3.3 多 Thread 并发：如何不冲突？

```
场景：用户同时在 3 个项目上工作

Thread 1 (React 前端项目):
  Agent Loop → "读 package.json" → Worker 线程执行 → readFile("/project-1/package.json")

Thread 2 (Python 后端项目):
  Agent Loop → "运行 pytest" → Worker 线程执行 → spawn("pytest", { cwd: "/project-2" })

Thread 3 (文档项目):
  Agent Loop → "打开浏览器预览" → Worker 线程执行 → Browser Use MCP

问题：3 个 tool call 都路由到同一个 Worker 线程，会冲突吗？

Codex 的解决方案：
1. Worker 线程内部通过 requestId 跟踪每个 tool call 的归属
2. 文件操作依赖 cwd/绝对路径区分，而非进程级隔离
3. Shell 命令通过 node-pty 在独立 PTY 中执行
4. Thread-Follower 的每个请求有独立的 pendingMap 和超时管理
```

---

## 4. Agent Loop 核心逻辑（服务端推断）

### 4.1 从客户端行为反向推断 Agent Loop

虽然服务端 Agent Loop 的具体实现不可见，但从客户端的消息交互和工具注册可以反向推断其结构：

```typescript
// 从 Thread-Follower + MCP Tool 注册 + Goal 系统推断的服务端 Agent Loop
// 注意：这是基于客户端行为的推断，不是服务端源码

interface ServerSideAgentLoop {
  // === 核心循环 ===
  async function agentLoop(thread: Thread): Promise<void> {
    while (thread.state === "running") {
      // 1. 构建上下文
      const context = await buildContext(thread);
      // - System Prompt（含 Goal、Automation 配置、Remark-Directive 模板）
      // - 对话历史（自动 compact 裁剪）
      // - 可用工具列表（从 MCP Server 注册信息）
      // - 工作区信息（workspace roots）
      // - Plan 步骤状态

      // 2. 处理外部控制信号（Thread-Follower 请求）
      processPendingControls(thread);
      // - 用户 Steer → 注入方向修正
      // - 用户 Interrupt → 中断当前执行
      // - 协作模式切换 → 调整自主度

      // 3. LLM 推理
      const response = await llm.generate({
        model: thread.config.model,
        messages: context.messages,
        tools: context.availableTools,     // ← 工具列表来自客户端注册
        reasoning_effort: thread.config.reasoningEffort,
      });

      // 4. 处理响应
      if (response.finishReason === "tool_calls") {
        // 4a. 发送 tool call 到客户端
        for (const toolCall of response.toolCalls) {
          const result = await this.sendToolCallToClient(toolCall);
          //    ↑ WebSocket 或 SSE → 客户端的 Worker 线程
          //    ↓ 客户端执行后返回结果

          // 4b. 将结果追加到对话历史
          context.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
          });
        }
        // 继续循环（下一次 LLM 调用会看到 tool result）
      } else if (response.finishReason === "stop") {
        // 5. 处理停止
        if (thread.hasGoal) {
          // Goal 模式下输出 Remark-Directive
          const directive = parseRemarkDirective(response.text);
          // ::inbox-item{title="..." summary="..."}
          if (directive) {
            await updateInbox(thread, directive);
          }
        }
        break;
      }
    }
  }

  // === 上下文构建 ===
  async function buildContext(thread: Thread): Promise<AgentContext> {
    const systemPrompt = buildSystemPrompt({
      goal: thread.goal,
      plan: thread.plan,
      permissionMode: thread.collaborationMode,
      workspaceRoots: thread.workspaceRoots,
      automationConfig: thread.automation,
      plugins: thread.registeredPlugins,  // ← 带 SKILL.md 描述
    });

    const messages = await compactIfNeeded(thread.messages);
    // compact: 过长对话自动压缩，保留关键信息

    return {
      messages: [systemPrompt, ...messages],
      availableTools: buildToolList(thread.registeredPlugins),
    };
  }
}
```

### 4.2 Steer vs Send：Agent Loop 层面的差异

这是 Codex Agent 最具创新性的设计之一：

```
普通 Send（新增 user message）:
  messages = [
    ...history,
    { role: "user", content: "帮我把按钮颜色改成蓝色" }
  ]
  → LLM 生成回复
  → Agent 执行

Steer（方向修正，不新增消息）:
  // Agent 正在执行的 Plan 中
  // Step 2: "重构用户管理模块" ← 正在做

  用户点击 Steer 并输入："跳过 Step 2，直接做 Step 3"

  // 服务端处理：
  // 不是 append 新 user message
  // 而是修改 Agent 的内部状态：
  plan.steps[2].status = "skipped"
  plan.currentStep = 3

  // System Prompt 中会注入：
  // "User has steered: skip refactoring, proceed to step 3."
  // "Continue from where you left off, but adjust direction."

  // 优势：不改写对话历史，Agent 保持已有上下文
  //      只是"方向盘"被用户修正了一下
```

### 4.3 Plan 系统：Agent Loop 的执行骨架

```typescript
// Goal 模式下的 Plan 驱动执行
interface PlanExecution {
  plan: {
    steps: Array<{
      index: number;
      description: string;
      status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
      subAgentThreadId?: string;  // 如果委托给 sub-agent
    }>;
  };

  // 执行流程
  async executePlan():
    while (plan.steps.some(s => s.status === "pending")) {
      const nextStep = plan.steps.find(s => s.status === "pending");

      // 可选：创建 sub-agent 处理子步骤
      if (nextStep.complexity > threshold) {
        nextStep.subAgentThreadId = await createSubAgent(nextStep);
        // Sub-agent 在独立 Thread 中执行
        // 有自己的 Agent Loop 和上下文
        const result = await waitForSubAgent(nextStep.subAgentThreadId);
        nextStep.status = result.success ? "completed" : "failed";
      } else {
        // 主 Agent 直接执行
        nextStep.status = "in_progress";
        await agentLoop.executeStep(nextStep);
        nextStep.status = "completed";
      }

      // 实时更新 Plan 状态到客户端
      await broadcastPlanUpdate(plan);
    }
}
```

---

## 5. Tool 注册和调度机制

### 5.1 三层 Tool 注册体系

```
Layer 1: 内置 MCP Tools（代码中硬编码）
  └── Computer Use: 9 个 MCP Tools
      - list_apps / get_app_state / click / type_text / ...
      - 通过 SkyComputerUseClient 子进程暴露
      - macOS 专用，权限系统双层防护

Layer 2: Plugin MCP Tools（插件 manifest 声明）
  └── browser-use: browser.tabs / navigate / click / screenshot / ...
  └── chrome: 真实 Chrome 控制
  └── codex-cli: 终端/Shell 命令
  └── latex-tectonic: LaTeX 编译
  └── 第三方插件: 用户安装的任意 MCP Server

Layer 3: 原生能力（Worker 线程直接执行）
  └── 文件读写 (fs)
  └── Shell 命令 (node-pty)
  └── HTTP 请求 (http/https)
  └── SQLite 查询 (better-sqlite3)
```

### 5.2 Tool 注册到 Agent 的完整链路

```
┌─ Plugin Manifest ──────────────────────────────────────────────────┐
│                                                                     │
│  plugin.json                         SKILL.md                       │
│  ┌──────────────────────────┐        ┌──────────────────────────┐  │
│  │ {                        │        │ # Computer Use Skill     │  │
│  │   "name": "computer-use",│        │                          │  │
│  │   "description":         │───────►│ ## When to Use           │  │
│  │    "Control desktop apps"│  给     │ When the user asks to   │  │
│  │                          │  LLM    │ control desktop apps... │  │
│  │   "mcpServers": {        │  读     │                          │  │
│  │     "command": "...",    │        │ ## Available Tools       │  │
│  │     "args": ["mcp"]      │        │ - list_apps: ...        │  │
│  │   }                      │        │ - click: ...            │  │
│  │ }                        │        │ - type_text: ...        │  │
│  └──────────────────────────┘        └──────────────────────────┘  │
│                                                                     │
│  注册流程:                                                          │
│  1. 主进程读取 plugin.json                                          │
│  2. 启动 MCP Server 子进程 (spawn command args)                      │
│  3. MCP Server 宣布其 Tools (JSON-RPC tools/list)                   │
│  4. 主进程将此信息发送到服务端                                       │
│  5. 服务端 Agent Loop 的 System Prompt 注入 Tools 列表               │
│  6. SKILL.md 内容作为 System Prompt 的附加指令                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.3 Tool Call 的完整执行路径

```
  服务端 Agent Loop                    本地 Electron App
  ──────────────────                  ───────────────────
        │                                    │
        │  1. LLM 决定调用 click tool        │
        │     tool_call: {                   │
        │       name: "click",               │
        │       arguments: {                 │
        │         elementIndex: 42           │
        │       }                            │
        │     }                              │
        │                                    │
        │── 2. WebSocket: tool_call ────────►│
        │                                    │
        │                            ┌───────┴──────────────┐
        │                            │ 主进程 接收 tool_call │
        │                            │ → 路由到对应 MCP Server│
        │                            └───────┬──────────────┘
        │                                    │
        │                            ┌───────┴──────────────┐
        │                            │ SkyComputerUseClient  │
        │                            │ stdin: {"method":     │
        │                            │   "tools/call", ...}  │
        │                            └───────┬──────────────┘
        │                                    │ Apple Events IPC
        │                            ┌───────┴──────────────┐
        │                            │ SkyComputerUseService │
        │                            │ AXUIElementPerform-   │
        │                            │ Action(element, click) │
        │                            └───────┬──────────────┘
        │                                    │
        │                            ┌───────┴──────────────┐
        │                            │ 结果: {               │
        │                            │   success: true,      │
        │                            │   screenshot: "..."   │
        │                            │ }                     │
        │                            └───────┬──────────────┘
        │                                    │
        │◄── 3. WebSocket: tool_result ──────│
        │                                    │
        │  4. LLM 处理 tool_result           │
        │     决定: 下一步是 type_text        │
        │     → 继续循环...                  │
```

### 5.4 审批拦截点

Tool 执行链路中有三个审批拦截点：

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
                 ┌─ 审批检查 3: 文件操作审批 ────────────────┐
                 │  写文件 → file-approval-decision           │
                 │  执行命令 → command-approval-decision      │
                 └──────────────────────────────────────────┘
                              │
                              ▼
                        执行 Tool
```

---

## 6. 对比：VSCode 如果走 Codex 的路

### 6.1 当前 VSCode 架构的问题

```
┌──────────────────────────────────────────────────┐
│  VSCode 进程模型                                  │
│                                                  │
│  主进程 (1)                                      │
│  ├── Extension Host (1 per workspace)            │
│  │   └── 所有扩展共享此进程                      │
│  │       └── GitHub Copilot 扩展                  │
│  │           └── Agent Loop (本地)               │
│  │               └── LLM API 调用                │
│  │                   └── 本地 Tool 执行          │
│  │                                               │
│  问题：                                          │
│  1. 新工作区 = 新 Extension Host = 加载所有扩展  │
│  2. 扩展一多，启动就慢                            │
│  3. Agent Loop 在扩展进程中，等网络 IO 浪费资源   │
│  4. 工作区崩溃影响 Extension Host                 │
└──────────────────────────────────────────────────┘
```

### 6.2 如果自研项目采用 Codex 模式

```typescript
// 推荐架构：
//
// 本地层：一个轻量的 Tool Executor 进程（不跑 Agent Loop）
// 服务端层：每个会话一个 Agent Loop 实例

interface RecommendedArchitecture {
  // === 本地层（取代 VSCode Extension Host） ===

  // 单一 Tool Executor 进程
  toolExecutor: {
    // 注册所有可用工具
    registeredTools: Map<string, ToolHandler>;

    // 接收来自服务端 Agent Loop 的 tool call
    onToolCall(call: ToolCall): Promise<ToolResult>;

    // 工作区感知：通过 cwd/workspaceRoot 而非进程隔离
    activeWorkspaceRoot: string;
  };

  // === 服务端层 ===

  // 每个会话独立的 Agent Loop
  agentLoopPerSession: {
    sessionId: string;
    workspaceRoot: string;
    conversationHistory: Message[];
    registeredTools: ToolDescription[]; // 从客户端同步

    async loop() {
      while (this.active) {
        // LLM 推理
        // Tool 选择
        // 发送 tool call 到客户端
        // 等待 tool result
        // 继续循环
      }
    }
  };

  // === 关键差异对比 ===

  // VSCode 模式：
  //   新项目 → 新 Extension Host 进程 → 加载扩展 → Agent 开始工作
  //   时间：进程启动 ~2s + 扩展加载 ~3-5s = 5-7s

  // Codex 模式：
  //   新项目 → 服务端创建新 Session → 同步 workspace root → Agent 开始工作
  //   时间：API 调用 ~200ms + 上下文初始化 ~100ms = 300ms
}
```

---

## 7. 安全与隔离的权衡总结

### 7.1 Codex 的设计取舍

| 维度 | Codex 的选择 | 代价 |
|------|-------------|------|
| **Agent Loop 位置** | 服务端（API 驱动） | 需要网络连接，离线不可用 |
| **工作区隔离** | 服务端 Thread 级别 | 本地文件系统无强制隔离 |
| **进程模型** | 1 个 Electron + N 个 MCP 子进程 | 子进程崩溃可能影响工具可用性 |
| **状态管理** | 服务端为主 + 本地缓存 | 网络断开时状态可能不一致 |
| **安全边界** | 服务端策略 + Turn 生命周期 | 策略依赖网络获取 |

### 7.2 对自研项目的建议

1. **Agent Loop 不要放在本地进程**。参考 Codex 的设计，Agent Loop 应该运行在可以水平扩展的服务端，本地只做 Tool Execution。

2. **工作区不应该等于进程**。VSCode 的"一个工作区一个 Extension Host"模型不适用于 AI Agent 场景。用 session ID + workspace root 的软隔离替代进程级硬隔离。

3. **Tool 注册应该动态化**。不要让 Agent 的能力硬编码在进程中。通过 MCP 协议让工具可以动态注册、按需加载。

4. **审批应该分层**。高风险操作（Shell 命令、文件写入、网络请求）应该有独立的审批路径，不依赖单一权限模型。

5. **保留进程隔离用于真正的沙箱需求**。Computer Use 的双进程架构是正确的——高权限操作放在权限被限制的独立进程中。

---

## 附录 A：关键文件大小对照

| 文件 | 大小 | 角色 |
|------|------|------|
| bootstrap.js | 3.7 KB | 启动入口 |
| main.js | 1.1 MB | 主进程核心 |
| app-session.js | 4.3 MB | Rust WASM 业务逻辑 |
| worker.js | 1.2 MB | 后台 Worker 线程 |
| preload.js | 2.4 KB | Electron Bridge |
| comment-preload.js | 35 MB | 浏览器侧边栏 + i18n |
| sandbox-preload.js | 8 KB | MCP 沙箱通信 |
| objc-js .node | 639 KB | ObjC Runtime 桥接 |
| better-sqlite3 .node | 1.9 MB | 本地数据库 |
| node-pty .node | 105 KB | 伪终端 |
| app.asar | 137 MB | 完整打包 |

## 附录 B：Agent Loop 在服务端的间接证据

1. Thread-Follower 的 15 个请求类型全部是 RPC 语义（客户端 → 服务端 → 等待响应）
2. Worker 线程不包含 LLM SDK 或 prompt 构建相关代码
3. MCP Tool 注册信息需要被"上传"到服务端（不是在本地消费）
4. Goal/Plan 状态通过 server 事件广播到所有窗口
5. Automation 的 Heartbeat 触发也是服务端驱动的定时机制
6. Compact Thread（对话压缩）在服务端执行（不是本地裁剪）
