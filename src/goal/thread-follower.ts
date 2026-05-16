// ============================================================
// Thread-Follower 系统 — 从 main.js 逆向重建
// Goal 模式下用户与 Agent 交互的 15 个 RPC 请求类型
// ============================================================

/**
 * Thread-Follower 请求类型枚举
 *
 * 这些是 Goal 模式下用户通过 Steer/Stop 按钮等操作
 * 触发的 Agent 控制请求。每个请求通过主进程转发到 Server
 * 并等待响应，超时时间各请求独立。
 */
enum ThreadFollowerRequestType {
  // === 基础生命周期 ===

  /** 启动一个新的 Agent turn */
  StartTurn = "thread-follower-start-turn",

  /** 压缩/精简对话上下文（长对话管理） */
  CompactThread = "thread-follower-compact-thread",

  // === Steer 机制 ===

  /**
   * 向正在执行的 Agent 注入方向修正
   * 核心差异: 不是新增 user message，而是修改当前执行的优先级/方向
   * → UI 对应 "Steer" 按钮
   */
  SteerTurn = "thread-follower-steer-turn",

  /**
   * 中断当前 Agent 执行
   * → UI 对应 "Stop" 按钮
   */
  InterruptTurn = "thread-follower-interrupt-turn",

  // === 模型控制 ===

  /** 动态切换 LLM 模型和推理力度 */
  SetModelAndReasoning = "thread-follower-set-model-and-reasoning",

  // === 协作模式 ===

  /**
   * 切换人机协作模式
   * 影响 Agent 的自主度: 何时需要用户审批、何时自主执行
   */
  SetCollaborationMode = "thread-follower-set-collaboration-mode",

  // === 编辑控制 ===

  /** 编辑上一轮用户消息（修正错误的输入） */
  EditLastUserTurn = "thread-follower-edit-last-user-turn",

  // === 审批决策 ===

  /** 用户对 Agent 的命令执行请求做出审批决定 */
  CommandApprovalDecision = "thread-follower-command-approval-decision",

  /** 用户对 Agent 的文件操作请求做出审批决定 */
  FileApprovalDecision = "thread-follower-file-approval-decision",

  /** 用户对 Agent 的权限请求做出响应 */
  PermissionsRequestApprovalResponse =
    "thread-follower-permissions-request-approval-response",

  // === 用户输入 ===

  /** 提交用户输入（从 Follower 窗口） */
  SubmitUserInput = "thread-follower-submit-user-input",

  /** 提交 MCP Server 引导响应 */
  SubmitMcpServerElicitationResponse =
    "thread-follower-submit-mcp-server-elicitation-response",

  // === 队列管理 ===

  /** 设置排队的 Follow-up 状态 */
  SetQueuedFollowUpsState = "thread-follower-set-queued-follow-ups-state",
}

// --- 请求数据结构 ---

interface ThreadFollowerRequest {
  requestId: string;
  type: ThreadFollowerRequestType;
  [key: string]: unknown;
}

interface ThreadFollowerResponse {
  requestId: string;
  result?: unknown;
  error?: string;
}

// --- 主进程请求处理器 ---

/**
 * 主进程中的请求队列管理
 * 每种请求类型有独立的 pending map，防止消息混淆
 */
class ThreadFollowerMessageHandler {
  pendingStartTurnRequests = new Map<string, PendingRequest>();
  pendingCompactThreadRequests = new Map<string, PendingRequest>();
  pendingSteerTurnRequests = new Map<string, PendingRequest>();
  pendingInterruptTurnRequests = new Map<string, PendingRequest>();
  pendingSetModelAndReasoningRequests = new Map<string, PendingRequest>();
  pendingSetCollaborationModeRequests = new Map<string, PendingRequest>();
  pendingEditLastUserTurnRequests = new Map<string, PendingRequest>();
  pendingCommandApprovalDecisionRequests = new Map<string, PendingRequest>();
  pendingFileApprovalDecisionRequests = new Map<string, PendingRequest>();

  /**
   * 统一的请求转发流程:
   * 1. 分配 requestId (UUID)
   * 2. 加入对应类型的 pendingMap
   * 3. 设置超时定时器
   * 4. 转发到 Server (appServerConnection)
   * 5. 等待 Server 响应或超时
   * 6. 清理 pendingMap + clearTimeout
   */
  private async forwardThreadFollowerRequest(
    origin: { id: string },
    request: ThreadFollowerRequest,
    pendingMap: Map<string, PendingRequest>,
    timeoutEventName: string
  ): Promise<ThreadFollowerResponse> {
    const requestId = request.requestId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingMap.delete(requestId);
        reject(new Error(`${timeoutEventName}`));
      }, 30000); // 30s 默认超时

      pendingMap.set(requestId, {
        originId: origin.id,
        timeout,
        resolve,
        reject,
      });

      // 转发到 Server...
      // appServerConnection.send(request)
    });
  }

  // --- 各请求类型的专用 handler ---

  async handleThreadFollowerSteerTurnRequest(
    origin: { id: string },
    request: ThreadFollowerRequest
  ): Promise<ThreadFollowerResponse> {
    return this.forwardThreadFollowerRequest(
      origin,
      request,
      this.pendingSteerTurnRequests,
      "thread-follower-steer-turn-timeout"
    );
  }

  async handleThreadFollowerInterruptTurnRequest(
    origin: { id: string },
    request: ThreadFollowerRequest
  ): Promise<ThreadFollowerResponse> {
    return this.forwardThreadFollowerRequest(
      origin,
      request,
      this.pendingInterruptTurnRequests,
      "thread-follower-interrupt-turn-timeout"
    );
  }

  async handleThreadFollowerSetCollaborationModeRequest(
    origin: { id: string },
    request: ThreadFollowerRequest
  ): Promise<ThreadFollowerResponse> {
    return this.forwardThreadFollowerRequest(
      origin,
      request,
      this.pendingSetCollaborationModeRequests,
      "thread-follower-set-collaboration-mode-timeout"
    );
  }

  // --- 响应处理 ---

  /** 处理 Steer Turn 的 Server 响应 */
  handleThreadFollowerSteerTurnResponse(
    origin: { id: string },
    response: ThreadFollowerResponse
  ): void {
    const pending = this.pendingSteerTurnRequests.get(response.requestId);
    if (!pending || pending.originId !== origin.id) {
      // 未知的 requestId，可能是过期的响应
      return;
    }

    this.pendingSteerTurnRequests.delete(response.requestId);
    clearTimeout(pending.timeout);

    if (response.error) {
      pending.reject(new Error(response.error));
    } else if (!response.result) {
      pending.reject(new Error("Missing thread follower steer-turn response"));
    } else {
      pending.resolve(response.result);
    }
  }
}

// --- Pending Request ---

interface PendingRequest {
  originId: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

// --- 协作模式枚举 ---

type CollaborationMode =
  | "default"      // 默认: Agent 需要审批高风险操作
  | "fullAccess"   // 完全访问: Agent 可自主执行所有操作
  | "custom";      // 自定义: 通过 config.toml [permissions] 配置

// --- 权限配置 ---

interface PermissionsConfig {
  mode: CollaborationMode;
  // custom 模式下从 config.toml 读取的配置:
  allowCommand?: string[];
  allowFileWrite?: string[];
  denyCommand?: string[];
  denyFileWrite?: string[];
}

export {
  ThreadFollowerRequestType,
  ThreadFollowerMessageHandler,
  CollaborationMode,
};

export type {
  ThreadFollowerRequest,
  ThreadFollowerResponse,
  PendingRequest,
  PermissionsConfig,
};
