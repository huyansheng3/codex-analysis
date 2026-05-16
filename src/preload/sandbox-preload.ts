// ============================================================
// Sandbox Preload — 从 sandbox-preload.js 逆向重建
// 文件: .vite/build/sandbox-preload.js (1,978 bytes)
// 用途: MCP App Sandbox 的安全验证和 Port 消息传递
// ============================================================

import { ipcRenderer } from "electron";

// --- 常量 ---

/** 允许的沙箱主域名 */
const SANDBOX_DOMAIN = "web-sandbox.oaiusercontent.com";
/** 允许的沙箱子域名通配符 */
const SANDBOX_SUBDOMAIN_PATTERN = `.${SANDBOX_DOMAIN}`;

/** Skybridge 协议要求的 URL 参数 */
const SKYBRIDGE_REQUIRED_PARAMS = [
  "app",
  "locale",
  "deviceType",
  "unsafeSkipTargetOriginCheck",
] as const;

/** MCP Sandbox 允许的 Port 消息类型（白名单） */
const ALLOWED_PORT_NAMES = [
  "notifyMcpAppsHostContext",
  "notifyMcpAppsToolCancelled",
  "notifyMcpAppsToolInput",
  "notifyMcpAppsToolResult",
  "requestMcpAppsResourceTeardown",
  "runWidgetCode",
  "setAdditionalGlobals",
  "setSafeArea",
  "setTheme",
  "setWidgetData",
  "setWidgetView",
] as const;

/** IPC 通道：MCP App Sandbox 客户消息 */
const MCP_SANDBOX_GUEST_CHANNEL = "codex_desktop:mcp-app-sandbox-guest-message";

/** URL hash 中的 initId 参数名 */
const INIT_ID_PARAM = "initId";

/** initId 验证正则：字母数字 + 下划线 + 短横线，1-128 字符 */
const INIT_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

// --- 域名验证 ---

/**
 * 验证 URL 是否属于允许的沙箱域名
 * 仅允许: web-sandbox.oaiusercontent.com 及其子域名
 */
function isAllowedSandboxDomain(hostname: string): boolean {
  return (
    hostname === SANDBOX_DOMAIN ||
    hostname.endsWith(SANDBOX_SUBDOMAIN_PATTERN)
  );
}

/**
 * 验证并解析沙箱 URL
 * - 仅允许 HTTPS
 * - 不允许指定端口
 * - 不允许用户名/密码
 * - 域名必须在白名单内
 */
function validateSandboxUrl(urlString: string | undefined | null): URL | null {
  if (urlString == null) return null;
  try {
    const url = new URL(urlString);
  } catch {
    return null;
  }
  const url = new URL(urlString);

  if (url.protocol !== "https:") return null;
  if (url.port !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (!isAllowedSandboxDomain(url.hostname)) return null;

  return url;
}

/**
 * 从 URL 获取 targetOrigin
 */
function getTargetOrigin(
  urlString: string,
  opts: { requireSkybridge?: boolean } = {}
): string | null {
  const url = validateSandboxUrl(urlString);
  if (url == null) return null;
  if (opts.requireSkybridge && !isSkybridgeUrl(url)) return null;
  return url.origin;
}

// --- Skybridge 协议检测 ---

/**
 * 检测 URL 是否为 Skybridge 连接
 *
 * URL 格式:
 * https://{sandbox-domain}/?app=skybridge&locale={locale}
 *   &deviceType=desktop&unsafeSkipTargetOriginCheck=true
 */
function isSkybridgeUrl(url: URL): boolean {
  const params = Array.from(url.searchParams.keys());
  return (
    url.pathname === "/" &&
    params.length === SKYBRIDGE_REQUIRED_PARAMS.length &&
    SKYBRIDGE_REQUIRED_PARAMS.every((p) => url.searchParams.has(p)) &&
    url.searchParams.get("app") === "skybridge" &&
    url.searchParams.get("locale") !== "" &&
    url.searchParams.get("deviceType") === "desktop" &&
    url.searchParams.get("unsafeSkipTargetOriginCheck") === "true"
  );
}

// --- initId 提取和验证 ---

/**
 * 从 URL hash 中提取 initId
 * 格式: #initId=<id>
 */
function extractInitId(urlString: string | undefined | null): string | null {
  if (urlString == null) return null;
  try {
    const url = new URL(urlString);
  } catch {
    return null;
  }
  const url = new URL(urlString);
  if (url.hash.length === 0) return null;

  const params = new URLSearchParams(url.hash.slice(1));
  const initId = params.get(INIT_ID_PARAM);

  if (initId != null && INIT_ID_REGEX.test(initId)) {
    return initId;
  }
  return null;
}

// --- Port 验证 ---

function isValidPort(port: unknown): port is MessagePort {
  return (
    typeof port === "object" &&
    port != null &&
    typeof (port as MessagePort).postMessage === "function" &&
    typeof (port as MessagePort).start === "function"
  );
}

// --- Init 流程 ---

/** 防止重复初始化 */
let initialized = false;

/**
 * 当前页面是否为 Skybridge 连接
 */
function isCurrentPageSkybridge(): boolean {
  return (
    getTargetOrigin(window.location.href, { requireSkybridge: true }) ===
    window.location.origin
  );
}

/**
 * 处理来自宿主窗口的 init 消息
 * 验证 origin → 提取 initId → 验证 ports → 通过 IPC 转发
 */
window.addEventListener("message", (event: MessageEvent) => {
  // 仅处理来自自身的消息
  if (event.source !== window) return;
  // 必须是 Skybridge 连接的页面
  if (!isCurrentPageSkybridge()) return;
  // 消息格式验证
  if (event.data == null || typeof event.data !== "object") return;
  if (event.data.type !== "init") return;

  const { ports, replyPort } = event.data;
  if (typeof ports !== "object" || !ports || !isValidPort(replyPort)) return;
  if (initialized) return;

  const initId = extractInitId(window.location.href);
  if (initId == null) return;

  // 白名单验证：所有 port 名称必须在允许列表中
  const portNames = [...ALLOWED_PORT_NAMES];
  const portEntries = portNames.map((name) => ports[name]);
  if (portEntries.some((p) => !isValidPort(p))) return;

  initialized = true;

  // 通过 IPC 发送 init 消息到主进程（转移 MessagePort 所有权）
  ipcRenderer.postMessage(
    MCP_SANDBOX_GUEST_CHANNEL,
    {
      origin: window.location.origin,
      initId,
      portNames,
      type: "init",
    },
    [...portEntries, replyPort]
  );
});
