# Codex 计划执行系统与多智能体/子智能体系统分析

> 基于 Codex 桌面应用 ASAR 逆向工程分析（main.js 与 i18n comment-preload.js）
> 分析日期: 2026-05-16

---

## 目录
1. [计划执行系统](#1-计划执行系统)
2. [多智能体/子智能体系统](#2-多智能体子智能体系统)
3. [关键代码重构](#3-关键代码重构)

---

## 1. 计划执行系统

### 1.1 概述

Codex 的计划（Plan）系统非常简洁，本质上是一个嵌入在对话流中的 **GFM（GitHub Flavored Markdown）任务列表**。它不是一个独立的 UI 组件，而是作为 Markdown 渲染的一部分内联展示在对话中。

### 1.2 i18n 国际化键

整个计划系统仅有 **3 个** i18n 键：

| i18n Key | 英文含义 | 用途 |
|---|---|---|
| `codex.plan.stepIndexPrefix` | `{index}.` | 步骤序号前缀 |
| `codex.plan.tasksCompletedSummary` | `{completed} of {total} tasks completed` | 任务完成进度摘要 |
| `codex.plan.todoListCreated` | `Todo list created with {total} tasks` | 计划创建提示 |

此外还有一个旧的/别名键 `codex.todoPlan.stepIndexPrefix`（值与 plan 版本相同）。

### 1.3 计划渲染机制

Codex 的计划是通过 **GFM 任务列表（Task List）** Markdown 扩展渲染的。在 main.js 中发现了 GFM 任务列表渲染器的相关代码：

```javascript
// GFM 任务列表渲染（main.js 中提取并重构的代码片段）
_gfmTasklistFirstContentOfListItem  // 标记列表项的第一个内容
_isInFirstContentOfListItem         // 检测是否在列表项的首个内容中

// 渲染逻辑：
// 1. 解析 Markdown 中的 - [ ] / - [x] 任务列表语法
// 2. 为每个任务列表项生成带有复选框的 DOM
// 3. 在列表项首个内容前添加 GFM 任务标记
// 4. 当 Agent 更新任务状态时，动态更新渲染
```

计划的实际表现形式是一个 **带复选框的 Markdown 任务列表**：

```markdown
1. [x] 分析现有代码结构
2. [x] 识别关键模块
3. [ ] 实现新功能
4. [ ] 编写测试
```

Agent 生成计划后，以 Markdown 消息的形式输出在对话中。任务完成时，标记从 `[ ]` 变为 `[x]`。

### 1.4 计划状态跟踪

代码中未发现显式的计划状态机（如 `not_started -> in_progress -> completed -> failed`）。计划的状态完全通过任务列表项的完成状态隐式表达：

- **创建**: Agent 输出包含 GFM 任务列表的 Markdown 消息
- **进行中**: 部分任务标记为 `[x]`，部分仍为 `[ ]`
- **完成**: 所有任务标记为 `[x]`
- **进度显示**: 使用 `tasksCompletedSummary` 显示 "{completed} of {total} tasks completed"

计划创建时显示 `"Todo list created with {total} tasks"` 提示。

### 1.5 计划总结/折叠

搜索 `plan.*collapse|collapse.*plan` 时发现的匹配实际上是 **git worktree 清理计划（plan-summary）**，而非用户可见的计划系统的折叠功能。这说明计划系统本身不支持折叠/展开，计划内容作为普通对话消息的一部分，跟随对话滚动。

### 1.6 计划系统架构总结

```
┌──────────────────────────────────────────────────┐
│                  Codex Agent                       │
│                                                      │
│  1. Agent 决定创建计划                               │
│  2. 生成 GFM 任务列表 Markdown                     │
│  3. 以消息形式输出到对话流                          │
│  4. 渲染引擎将 Markdown 渲染为带复选框的 UI         │
│  5. 任务完成时更新 Markdown 中的 [ ] → [x]         │
│  6. 显示进度摘要 (completed/total)                  │
└──────────────────────────────────────────────────┘
```

---

## 2. 多智能体/子智能体系统

### 2.1 概述

Codex 的 Multi-Agent 系统允许用户将工作委托（delegate）给**子智能体（sub-agents）**，子智能体可以并行执行任务。系统包含完整的子智能体生命周期管理、沙箱隔离和通信机制。

### 2.2 i18n 国际化键

#### 2.2.1 MultiAgent Composer Banner

| i18n Key | 中文含义 |
|---|---|
| `codex.multiAgentComposerBanner.title` | Codex 中的子智能体 |
| `codex.multiAgentComposerBanner.body` | 将工作委托给并行工作的子智能体。注意：可能增加 token 使用量。 |
| `codex.multiAgentComposerBanner.cta.primary` | 立即尝试 |
| `codex.multiAgentComposerBanner.dismissLabel` | 关闭子智能体横幅 |

#### 2.2.2 MultiAgent Action 状态机

| i18n Key | 含义 |
|---|---|
| `localConversation.multiAgentAction.agentState.pendingInit` | 等待初始化 |
| `localConversation.multiAgentAction.agentState.running` | 运行中 |
| `localConversation.multiAgentAction.agentState.completed` | 已完成 |
| `localConversation.multiAgentAction.agentState.errored` | 出错 |
| `localConversation.multiAgentAction.agentState.interrupted` | 已中断 |
| `localConversation.multiAgentAction.agentState.notFound` | 未找到 |
| `localConversation.multiAgentAction.agentState.shutdown` | 已关闭 |

#### 2.2.3 MultiAgent 操作（Actions）

支持 **四种操作**，每种操作有 `inProgress` / `completed` / `failed` 三种状态：

| 操作 | 键前缀 |
|---|---|
| **spawn** (生成) | `header.spawn.*`, `row.spawn.*`, `rowAction.spawn.*` |
| **sendInput** (发送输入) | `header.sendInput.*`, `row.sendInput.*`, `rowAction.sendInput.*` |
| **resume** (恢复) | `header.resume.*`, `rowAction.resume.*` |
| **close** (关闭) | `header.close.*`, `rowAction.close.*` |

#### 2.2.4 Background Subagents（后台子智能体 UI）

| i18n Key | 含义 |
|---|---|
| `composer.backgroundSubagents.collapse` | 折叠后台智能体详情 |
| `composer.backgroundSubagents.expand` | 展开后台智能体详情 |
| `composer.backgroundSubagents.invokeAgents` | @ 以提及智能体 |
| `composer.backgroundSubagents.row.activeLabel` | 工作中 |
| `composer.backgroundSubagents.row.doneLabel` | 已完成 |
| `composer.backgroundSubagents.row.waitingLabel` | 等待指令 |
| `composer.backgroundSubagents.row.open` | 打开 |
| `composer.backgroundSubagents.stopAll` | 全部停止 |
| `composer.backgroundSubagents.stopAllTooltip` | 停止此聊天中的所有子智能体 |
| `composer.backgroundSubagents.summary` | {count} 个后台智能体 |
| `composer.backgroundSubagents.summary.expanded` | {summary} {hint} |

### 2.3 子智能体生命周期状态机

```
              ┌──────────────┐
              │  pendingInit │  等待初始化
              └──────┬───────┘
                     │ spawn 操作
              ┌──────▼───────┐
              │   running    │  运行中
              └──────┬───────┘
         ┌───────────┼───────────┐
         │           │           │
    ┌────▼────┐ ┌────▼────┐ ┌───▼──────┐
    │completed│ │ errored │ │interrupted│
    └─────────┘ └─────────┘ └──────────┘
                      │
                 ┌────▼────┐
                 │ shutdown │  已关闭
                 └─────────┘
```

### 2.4 子智能体操作流程

每个操作都有 `inProgress → completed` 或 `inProgress → failed` 的状态流转：

```
spawn:    inProgress → createdWithInstructions (completed)
sendInput: inProgress → messagedWithPrompt (completed)
resume:   inProgress → completed
close:    inProgress → completed
```

### 2.5 沙箱政策（Sandbox Policies）

从代码中提取的沙箱安全级别：

```javascript
// 沙箱策略类型 (sandboxPolicy.type)
sandboxPolicy.type === 'dangerFullAccess'  → 'danger-full-access'  // 危险：完全访问
sandboxPolicy.type === 'readOnly'           → 'read-only'           // 只读
// 默认 → 'workspace-write'                                        // 工作区写入

// 权限模式映射
permissionMode === 'acceptEdits'  → 'workspace-write'
permissionMode === 'readOnly'     → 'read-only'
```

### 2.6 审批政策（Approval Policies）

```javascript
// 审批政策类型
// 1. 'auto' - 自动审批（默认）
// 2. 'custom' - 自定义（当 sandbox_mode 或 approval_policy 被显式设置时）
// 3. 'guardian-approvals' - 守护审批（guardian_subagent 专用）
// 4. 'read-only' - 只读模式
// 5. 'never' - 永不自动审批（需要用户确认）
```

### 2.7 Guardian 子智能体

代码中发现了一种特殊的子智能体类型 `guardian_subagent`：

```javascript
// guardian_subagent 的审批逻辑（重构）
function getApprovalMode(subagentType, approvalPolicy, sandboxMode) {
  if (sandboxMode != null || approvalPolicy != null) {
    return 'custom';
  }
  if (subagentType === 'guardian_subagent') {
    return 'guardian-approvals';
  }
  return 'auto';
}

// 根据审批模式选择合适的安全策略
function resolveApprovalPolicy(mode, config) {
  let policy = mode;
  // 降级逻辑：确保选择一个有效的审批策略
  if (!allowedPolicies.includes(policy)) {
    if (mode === 'auto' && allowedPolicies.includes('guardian-approvals')) {
      policy = 'guardian-approvals';
    } else if (mode === 'guardian-approvals' && allowedPolicies.includes('auto')) {
      policy = 'auto';
    } else if (allowedPolicies.includes('read-only')) {
      policy = 'read-only';
    } else {
      policy = allowedPolicies[0] ?? 'read-only';
    }
  }
  return policy;
}
```

### 2.8 子智能体线程管理

```javascript
// 子智能体线程打开事件
// 当子智能体线程被创建时，通过 IPC 发送 'subagent-thread-opened' 消息
case 'subagent-thread-opened':
  appServerConnection.markSubagentThreadOpened(conversationId);
  break;

// 子智能体浏览器路由检查
// 子智能体线程中不支持 IAB（In-App Browser）可见性控制
function isSubagentBrowserUseRoute(route, turnId) {
  if (turnId == null) return false;
  let routeInfo = turnRoutes.get(createRouteKey({conversationId, turnId}));
  return routeInfo?.disposeAfterTurn === false && 
         routeInfo.windowId === route.windowId;
}

// 在子智能体线程中尝试设置浏览器可见性会抛出错误
if (registry.isSubagentBrowserUseRoute(route, turn)) {
  throw Error('IAB visibility is not supported in a subagent thread');
}
```

### 2.9 Thread Fork（线程分叉）

`forkThread` API 用于从现有线程创建新线程：

```javascript
// forkThread API 定义
forkThread: async (params) => ({
  threadId: (await appServerClient.forkThread(params)).thread.id
})

// forkThread 的调用场景包括：
// 1. 导入 Rollouts（发布计划）
// 2. 创建新的子线程
// 3. 线程复制/备份

// forkThread 参数
{
  cwd: "工作目录路径",
  path: "代码路径",
  persistExtendedHistory: false,
  threadId: "源线程ID"
}
```

### 2.10 Agent 配置

子智能体的配置通过以下文件和字段管理：

**配置文件:**
- `AGENTS_MD` - Agent 的 Markdown 指令文件
- `agents.json` - Agent 的 JSON 配置文件
- `cowork_settings.json` - Cowork 设置
- `cowork_account_settings.json` - Cowork 账户设置
- `spaces.json` - 工作空间配置
- `skills.json` - 技能配置

**Agent 配置结构:**
```javascript
{
  modelProvider: null,
  cwd: "工作目录",
  approvalPolicy: "auto" | "custom" | "guardian-approvals",
  approvalsReviewer: "user",
  sandbox: "danger-full-access" | "read-only" | "workspace-write",
  config: {},                    // 额外配置
  developerInstructions: "...",  // 开发者指令（可覆盖基础指令）
  personality: null,
  ephemeral: null,               // 子智能体是否临时存在
  threadSource: "user",          // 线程来源（主线程）
  dynamicTools: null,
  mockExperimentalField: null,
  experimentalRawEvents: false,
  persistExtendedHistory: false,
  serviceTier: "服务等级"
}
```

### 2.11 后台子智能体 UI 架构

Composer（输入框）中集成了后台子智能体管理面板：

```
┌────────────────────────────────────────┐
│  Background Subagents (后台子智能体)     │
│  ──────────────────────────────────     │
│  SubAgent 1  [工作中] [打开]            │
│  SubAgent 2  [等待指令] [打开]          │
│  SubAgent 3  [已完成] [打开]            │
│  ──────────────────────────────────     │
│  [折叠详情]  [全部停止]  @提及智能体     │
│  摘要: {count} 个后台智能体             │
└────────────────────────────────────────┘
```

- 用户通过 `@` 提及来调用智能体
- 智能体状态：工作中（active）、等待指令（waiting）、已完成（done）
- 支持展开/折叠详情
- 支持一键停止所有子智能体

### 2.12 Web 沙箱隔离

`sandbox-preload.js` 实现了 MCP App 的 Web 沙箱隔离：

```javascript
// sandbox-preload.js 核心逻辑（重构）
const SANDBOX_DOMAIN = 'web-sandbox.oaiusercontent.com';

// 验证消息来源
function isValidOrigin(url) {
  return url.hostname === SANDBOX_DOMAIN || url.hostname.endsWith('.' + SANDBOX_DOMAIN);
}

// 验证 init ID 格式
function isValidInitId(id) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

// MCP App 允许的通信方法
const ALLOWED_METHODS = [
  'navigate',
  'notifyMcpAppsHostContext',
  'notifyMcpAppsToolCancelled',
  'notifyMcpAppsToolInput',
  'notifyMcpAppsToolResult',
  'requestMcpAppsResourceTeardown',
  'runWidgetCode',
  'setAdditionalGlobals',
  'setSafeArea',
  'setTheme',
  'setWidgetData',
  'setWidgetView'
];

// 初始化沙箱通信
// 1. 验证消息来源
// 2. 解析 init ID
// 3. 建立 MessagePort 通信通道
// 4. 通过 ipcRenderer 中继消息
```

沙箱域名为 `web-sandbox.oaiusercontent.com`（OpenAI 的子域名），用于隔离 MCP App 的执行环境。

### 2.13 多智能体系统架构总结

```
┌──────────────────────────────────────────────────────────┐
│                    Codex Desktop App                       │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │              Primary Agent Thread                     │  │
│  │  threadSource: "user"                                │  │
│  │  ┌─────────────────────────────────────────────┐    │  │
│  │  │         MultiAgentComposerBanner              │    │  │
│  │  │  "将工作委托给并行工作的子智能体"              │    │  │
│  │  └─────────────────────────────────────────────┘    │  │
│  └──────────┬──────────────────────────────────────────┘  │
│             │ spawn / sendInput / resume / close           │
│             │                                              │
│  ┌──────────▼──────────────────────────────────────────┐  │
│  │           Background Subagents                        │  │
│  │                                                        │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐│  │
│  │  │  SubAgent 1  │  │  SubAgent 2  │  │  SubAgent 3  ││  │
│  │  │  [running]   │  │  [running]   │  │  [pendingInit]││  │
│  │  │  sandbox:    │  │  sandbox:    │  │  sandbox:    ││  │
│  │  │  ws-write    │  │  read-only   │  │  ws-write    ││  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘│  │
│  │                                                        │  │
│  │  Guardian: guardian-approvals 审批                      │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │              Sandbox Isolation                        │  │
│  │  web-sandbox.oaiusercontent.com                      │  │
│  │  - MCP Apps 在沙箱域中执行                            │  │
│  │  - 限制的通信方法（12 种）                            │  │
│  │  - MessagePort 通信                                   │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## 3. 关键代码重构

### 3.1 子智能体生成流程

```javascript
// 重构的子智能体生成流程
async function spawnSubAgent({
  appServerConnection,
  threadId,
  cwd,
  prompt,
  agentConfig,
  sandboxPolicy,
  approvalPolicy
}) {
  // 1. 确定沙箱策略
  const sandbox = sandboxPolicy?.type === 'dangerFullAccess'
    ? 'danger-full-access'
    : sandboxPolicy?.type === 'readOnly'
      ? 'read-only'
      : 'workspace-write';

  // 2. 构建子智能体配置
  const subAgentParams = {
    threadId,
    input: [{ type: 'text', text: prompt }],
    cwd,
    approvalPolicy,
    approvalsReviewer: 'user',
    sandboxPolicy,
    model: agentConfig.model,
    effort: agentConfig.effort,
    serviceTier: agentConfig.serviceTier,
    summary: 'auto',
    personality: null,
    outputSchema: null,
    collaborationMode: agentConfig.collaborationMode
  };

  // 3. 启动子智能体线程
  const threadConfig = {
    modelProvider: null,
    cwd,
    approvalPolicy,
    approvalsReviewer: 'user',
    sandbox,
    config: agentConfig,
    developerInstructions: agentConfig.developerInstructions,
    personality: null,
    ephemeral: null,
    threadSource: 'user',
    dynamicTools: null,
    mockExperimentalField: null,
    experimentalRawEvents: false,
    persistExtendedHistory: false,
    serviceTier: agentConfig.serviceTier
  };

  return await appServerConnection.startThread(threadConfig);
}
```

### 3.2 子智能体浏览器路由管理

```javascript
// 重构的子智能体浏览器路由管理
class BrowserSessionRegistry {
  turnRoutes = new Map();

  // 检查是否为子智能体浏览器路由
  isSubagentBrowserUseRoute(route, turnId) {
    if (turnId == null) return false;
    const key = createRouteKey({ conversationId: route.conversationId, turnId });
    const routeInfo = this.turnRoutes.get(key);
    return routeInfo?.disposeAfterTurn === false &&
           routeInfo?.windowId === route.windowId;
  }

  // 子智能体不支持 IAB 可见性控制
  setBrowserVisibleForBrowserUse(route, visible) {
    if (this.isSubagentBrowserUseRoute(route, turnId)) {
      throw Error('IAB visibility is not supported in a subagent thread');
    }
    // ... 正常流程
  }

  // 标记子智能体线程已打开
  markSubagentThreadOpened(conversationId) {
    // 通知 AppServerConnection 子智能体线程已打开
    this.getAppServerConnection(hostId).markSubagentThreadOpened(conversationId);
  }
}
```

### 3.3 计划渲染流程

```javascript
// 重构的计划渲染流程（基于 GFM 任务列表）
class PlanRenderer {
  // 计划本质上是一个 GFM Markdown 任务列表
  // Agent 输出格式:
  //
  //   1. [ ] 第一步任务
  //   2. [ ] 第二步任务
  //   3. [ ] 第三步任务
  //
  // 渲染引擎:
  // 1. 解析 Markdown 列表项
  // 2. 检测 GFM 任务列表标记 [ ] / [x]
  // 3. 渲染为带复选框的 UI
  // 4. 任务完成时更新渲染

  renderPlanSteps(steps) {
    // 使用 i18n 键显示步骤编号
    return steps.map((step, index) => ({
      prefix: t('codex.plan.stepIndexPrefix', { index: index + 1 }),
      // 输出: "1.", "2.", "3."
      checked: step.completed,
      text: step.description
    }));
  }

  renderProgressSummary(completed, total) {
    return t('codex.plan.tasksCompletedSummary', { completed, total });
    // 输出: "3 of 5 tasks completed"
  }

  renderCreationNotice(total) {
    return t('codex.plan.todoListCreated', { total });
    // 输出: "Todo list created with 5 tasks"
  }
}
```

### 3.4 Sandbox 预加载脚本

```javascript
// sandbox-preload.js 重构
const SANDBOX_DOMAIN = 'web-sandbox.oaiusercontent.com';
const INIT_ID_PARAM = 'initId';

// 允许的 MCP 通信方法
const ALLOWED_METHODS = [
  'navigate',
  'notifyMcpAppsHostContext',
  'notifyMcpAppsToolCancelled',
  'notifyMcpAppsToolInput',
  'notifyMcpAppsToolResult',
  'requestMcpAppsResourceTeardown',
  'runWidgetCode',
  'setAdditionalGlobals',
  'setSafeArea',
  'setTheme',
  'setWidgetData',
  'setWidgetView'
];

// 来源验证
function validateOrigin(url) {
  const hostname = new URL(url).hostname;
  return hostname === SANDBOX_DOMAIN || hostname.endsWith('.' + SANDBOX_DOMAIN);
}

// Init 消息处理
window.addEventListener('message', (event) => {
  // 验证来源
  if (event.source !== window) return;
  if (!validateOrigin(window.location.href)) return;
  if (event.data?.type !== 'init') return;

  // 解析 init ID
  const initId = extractInitId(window.location.href);
  if (!initId || !isValidInitId(initId)) return;

  // 建立 MessagePort 通道
  const ports = event.data.ports;
  const replyPort = event.data.replyPort;

  // 验证所有允许的方法都有对应的 MessagePort
  const validPorts = ALLOWED_METHODS.map(method => ports[method]);
  if (validPorts.some(port => !isValidPort(port))) return;

  // 通过 ipcRenderer 中继到主进程
  ipcRenderer.postMessage('codex_desktop:mcp-app-sandbox-guest-message', {
    origin: window.location.origin,
    initId,
    portNames: ALLOWED_METHODS,
    type: 'init'
  }, [...validPorts, replyPort]);
});
```

---

## 4. 总结

### 4.1 计划系统特点

| 特性 | 实现方式 |
|---|---|
| 计划数据结构 | GFM Markdown 任务列表 (`- [ ]` / `- [x]`) |
| 计划创建 | Agent 输出包含任务列表的 Markdown 消息 |
| 进度跟踪 | 已完成任务数 / 总任务数 |
| 状态管理 | 无显式状态机，通过任务完成状态隐式表达 |
| UI 渲染 | Markdown 渲染引擎的内联渲染 |
| 折叠/展开 | 不支持（无相关 i18n 键或代码逻辑） |
| i18n 键数量 | 3 个 |

### 4.2 多智能体系统特点

| 特性 | 实现方式 |
|---|---|
| 子智能体生成 | `spawn` 操作，可在 Composer 中通过 @ 触发 |
| 生命周期管理 | pendingInit → running → completed/errored/interrupted/shutdown |
| 操作类型 | spawn、sendInput、resume、close |
| 操作状态 | inProgress → completed/failed |
| 审批策略 | auto、custom、guardian-approvals、read-only、never |
| 沙箱策略 | dangerFullAccess、readOnly、workspace-write |
| 特殊类型 | guardian_subagent（守护审批） |
| 线程隔离 | 子智能体线程不支持 IAB 浏览器可见性控制 |
| Fork 支持 | forkThread API 复制线程 |
| 配置文件 | AGENTS_MD, agents.json, cowork_settings.json |
| UI 组件 | MultiAgentComposerBanner + Background Subagents 面板 |
| Web 沙箱 | web-sandbox.oaiusercontent.com 域名隔离 |
| 开发者指令 | developer_instructions 覆盖基础指令 |
| i18n 键数量 | 40+ 个 |

### 4.3 关键发现

1. **计划系统极度简化**：Codex 的计划与一些独立计划引擎（如 Samsung's Codex Plan 或独立的 Todo 系统）不同，它完全依赖 Markdown 任务列表的渲染能力，没有独立的状态机、持久化或任务依赖关系管理。

2. **多智能体面向并行执行**：子智能体系统是为并行任务执行而设计的，体现在后台子智能体（Background Subagents）的 UI 设计上，多个子智能体可以同时处于 `running` 状态。

3. **安全分层**：从只读（read-only）到工作区写入（workspace-write）到完全访问（dangerFullAccess），形成一个三级安全模型。Guardian 子智能体有特殊的审批通道。

4. **线程来源标记**：`threadSource: 'user'` 表明 Codex 区分用户创建的线程和子智能体创建的线程。

5. **子智能体受限 IAB**：子智能体线程不支持 In-App Browser（IAB）的可见性控制，这是一个有趣的限制。
