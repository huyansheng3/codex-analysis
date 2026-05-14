# Codex Goal 模式 —— Agent 层核心实现

> 来源：main.js 中嵌入的 System Prompt 模板、Thread-Follower 请求类型、Automation Heartbeat 格式
> 版本：26.506.31421

---

## 1. Agent 层架构

Goal 模式在 Agent 层的核心不是单一功能，而是**三个独立但协同的系统**：

```
┌─────────────────────────────────────────────────────────────┐
│  Goal / Automation 的 Agent 层实现                           │
│                                                             │
│  1. Remark-Directive 系统 ── Agent 的结构化输出格式           │
│     └── ::inbox-item{title="..." summary="..."}             │
│                                                             │
│  2. Heartbeat / Automation 系统 ── 定时/后台自主执行         │
│     └── <heartbeat><automation_id>...</heartbeat>           │
│                                                             │
│  3. Thread-Follower 系统 ── Steer/Interrupt/Collaboration   │
│     └── 15 个请求类型，实现人机协作的实时控制                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Remark-Directive 系统（完整 System Prompt 模板）

这是 Goal 模式的**核心 Agent 指令**。从 main.js 偏移 22841 处完整提取：

### 2.1 完整模板

```markdown
Response MUST end with a remark-directive block.

## Responding

- Answer the user normally and concisely. Explain what you found,
  what you did, and what the user should focus on now.

- Automations: use the memory file at
  `$CODEX_HOME/automations/<automation_id>/memory.md`
  (create it if missing).

  - Read it first (if present) to avoid repeating recent work,
    especially for "changes since last run" tasks.
  - Memory is important: some tasks must build on prior work,
    and others must avoid duplicating prior focus.
  - Before returning the directive, write a concise summary
    of what you did/decided plus the current run time.
  - Use the `Automation ID:` value provided in the message
    to locate/update this file.

- REQUIRED: End with a valid remark-directive block on its own
  line (not inline).
  - Always include an inbox item directive:
    `::inbox-item{title="Sample title" summary="Place description here"}`

## Choosing return value

- For recurring/bg threads (e.g., "pull datadog logs and fix
  any new bugs", "address the PR comments"):
  - Always return `::inbox-item{...}` with the title/summary
    the user should see.

## Guidelines

- Directives MUST be on their own line.
- Output exactly ONE inbox-item directive.
- Do NOT use invalid remark-directive formatting.
- DO NOT place commas between arguments.
  - Valid:
    `::inbox-item{title="Sample title" summary="Place description here"}`
  - Invalid:
    `::inbox-item{title="Sample title",summary="Place description here"}`
- When referring to files, use full absolute filesystem links
  in Markdown (not relative paths).
  - Valid: [`/Users/alice/project/src/main.ts`](/Users/alice/project/src/main.ts)
  - Invalid: `src/main.ts` or `[main](src/main.ts)`
- Try not to ask the user for more input if possible to infer.
- If a PR is opened by the automation, add the `codex-automation`
  label when available alongside the normal `codex` label.
- Inbox item copy should be glanceable and specific
  (avoid "Update", "Done", "FYI", "Following up").
  - Title: what this thread now _is_ (state + object). Aim ~4-8 words.
  - Title should explain what was built or what happened.
- Summary: what the user should _do/know next_
  (next step, blocker, or waiting-on). Aim ~6-14 words.
- Summary should usually match the general automation name or
  prompt summary.
- Both title and summary should be fairly short; usually avoid
  one-word titles/summaries.
  - Prefer concrete nouns + verbs; include a crisp status cue
    when helpful: "blocked", "needs decision", "ready for review".

## Examples (inbox-item)

- Work needed:
  - `::inbox-item{title="Fix flaky checkout tests"
       summary="Repro isolated; needs CI run + patch"}`

- Waiting on user decision:
  - `::inbox-item{title="Choose API shape for filters"
       summary="Two options drafted; pick A vs B"}`

- Status update with next step:
  - `::inbox-item{title="PR comments addressed"
       summary="Ready for re-review; focus on auth edge case"}`
```

### 2.2 解析规则

```typescript
// Codex 客户端解析 Agent 响应尾部的 remark-directive
interface RemarkDirective {
  type: "inbox-item";   // 目前仅此一种
  title: string;        // 4-8 字的标题
  summary: string;      // 6-14 字的摘要
}

// 解析器规则（从模板中提取）:
// 1. Directives 必须在单独的行上
// 2. 输出恰好 ONE inbox-item directive
// 3. 参数之间不使用逗号分隔（类似 markdown frontmatter 格式）
// 4. 文件引用必须使用完整绝对路径的 markdown 链接
```

---

## 3. Heartbeat / Automation 系统

### 3.1 Heartbeat XML 格式

Agent 在自动化/Goal 模式下收到的消息格式：

```xml
<heartbeat>
  <automation_id>{{AUTOMATION_ID}}</automation_id>
  <current_time_iso>{{NOW_ISO}}</current_time_iso>
  <instructions>
{{AUTOMATION_PROMPT}}
  </instructions>
</heartbeat>
```

### 3.2 关键参数

```typescript
interface AutomationConfig {
  // Heartbeat 配置（从 main.js 偏移 25683 处提取）
  heartbeatInterval: 30000;    // 30s (sn)
  maxRetries: 3;               // 3 (cn)
  timeout: 120000;             // 2 min (ln)
  shortTimeout: 60000;         // 1 min (un)
  warningTimeout: 30000;       // 30s (dn)
  globalTimeout: 600000;       // 10 min (fn)

  // 模型配置
  defaultModel: string;        // (pn.model)
  defaultReasoningEffort: string; // (pn.reasoningEffort)
}

// 事件类型
type AutomationEventType =
  | "response_item"   // 正常响应
  | "event_msg"       // 事件消息
  | "item"            // 数据项
  | "unknown";        // 未知
```

### 3.3 调度系统

```typescript
// 计算下次运行时间
function getNextRunAt({ automation, now }) {
  const rrule = parseRRule(automation.rrule);
  if (rrule == null) {
    return getEstimatedNextRunAt({ automation, now });  // 无规则, 立即
  }
  return now + rrule;  // 基于 RRule 的间隔
}

// 计算上次有效时间
function getLastRelevantTime({ lastRunAt, threadUpdatedAt }) {
  const times = [lastRunAt, threadUpdatedAt].filter(
    t => t != null && Number.isFinite(t)
  );
  return times.length === 0 ? null : Math.max(...times);
}
```

### 3.4 Memory 持久化流程

```
Automation 触发
  │
  ├── 1. 读取 $CODEX_HOME/automations/<id>/memory.md
  │      └── Agent 从中了解上次做了什么、当前状态
  │
  ├── 2. 构建 Heartbeat XML
  │      └── 注入 automation_id + current_time + instructions
  │
  ├── 3. Agent 执行任务
  │      └── 按 System Prompt 中的 Remark-Directive 规范
  │
  ├── 4. Agent 更新 memory.md（写回摘要）
  │      └── "Before returning the directive, write a concise
  │           summary of what you did/decided plus the current run time"
  │
  └── 5. Agent 输出 ::inbox-item{title="..." summary="..."}
         └── Codex 客户端解析并展示在 Inbox 中
```

---

## 4. Thread-Follower 系统

### 4.1 请求类型（15 个）

这是 Goal 模式下用户与 Agent 交互的 RPC 层：

```typescript
// 完整的 Thread-Follower 请求类型
enum ThreadFollowerRequestType {
  // === 基础控制 ===
  StartTurn       = "thread-follower-start-turn",
  CompactThread   = "thread-follower-compact-thread",

  // === Steer 机制 ===
  SteerTurn       = "thread-follower-steer-turn",
  // → 向正在执行的 Agent 注入方向性指导
  // → 不中断当前执行，而是"引导"其方向
  // → 对应 UI 中的 "Steer" 按钮

  InterruptTurn   = "thread-follower-interrupt-turn",
  // → 中断当前 Agent 执行
  // → 对应 UI 中的 "Stop" 按钮

  // === 模型和推理 ===
  SetModelAndReasoning = "thread-follower-set-model-and-reasoning",
  // → 动态切换模型和推理力度

  // === 协作模式 ===
  SetCollaborationMode = "thread-follower-set-collaboration-mode",
  // → 切换人机协作模式（如 Agent 自主度）

  // === 编辑控制 ===
  EditLastUserTurn = "thread-follower-edit-last-user-turn",
  // → 编辑上一轮用户消息

  // === 审批决策 ===
  CommandApprovalDecision  = "thread-follower-command-approval-decision",
  FileApprovalDecision     = "thread-follower-file-approval-decision",
  PermissionsRequestApprovalResponse =
    "thread-follower-permissions-request-approval-response",

  // === 用户输入 ===
  SubmitUserInput           = "thread-follower-submit-user-input",
  SubmitMcpServerElicitationResponse =
    "thread-follower-submit-mcp-server-elicitation-response",

  // === 队列管理 ===
  SetQueuedFollowUpsState   = "thread-follower-set-queued-follow-ups-state",
}
```

### 4.2 Steer vs Send 的区别

```
普通 Send:
  用户输入 → 作为新的 user message → Agent 产生 response

Steer (thread-follower-steer-turn):
  Agent 正在执行 Goal 的中途
  用户输入 → 不作为新消息，而是"方向修正"
  → Agent 收到 steer 指令，调整当前执行的优先级/方向
  → 但不重启整个对话上下文
```

### 4.3 请求路由

```typescript
// 主进程中的 Thread-Follower 请求处理器
class ThreadFollowerMessageHandler {
  // 请求队列（每个类型一个 pending map）
  pendingStartTurnRequests: Map<string, PendingRequest>;
  pendingCompactThreadRequests: Map<string, PendingRequest>;
  pendingSteerTurnRequests: Map<string, PendingRequest>;
  pendingInterruptTurnRequests: Map<string, PendingRequest>;
  pendingSetModelAndReasoningRequests: Map<string, PendingRequest>;
  pendingSetCollaborationModeRequests: Map<string, PendingRequest>;
  pendingEditLastUserTurnRequests: Map<string, PendingRequest>;
  pendingCommandApprovalDecisionRequests: Map<string, PendingRequest>;
  pendingFileApprovalDecisionRequests: Map<string, PendingRequest>;

  // 统一的请求转发
  async forwardThreadFollowerRequest(
    origin: WebContents,
    request: ThreadFollowerRequest,
    pendingMap: Map<string, PendingRequest>,
    timeoutEventName: string
  ): Promise<ThreadFollowerResponse> {
    // 1. 分配 requestId
    // 2. 加入 pendingMap + 设置超时
    // 3. 转发到 Server
    // 4. 等待响应或超时
    // 5. 清理 pendingMap
  }

  // 响应处理
  handleThreadFollowerSteerTurnResponse(origin, response) {
    // 验证 requestId → 清理 pending → resolve/reject
  }
}
```

---

## 5. 协作模式 (Collaboration Mode)

从 i18n 和代码中还原的 Agent 权限级别：

```typescript
// composer.permissionsDropdown
type AgentPermissionMode =
  | "default"      // 默认权限 — 需要用户审批高风险操作
  | "fullAccess"   // 完全访问 — Codex 有计算机的完全访问权（高风险）
  | "custom";      // 自定义 — 通过 config.toml 配置

interface PermissionsConfig {
  mode: AgentPermissionMode;
  // custom 模式下从 config.toml 读取:
  //   [permissions]
  //   allow_command = [...]
  //   allow_file_write = [...]
  //   deny_command = [...]
  //   ...
}

// 权限描述（从 i18n 还原）:
// "default" → "默认权限"
// "fullAccess" → "Codex 有计算机的完全访问权（高风险）"
// "custom" → "Codex 使用 config.toml 中定义的权限"
```

---

## 6. Multi-Agent / Sub-Agent

Goal 模式下支持创建子 Agent 处理子任务：

```typescript
// composer.multiAgentBanner
interface MultiAgentBanner {
  title: string;          // 标题
  body: string;           // "Create a sub-agent to explore this repository"
  cta: { primary: string }; // CTA 按钮文字
  dismissLabel: string;   // 关闭按钮
}

// Goal 执行时，Agent 可将复杂任务拆分为子 Agent:
// 1. Plan 生成 → 识别独立子任务
// 2. 对每个子任务创建一个 sub-agent thread
// 3. Sub-agent 在自己的对话上下文中执行
// 4. Main agent 收集子结果并整合
```

---

## 7. Plan 系统

```typescript
// codex.plan — Goal 执行计划（从 i18n 还原）
interface AgentPlan {
  steps: PlanStep[];
  // "Step {index}." — codex.plan.stepIndexPrefix
  // "{completed} of {total} tasks completed" — codex.plan.tasksCompletedSummary
}

interface PlanStep {
  index: number;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  result?: string;
  subAgentThreadId?: string;  // 如果是 sub-agent 执行的
}

// Plan 的渲染行为:
// - 可折叠/展开: "Collapse goal details" / "Expand goal details"
// - 实时更新步骤状态
// - 显示完成进度
```

---

## 8. Goal Agent 完整工作流

```
┌── Goal 设定阶段 ─────────────────────────────────────────────┐
│                                                              │
│ 1. 用户: /goal "为这个项目写完整的单元测试，覆盖率到 80%"        │
│ 2. 客户端: thread/goal:update → Server                        │
│ 3. Server: 存储 goal + 广播 thread/goal/updated               │
│ 4. Agent 收到 System Prompt（含 goal 描述 + Remark-Directive   │
│    模板 + Automation memory 指令）                             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌── Plan 生成阶段 ─────────────────────────────────────────────┐
│                                                              │
│ 5. Agent: 分析项目结构，生成 Plan                              │
│    - Step 1: 分析现有测试覆盖率                                │
│    - Step 2: 为核心模块编写测试                                │
│    - Step 3: 为边缘情况编写测试                                │
│    - Step 4: 运行测试并修复失败                                │
│    - Step 5: 验证覆盖率达标                                   │
│ 6. Plan 渲染为可折叠的步骤列表                                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌── 执行阶段 ──────────────────────────────────────────────────┐
│                                                              │
│ 7. Agent 开始执行 Step 1（分析测试覆盖率）                      │
│    → 运行 coverage tool，读取报告                             │
│    → 提交按钮显示 "Stop"（可中断）                             │
│                                                              │
│ 8. Agent 执行 Step 2（写测试）                                 │
│    → Agent 中途方向偏离，用户点击 "Steer"                      │
│    → 客户端发送 thread-follower-steer-turn                    │
│    → "请优先写 src/core/ 下的测试"                             │
│    → Agent 收到 steer，调整优先级但不重启                      │
│                                                              │
│ 9. 对话太长 → Agent 或用户触发 compact-thread                  │
│    → 压缩上下文，保留关键信息                                  │
│                                                              │
│ 10. Agent 完成所有步骤 → goal status = "complete"              │
│     → 更新 memory.md（如有 automation）                        │
│     → 输出 ::inbox-item{title="Unit test coverage at 82%"     │
│          summary="Review test quality; focus on edge cases"}  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌── 后台模式 ──────────────────────────────────────────────────┐
│                                                              │
│ 如果配置了 Automation:                                        │
│ - 不使用 Steer 按钮（无用户交互）                              │
│ - 通过 Heartbeat XML 定时触发                                 │
│ - 依赖 memory.md 记忆上次执行状态                             │
│ - 自动输出 inbox-item 通知用户结果                             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 9. 安全分析

### 9.1 System Prompt 注入

Agent 收到模板中的 `{{AUTOMATION_PROMPT}}` 占位符会被用户的 Goal 描述替换。如果 Goal 中包含 prompt injection，可能覆盖 System Prompt 中的安全约束。

### 9.2 Memory.md 持久化攻击

```
$CODEX_HOME/automations/<id>/memory.md
  → Agent 可读写
  → 恶意 Goal 可写入持久化指令
  → 下次 Automation 运行时，Agent 读取并执行
  → 跨会话的 prompt 投毒
```

### 9.3 Remark-Directive 解析

```
::inbox-item{title="..." summary="..."}
  → 解析器是否处理转义和边界情况?
  → 如果 Agent 输出了恶意的 directive 格式，客户端如何渲染?
```

### 9.4 Thread-Follower 超时

```
每个 Thread-Follower 请求有独立的超时时间:
  steer-turn-timeout: ???
  interrupt-turn-timeout: ???
  set-collaboration-mode-timeout: ???
  → 超时后如何处理? 是否安全回退?
```

### 9.5 Sub-Agent 隔离

```
Sub-agent 在独立 thread 中执行
  → 是否有权限隔离?
  → 是否可以访问主 Agent 的 memory 和文件?
  → 是否有 rate limiting 防止 sub-agent 失控?
```
