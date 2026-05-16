// ============================================================
// Computer Use 权限系统 — 从 SkyComputerUseClient 二进制 strings 逆向重建
// 包含 macOS TCC 权限 + Codex 应用级审批 + 密码管理器黑名单
// ============================================================

// --- macOS 系统权限 ---

/**
 * CUAServicePermissionState (Swift Observable)
 * 在 SkyComputerUseService 中管理
 */
interface PermissionState {
  /** Accessibility 权限是否已授予（AXIsProcessTrusted()） */
  isAccessibilityGranted: boolean;

  /** Screen Recording 权限是否已授予（CGPreflightScreenCaptureAccess()） */
  isScreenRecordingGranted: boolean;

  /** 是否有活跃的权限请求 */
  activePermissionRequest: boolean;

  /** 是否有正在进行的权限授予 */
  inProgressPermission: boolean;
}

// --- 权限引导窗口 ---

/**
 * CUAServicePermissionsWindow (SwiftUI)
 * 当新用户首次使用 Computer Use 时显示
 */
interface PermissionsWindow {
  title: "Enable Codex Computer Use";
  description:
    "Codex Computer Use needs these permissions to use apps on your Mac. " +
    "These permissions are only used when you ask Codex to perform tasks.";

  accessibilityRow: {
    title: "Accessibility";
    description: "Allows Codex to access app interfaces";
  };

  screenRecordingRow: {
    title: "Screen Recording";
    description: "Codex uses screenshots to know where to click";
  };

  /** "COMPLETE IN SYSTEM SETTINGS" 按钮 → 打开系统设置 */
  actionButton: "COMPLETE IN SYSTEM SETTINGS";
  // → 打开 com.apple.settings.PrivacySecurity.extension
}

// --- 应用审批（AppApprovalStore） ---

/**
 * 基于 SQLite 的应用审批存储
 * 文件路径: ~/Library/Application Support/Software/ComputerUseAppApprovals.json
 */
interface AppApprovalStore {
  /** 本次会话中已审批的 Bundle IDs */
  sessionApprovedBundleIdentifiers: Set<string>;

  /** 持久化审批列表 */
  persistentApprovals: Approval[];
  persistentApprovalsModificationDate: Date;

  /** 当前有效的所有已审批 Bundle IDs */
  approvedBundleIdentifiers: string[];
}

interface Approval {
  bundleId: string;
  approvedAt: number;          // timestamp
  persistence: ApprovalPersistence;
  expiry?: number;             // 过期时间（timed 模式）
}

type ApprovalPersistence =
  | "session"     // 仅本次会话
  | "forever"     // 永久
  | "timed";      // 有时限

// --- 策略提供者 ---

/**
 * CodexAppServerComputerUsePolicyProvider
 * 从 Codex AppServer 获取组织的安全策略
 */
interface ComputerUsePolicy {
  /** 允许的 Bundle IDs（白名单） */
  allowedBundleIds: string[];
  /** 禁止的 Bundle IDs（黑名单） */
  deniedBundleIds: string[];
  /** 是否允许持久化审批 */
  allowPersistentApproval: boolean;
  /** 不需要通知的审批方法 */
  optOutNotificationMethods: string[];

  /** 策略缓存有效期 */
  timeout: number;
  cachedAt?: Date;
}

// --- 审批流程 ---

/**
 * MCP elicitation（即时审批请求）
 * 当 Agent 首次使用某个应用时触发
 */
interface McpElicitationRequest {
  appName: string;
  bundleId: string;

  question: "Allow Codex to use {appName}?";
  warning:
    "Allowing Codex to use this app introduces new risks, " +
    "including those related to prompt injection attacks, " +
    "such as data theft or loss. Carefully monitor Codex " +
    "while it uses this app.";

  options: ApprovalOption[];
}

type ApprovalOption =
  | { type: "allow_once"; label: "Allow Once" }
  | { type: "allow_always"; label: "Always Allow" }
  | { type: "deny"; label: "Deny" };

// --- 密码管理器黑名单 ---

/**
 * 硬编码的密码管理器阻止列表
 * 这些应用绝对不允许被 Computer Use 使用
 */
const BLOCKED_PASSWORD_MANAGERS: string[] = [
  "com.1password.1password",          // 1Password
  "com.1password.safari",             // 1Password Safari 扩展
  "com.bitwarden.desktop",            // Bitwarden
  "com.dashlane.dashlanephonefinal",  // Dashlane
  "com.lastpass.LastPass",            // LastPass
  "me.proton.pass.electron",          // Proton Pass (Electron)
  "me.proton.pass.catalyst",          // Proton Pass (Catalyst)
  "com.nordsec.nordpass",             // NordPass
];

/**
 * 检查应用是否被安全策略阻止
 * 阻止时返回拒绝原因，否则返回 null
 */
function checkAppBlocked(bundleId: string, policy: ComputerUsePolicy): string | null {
  // 1. 密码管理器硬编码黑名单（最高优先级）
  if (BLOCKED_PASSWORD_MANAGERS.includes(bundleId)) {
    return `Computer Use is blocked from using the app '${bundleId}' by your organization's policy.`;
  }

  // 2. 组织策略黑名单
  if (policy.deniedBundleIds.includes(bundleId)) {
    return `Computer Use is blocked from using the app '${bundleId}' by your organization's policy.`;
  }

  // 3. 组织策略白名单（如果配置了）
  if (
    policy.allowedBundleIds.length > 0 &&
    !policy.allowedBundleIds.includes(bundleId)
  ) {
    return `Computer Use is not allowed to use the app '${bundleId}' for safety reasons.`;
  }

  return null;
}

// --- 遥测事件 ---

/**
 * Computer Use 的 13 个 Protobuf 遥测事件
 * 上报到: https://chatgpt.com/ces/v1/rgstr
 */
const TELEMETRY_EVENTS = {
  appStartup:
    "protobuf_analytics_events.v1.CodexComputerUseAppStartup",
  idleTimeoutReached:
    "protobuf_analytics_events.v1.CodexComputerUseIdleTimeoutReached",
  permissionGrantFinished:
    "protobuf_analytics_events.v1.CodexComputerUsePermissionGrantFinished",
  permissionWindowShown:
    "protobuf_analytics_events.v1.CodexComputerUsePermissionWindowShown",
  permissionRequested:
    "protobuf_analytics_events.v1.CodexComputerUsePermissionRequested",
  mcpServerLaunched:
    "protobuf_analytics_events.v1.CodexComputerUseMcpServerLaunched",
  mcpToolCalled:
    "protobuf_analytics_events.v1.CodexComputerUseMcpToolCalled",
  mcpAppApprovalRequested:
    "protobuf_analytics_events.v1.CodexComputerUseMcpAppApprovalRequested",
  mcpAppApprovalResolved:
    "protobuf_analytics_events.v1.CodexComputerUseMcpAppApprovalResolved",
  started:
    "protobuf_analytics_events.v1.CodexComputerUseStarted",
  ended:
    "protobuf_analytics_events.v1.CodexComputerUseEnded",
  ipcRequestFailed:
    "protobuf_analytics_events.v1.CodexComputerUseIpcRequestFailed",
} as const;

// --- 进程验证 ---

/**
 * SkyComputerUseClient 启动时的父进程验证
 * 引用: SkyComputerUseClient_Parent.coderequirement
 */
const PARENT_CODE_REQUIREMENT = {
  teamIdentifier: "2DC432GLL2",  // OpenAI Team ID
  // 只有 Team ID 为 2DC432GLL2 的进程可以启动 MCP Server
};

/**
 * Apple Event 发件人验证
 * SkyComputerUseService 验证 SkyComputerUseClient 的身份
 */
const CLIENT_BUNDLE_ID = "com.openai.sky.CUAService.cli";
const SERVICE_BUNDLE_ID = "com.openai.sky.CUAService";

export type {
  PermissionState,
  PermissionsWindow,
  AppApprovalStore,
  Approval,
  ApprovalPersistence,
  ComputerUsePolicy,
  McpElicitationRequest,
  ApprovalOption,
};

export {
  BLOCKED_PASSWORD_MANAGERS,
  TELEMETRY_EVENTS,
  PARENT_CODE_REQUIREMENT,
  CLIENT_BUNDLE_ID,
  SERVICE_BUNDLE_ID,
  checkAppBlocked,
};
