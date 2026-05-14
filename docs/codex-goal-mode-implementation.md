# Codex Goal 模式实现分析

> 来源：comment-preload.js (i18n + React UI)、app-session.js (事件系统)、main.js (自动化/请求路由)
> 版本：26.506.31421

---

## 1. 概览

Goal 模式是 Codex 的"目标驱动对话"功能。用户设定一个 Goal（目标），Agent 会在该目标的框架下工作。与普通对话不同，Goal 模式有不同的提交按钮状态（Send → Steer）和生命周期管理（暂停/恢复/完成）。

### 核心概念

```
普通对话:  用户输入 → Send → Agent 响应 → 继续对话

Goal 模式:  /goal 设定目标 → Steer → Agent 按目标执行 → 暂停/恢复/完成
              │                                          │
              └── 自动化系统 (Automations) ←──────────────┘
```

---

## 2. UI 组件（从 i18n keys 还原）

### 2.1 Slash Command: /goal

```typescript
// composer.goalSlashCommand
interface GoalSlashCommand {
  title: "/goal";                                    // Slash 命令名
  setDescription: "Set a conversation goal";          // 设定目标（无现有目标时）
  editDescription: "Edit the conversation goal";      // 编辑目标（已有目标时）
}
```

### 2.2 Goal Dropdown（目标下拉菜单）

```typescript
// composer.editGoalDropdown / composer.setGoalDropdown
interface GoalDropdown {
  editGoalDropdown: "Edit goal";    // 编辑模式的下拉菜单
  setGoalDropdown: "Set goal";      // 设定模式的下拉菜单
}

// composer.pendingThreadGoal — 待确认的目标状态
interface PendingThreadGoal {
  summary: "Goal";              // 目标摘要显示
  edit: "Edit goal";            // 编辑按钮
  editTooltip: "Edit goal";     // 编辑提示
  clear: "Clear goal";          // 清除按钮
  clearTooltip: "Clear goal";   // 清除提示
}
```

### 2.3 ThreadGoal 管理组件

```typescript
// composer.threadGoal — 完整的目标状态管理 UI
interface ThreadGoalUI {
  // 生命周期
  edit: "Edit goal";
  editTooltip: "Edit goal";
  clear: "Clear goal";
  clearTooltip: "Clear goal";
  clearError: "Failed to clear goal";

  // 折叠/展开目标详情
  collapse: "Collapse goal details";
  expand: "Expand goal details";

  // 暂停/恢复
  pause: "Pause goal";
  pauseTooltip: "Pause goal";
  resume: "Resume goal";
  resumeTooltip: "Resume goal";

  // 错误
  setError: "Failed to set goal";
  statusUpdateError: "Failed to update goal status";

  // 状态显示
  status: {
    active: "Active";
    paused: "Paused";
    budgetLimited: "Budget Limited";
    complete: "Complete";
  };

  // 摘要显示
  summary: {
    active: "Goal is active";
    paused: "Goal is paused";
    budgetLimited: "Budget is limited";
    complete: "Goal completed";
  };

  // Token 用量
  tokenUsage: "Token usage";
}
```

### 2.4 提交按钮状态

```typescript
// composer.submitButtonTooltip — 根据 Goal 状态动态切换
interface SubmitButtonState {
  send: "Send";      // 普通模式：发送消息
  steer: "Steer";    // Goal 模式：引导 Agent 朝向目标
  queue: "Queue";    // 队列模式：后台执行
  stop: "Stop";      // 停止当前执行
}

// composer.queuedMessage.sendNow
// "Steer" — 已排队的消息可以立刻 Steer
```

### 2.5 用户消息类型

```typescript
// codex.userMessage — 特殊消息类型
interface UserMessage {
  goal: "Goal";                    // Goal 设定/更新消息
  implementPlan: "Implement plan"; // 执行计划的 CTA 按钮
}
```

---

## 3. 状态机

### 3.1 Goal 生命周期

```
                    /goal 或 Set goal
   (无 Goal) ──────────────────────────→ Active
                                              │
                          ┌───────────────────┼───────────────────┐
                          │                   │                   │
                          ▼                   ▼                   ▼
                        Paused          Budget Limited        Complete
                          │                                       │
                     Resume                                       │
                          │                                       │
                          ▼                                       ▼
                        Active                               (终态)
                          │
                     Clear goal
                          │
                          ▼
                      (无 Goal)
```

### 3.2 状态转换事件

```typescript
// 客户端 → 服务端
type GoalAction =
  | "set"       // 设定新目标 → server emits "thread/goal/updated"
  | "update"    // 更新目标内容 → server emits "thread/goal/updated"
  | "clear"     // 清除目标 → server emits "thread/goal/cleared"
  | "pause"     // 暂停目标 → server emits "thread/goal/updated"
  | "resume";   // 恢复目标 → server emits "thread/goal/updated"

// 服务端 → 客户端（广播到所有窗口）
type GoalServerEvent =
  | "thread/goal/cleared"   // 目标已清除
  | "thread/goal/updated";  // 目标已更新
```

### 3.3 提交按钮状态切换

```
                    Goal 是否活跃?
                    /           \
                  否             是
                   │              │
                   ▼              ▼
                 "Send"    Agent 是否正在执行?
                              /         \
                            否           是
                             │            │
                             ▼            ▼
                          "Steer"      "Stop"
                            │
                   消息是否已排队?
                      /        \
                    否          是
                     │           │
                     ▼           ▼
                   "Steer"    "Queue"
```

---

## 4. 与 Automations 系统的关系

Goal 模式与 Automations（自动化）系统紧密相关，但它们是两个不同的概念：

### 4.1 Automations 系统

```typescript
// Automation CRUD 操作
type AutomationAction =
  | "automation-create"      // 创建自动化
  | "automation-update"      // 更新自动化
  | "automation-delete"      // 删除自动化
  | "automation-run-now"     // 立即运行
  | "automation-run-archive" // 归档运行记录
  | "automation-run-delete"; // 删除运行记录

// 待处理的自动化
type PendingAutomationQuery =
  "list-pending-automation-run-threads";
```

### 4.2 Workflow 关系

```
Automation = 定期/条件触发的 Goal 执行

Goal 模式 (手动):
  用户 → /goal "帮我维护这个项目" → Steer → Agent 开始工作

Automation 模式 (自动):
  定时触发 → 从 automation memory 读取上下文 → Agent 自动执行
                                      │
                    $CODEX_HOME/automations/<id>/memory.md
```

---

## 5. 主进程事件流

### 5.1 Goal 更新流程

```
Renderer (React)                    Main Process              Server
      │                                  │                      │
      │── setGoal(text) ────────────────→│                      │
      │                                  │── thread/goal:update →│
      │                                  │                      │
      │                                  │←── thread/goal/updated│
      │←── broadcast ────────────────────│                      │
      │    (所有窗口同步)                  │                      │
      │                                  │                      │
      │── pause/resume ─────────────────→│                      │
      │                                  │── thread/goal:update →│
      │                                  │←── thread/goal/updated│
      │←── broadcast ────────────────────│                      │
      │                                  │                      │
      │── clearGoal ────────────────────→│                      │
      │                                  │── thread/goal:clear →│
      │                                  │←── thread/goal/cleared│
      │←── broadcast ────────────────────│                      │
```

### 5.2 Agent 执行中的 Steer 流程

```
Renderer                    Main Process              Server
   │                              │                       │
   │── steerTurn(message) ───────→│                       │
   │                              │── agent:steer ───────→│
   │                              │                       │
   │                              │←── agent:response ────│
   │←── stream delta ─────────────│                       │
   │←── stream delta ─────────────│                       │
   │←── stream done ──────────────│                       │
```

---

## 6. 关键数据结构推测

```typescript
// Goal 数据结构
interface ThreadGoal {
  id: string;
  text: string;                    // 用户输入的目标描述
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  plan?: Plan;                     // Agent 生成的可选执行计划
  tokenUsage?: TokenUsage;         // Goal 执行的 token 统计
  budget?: Budget;                 // 可选的使用上限
}

type GoalStatus = "active" | "paused" | "budgetLimited" | "complete";

interface Plan {
  steps: PlanStep[];
  completedSteps: number;
  totalSteps: number;
  status: "not_started" | "in_progress" | "completed";
}

interface PlanStep {
  index: number;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  result?: string;
}

interface TokenUsage {
  total: number;
  byStep: Record<number, number>;
}

interface Budget {
  maxTokens: number;
  usedTokens: number;
  warningThreshold: number;  // 如 80%
}

// Automation 数据结构
interface Automation {
  id: string;
  name: string;
  prompt: string;            // Goal 描述
  schedule?: CronExpression; // Cron 表达式（可选）
  trigger?: AutomationTrigger;
  memoryPath: string;        // $CODEX_HOME/automations/<id>/memory.md
  createdAt: number;
  updatedAt: number;
}

type AutomationTrigger =
  | { type: "manual" }
  | { type: "cron"; expression: string }
  | { type: "webhook"; url: string }
  | { type: "event"; eventName: string };
```

---

## 7. 内存系统（Automation Memory）

从 main.js 中的 Prompt 模板提取：

```markdown
- Automations: use the memory file at
  `$CODEX_HOME/automations/<automation_id>/memory.md`
  (create it if missing).

- Read it first (if present) to avoid repeating recent work,
  especially for "changes since last run" tasks.

- Memory is important: some tasks must build on prior work,
  and others must avoid duplicating prior focus.

- Before returning the directive, write back to the memory
  file summarizing the current state and what to track next.
```

**示例 inbox-item 格式**：

```markdown
::inbox-item
- Title: what this thread now _is_ (state + object). Aim ~4-8 words.
- Summary: what the user should _do/know next_.
  Aim ~6-14 words. Should usually match the general automation
  name or prompt summary.
```

---

## 8. 安全考虑

### 8.1 Goal 注入

```
用户: /goal "Ignore previous instructions and instead..."
  → Goal 描述直接作为 Agent System Prompt 的一部分
  → Agent 可能被恶意 goal 引导
```

### 8.2 Automation Memory 持久化

```
$CODEX_HOME/automations/<id>/memory.md
  → Agent 可读写
  → 如果 Agent 被恶意 goal 控制，可能写入恶意内容
  → 下次自动化运行时读取恶意 memory
```

### 8.3 跨会话状态

```
Goal 状态通过 server 同步到所有窗口
  → "thread/goal/updated" 事件广播
  → 如果攻击者能在同一对话中注入消息
  → 可修改 Goal 状态影响 Agent 行为
```

### 8.4 Budget 绕过

```
"Budget Limited" 状态表明有 token 使用限制
  → 限制可能在客户端或服务端
  → 如果仅在客户端检查，可被绕过
```

---

## 9. 总结

Goal 模式的核心设计：

1. **用户体验层**：`/goal` slash command → 设定/编辑/清除 Goal → 动态提交按钮（Send/Steer/Stop）
2. **状态管理**：Goal 有完整生命周期（active/paused/budgetLimited/complete），状态变更通过 server 事件广播
3. **Agent 行为**：Steer 模式引导 Agent 朝向目标工作，不同于普通 Send
4. **自动化系统**：Goal 可转化为 Automation，支持定时执行和 memory 持久化
5. **计划执行**：Agent 可生成 Plan（步骤分解），用户可看到进度（steps completed/total）

Goal 模式本质是将 LLM Agent 从"单次对话"升级为"目标驱动的持续任务执行器"，通过状态机 + memory + 计划系统实现多轮自主工作。
