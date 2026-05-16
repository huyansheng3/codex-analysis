// ============================================================
// Codex IPC 通道定义 — 从 main.js / preload.js 逆向重建
// 全部 40+ 通道及其调用模式
// ============================================================

// --- codex_desktop:* 通道 (16 个) ---

/** 通用消息: 渲染进程 → 主进程 (invoke) */
const MSG_FROM_VIEW = "codex_desktop:message-from-view";

/** 通用消息: 主进程 → 渲染进程 (on) */
const MSG_FOR_VIEW = "codex_desktop:message-for-view";

/** 浏览器侧边栏运行时消息 (invoke) */
const BROWSER_SIDEBAR_RUNTIME = "codex_desktop:browser-sidebar-runtime-message";

/** MCP App 沙箱客户消息 (postMessage) */
const MCP_SANDBOX_GUEST = "codex_desktop:mcp-app-sandbox-guest-message";

/** MCP App 沙箱宿主消息 (postMessage) */
const MCP_SANDBOX_HOST = "codex_desktop:mcp-app-sandbox-host-message";

/** 显示原生上下文菜单 (invoke) */
const SHOW_CONTEXT_MENU = "codex_desktop:show-context-menu";

/** 显示应用菜单栏下拉 (invoke) */
const SHOW_APPLICATION_MENU = "codex_desktop:show-application-menu";

/** 获取 Sentry 配置 (sendSync) */
const GET_SENTRY_INIT_OPTIONS = "codex_desktop:get-sentry-init-options";

/** 获取构建类型 (sendSync) */
const GET_BUILD_FLAVOR = "codex_desktop:get-build-flavor";

/** 获取系统主题 (sendSync) */
const GET_SYSTEM_THEME_VARIANT = "codex_desktop:get-system-theme-variant";

/** 获取共享状态快照 (sendSync) */
const GET_SHARED_OBJECT_SNAPSHOT = "codex_desktop:get-shared-object-snapshot";

/** 获取 Fast Mode rollout 指标 (invoke) */
const GET_FAST_MODE_ROLLOUT_METRICS = "codex_desktop:get-fast-mode-rollout-metrics";

/** 系统主题变化通知 (on, 主→渲染广播) */
const SYSTEM_THEME_VARIANT_UPDATED = "codex_desktop:system-theme-variant-updated";

/** 触发 Sentry 测试错误 (invoke) */
const TRIGGER_SENTRY_TEST = "codex_desktop:trigger-sentry-test";

/**
 * Worker 消息: 渲染 → Worker (invoke)
 * 模式: `codex_desktop:worker:${workerName}:from-view`
 */
function workerFromView(workerName: string): string {
  return `codex_desktop:worker:${workerName}:from-view`;
}

/**
 * Worker 消息: Worker → 渲染 (on)
 * 模式: `codex_desktop:worker:${workerName}:for-view`
 */
function workerForView(workerName: string): string {
  return `codex_desktop:worker:${workerName}:for-view`;
}

// --- Settings 持久化通道 (sendSync + returnValue, ~40 个) ---

const SettingsChannels = {
  // 窗口状态
  MAIN_WINDOW_BOUNDS: "electron-main-window-bounds",

  // Agent 配置
  AGENTS_MD: "codex-agents-md",
  AGENTS_MD_SAVE: "codex-agents-md-save",
  COMMAND_KEYMAP_STATE: "codex-command-keymap-state",

  // 路径和凭据 ⚠️ 安全敏感
  CODE_HOME: "codex-home",
  OPENAI_API_KEY: "openai-api-key",                  // ⚠️ 明文 API Key
  CLIENT_SESSION_TOKEN: "x-codex-client-session-token", // ⚠️ Session Token

  // OAuth
  OAUTH_CALLBACK_URL: "app-connect-oauth-callback-url",

  // Browser Use
  BROWSER_APPROVAL_MODE_WRITE: "browser-use-approval-mode-write",
  BROWSER_ORIGIN_STATE_READ: "browser-use-origin-state-read",

  // Computer Use
  CU_APP_APPROVAL_REMOVE: "computer-use-app-approval-remove",
  CU_APP_APPROVALS_READ: "computer-use-app-approvals-read",
  CU_APP_APPROVALS_VISIBILITY: "computer-use-app-approvals-visibility",
  CU_SOUND_MODE_READ: "computer-use-sound-mode-read",
  CU_SOUND_MODE_WRITE: "computer-use-sound-mode-write",

  // Dictation
  DICTATION_CAPTURE_FN_HOTKEY: "global-dictation-capture-fn-hotkey",
  DICTATION_COPY_HISTORY_ITEM: "global-dictation-copy-history-item",
  DICTATION_FORCE_LOCK_CHANGED: "global-dictation-force-lock-changed",
  DICTATION_IN_APP_STARTED: "global-dictation-in-app-started",
  DICTATION_RECORD_HISTORY_ITEM: "global-dictation-record-history-item",
  DICTATION_SET_TOGGLE_HOTKEY: "global-dictation-set-toggle-hotkey",

  // Remote Control
  REMOTE_AUTO_CONNECT: "set-remote-connection-auto-connect",
  REMOTE_CONTROL_ENABLED: "set-remote-control-connections-enabled",

  // Thread/Agent 协作
  FOLLOWER_COMMAND_APPROVAL: "thread-follower-command-approval-decision",
  FOLLOWER_FILE_APPROVAL: "thread-follower-file-approval-decision",
  FOLLOWER_SET_COLLABORATION_MODE: "thread-follower-set-collaboration-mode",
  FOLLOWER_SUBMIT_USER_INPUT: "thread-follower-submit-user-input",
  LIST_PENDING_AUTOMATION_RUN_THREADS: "list-pending-automation-run-threads",

  // 其他
  GENERATE_COMMIT_PR_MESSAGE: "generate-commit-pull-request-message",
  COPILOT_API_PROXY_INFO: "get-copilot-api-proxy-info",
  NODE_REPL_ACTIVE_EXECS_KILL: "node-repl-active-execs-kill",
  PRIMARY_RUNTIME_UPDATE_RUN_NOW: "primary-runtime-update-run-now",
  WINDOW_CONTEXT_HOTKEY_STATE: "native-window-context-hotkey-state",
  WINDOW_CONTEXT_SET_HOTKEY: "native-window-context-set-hotkey",
  HOTKEY_WINDOW_COLLAPSE_TO_HOME: "hotkey-window-collapse-to-home",
} as const;

// --- browser-sidebar-* 通道 ---

const BrowserSidebarChannels = {
  // 编辑器生命周期
  OPEN_EDITOR: "browser-sidebar-runtime-open-editor",
  CLOSE_EDITOR: "browser-sidebar-runtime-close-editor",
  RESTORE_EDITOR: "browser-sidebar-runtime-restore-editor",
  FOCUS_EDITOR: "browser-sidebar-runtime-focus-editor",

  // 评论操作
  CREATE_COMMENT_AT_POINT: "browser-sidebar-runtime-create-comment-at-point",
  SELECT_COMMENT: "browser-sidebar-runtime-select-comment",
  UPDATE_ANCHOR: "browser-sidebar-runtime-update-anchor",
  EXIT_COMMENT_MODE: "browser-sidebar-runtime-exit-comment-mode",

  // 截图
  PREPARE_SCREENSHOT: "browser-sidebar-runtime-prepare-comment-screenshot",
  SCREENSHOT_READY: "browser-sidebar-runtime-comment-screenshot-ready",
  CLEAR_SCREENSHOT: "browser-sidebar-runtime-clear-comment-screenshot",

  // 预览叠加层
  OPEN_COMMENT_PREVIEW: "browser-sidebar-runtime-open-comment-preview",
  CLOSE_COMMENT_PREVIEW: "browser-sidebar-runtime-close-comment-preview",

  // 状态同步
  RUNTIME_SYNC: "browser-sidebar-runtime-sync",
  SYNC: "browser-sidebar-sync",
  OWNER_SYNC: "browser-sidebar-owner-sync",
  STATE: "browser-sidebar-state",

  // 命令和查找
  COMMAND: "browser-sidebar-command",
  FIND_STATE: "browser-sidebar-find-state",
  MANAGER: "browser-sidebar-manager",

  // URL 加载
  LOAD_URL: "browser-sidebar-load-url",
  LOAD_ERROR_PAGE: "browser-sidebar-load-error-page",

  // 本地服务器
  LOCAL_SERVERS: "browser-sidebar-local-servers",

  // 使用和滚动
  USAGE: "browser-sidebar-usage",
  SCROLL: "browser-sidebar-scroll",

  // 评论叠加层
  COMMENT_OVERLAY_SESSION: "browser-sidebar-comment-overlay-session",
  COMMENT_OVERLAY_SUBMIT: "browser-sidebar-comment-overlay-submit",
  COMMENT_OVERLAY_DELETE: "browser-sidebar-comment-overlay-delete",
  COMMENT_OVERLAY_PREPARE: "browser-sidebar-comment-overlay-prepare",
  COMMENT_OVERLAY_MOUNTED: "browser-sidebar-comment-overlay-mounted",
  COMMENT_OVERLAY_CLOSE: "browser-sidebar-comment-overlay-close",
  COMMENT_OVERLAY_PREVIEW_OPEN_CHANGED: "browser-sidebar-comment-overlay-preview-open-changed",
  COMMENT_OVERLAY_ANOMALY: "browser-sidebar-comment-overlay-anomaly",

  // Browser Use
  BROWSER_USE_VIEWPORT: "browser-sidebar-browser-use-viewport",
  BROWSER_USE_CAPTURE_SURFACE: "browser-sidebar-browser-use-capture-surface",
  BROWSER_USE_STATE: "browser-sidebar-browser-use-state",
  BROWSER_USE_CURSOR_STATE: "browser-sidebar-browser-use-cursor-state",

  // 其他
  OPEN_PANEL_WITHOUT_ANIMATION: "browser-sidebar-open-panel-without-animation",
  CLEAR_PENDING_PANEL_OPEN: "browser-sidebar-clear-pending-panel-open",
  PRELOAD_ERROR: "browser-sidebar-preload-error",
  SCREENSHOT: "browser-sidebar-screenshot",
  SCREENSHOT_COPIED: "browser-sidebar-screenshot-copied",
  SCREENSHOT_COPY_FAILED: "browser-sidebar-screenshot-copy-failed",
  MOUSE_NAVIGATION: "browser-sidebar-runtime-mouse-navigation",
  COMMENT_MODE_SITE_STATUS: "browser-sidebar-comment-mode-site-status",
  DIRECT_COMMENT: "browser-sidebar-direct-comment",
  COMMENT_SCREENSHOT: "browser-sidebar-comment-screenshot",
  COMMENT_CONTROLLER: "browser-sidebar-comment-controller",
} as const;

export {
  MSG_FROM_VIEW,
  MSG_FOR_VIEW,
  BROWSER_SIDEBAR_RUNTIME,
  MCP_SANDBOX_GUEST,
  MCP_SANDBOX_HOST,
  SHOW_CONTEXT_MENU,
  SHOW_APPLICATION_MENU,
  GET_SENTRY_INIT_OPTIONS,
  GET_BUILD_FLAVOR,
  GET_SYSTEM_THEME_VARIANT,
  GET_SHARED_OBJECT_SNAPSHOT,
  GET_FAST_MODE_ROLLOUT_METRICS,
  SYSTEM_THEME_VARIANT_UPDATED,
  TRIGGER_SENTRY_TEST,
  workerFromView,
  workerForView,
  SettingsChannels,
  BrowserSidebarChannels,
};
