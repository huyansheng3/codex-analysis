// ============================================================
// SSH Remote Connections — 从 main.js 反编译重建
// ~/.ssh/config 解析 + config.toml 合并 + 远程状态管理
// ============================================================

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

// --- 类型定义 ---

interface RemoteProject {
  remotePath: string;
  label?: string;
}

interface RemoteConnectionConfig {
  sshAlias: string;
  projects: RemoteProject[];
}

interface CodexAppConfig {
  version: number;
  remoteConnectionMaxRetryAttempts?: number;
  remoteConnections: RemoteConnectionConfig[];
}

interface RemoteConnection {
  hostId: string;
  displayName: string;
  source: "discovered" | "configured";
  alias: string;
  hostname: string | null;
  sshPort: number | null;
  identity: string | null;
  projects?: RemoteProject[];
  autoConnect?: boolean;
  remoteCodexInstalled?: boolean;
}

interface RemoteControlEnvironment {
  envId: string;
  installationId: string;
  name?: string;
}

// --- 常量 ---

/** Codex config.toml 文件名 */
const CONFIG_FILENAME = "config.toml";

/** ~/.ssh/config 中的 Host 过滤 */
const IGNORED_SSH_HOSTS = new Set(["colima"]);
const BLOCKED_SSH_DOMAINS = new Set(["github.com"]);

/** SSH 配置中不允许的字符 */
const INVALID_SSH_ALIAS_PATTERN = /[!*?[\]]/;
const INVALID_SSH_HOSTNAME_PATTERN = /[*?[\]{}()]/;

/** Electron State keys */
const STATE_KEYS = {
  CODEX_MANAGED_REMOTE_CONNECTIONS: "codex_managed_remote_connections",
  REMOTE_CONNECTION_AUTO_CONNECT_BY_HOST_ID: "remote-connection-auto-connect-by-host-id",
  REMOTE_CONNECTION_ANALYTICS_ID_BY_HOST_ID: "remote-connection-analytics-id-by-host-id",
  REMOTE_CONTROL_CLIENT_ENROLLMENTS: "electron-remote-control-client-enrollments",
  LOCAL_REMOTE_CONTROL_ENVIRONMENT_ID: "electron-local-remote-control-environment-id",
  LOCAL_REMOTE_CONTROL_INSTALLATION_ID: "electron-local-remote-control-installation-id",
} as const;

// --- SSH Config 解析 ---

interface SshHost {
  alias: string;
  hostname?: string;
  port?: number;
  identityFile?: string;
  user?: string;
}

/**
 * 解析 ~/.ssh/config 文件
 */
function parseSshConfig(configPath: string): SshHost[] {
  if (!fs.existsSync(configPath)) return [];

  const content = fs.readFileSync(configPath, "utf8");
  const hosts: SshHost[] = [];
  let currentHost: SshHost | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    // 空行或注释
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const parts = trimmed.split(/\s+/);
    const keyword = parts[0]?.toLowerCase();
    const value = parts.slice(1).join(" ");

    if (keyword === "host") {
      // 保存上一个 Host
      if (currentHost) hosts.push(currentHost);

      // 解析新的 Host（支持多个别名: Host alias1 alias2）
      const aliases = value.split(/\s+/);
      for (const alias of aliases) {
        if (!isValidSshAlias(alias)) continue;
        currentHost = { alias };
        // 每个别名都是一个独立的 entry
        hosts.push(currentHost);
        currentHost = { alias }; // 后续属性只赋给最后一个 alias
      }
    } else if (currentHost) {
      switch (keyword) {
        case "hostname":
          if (!INVALID_SSH_HOSTNAME_PATTERN.test(value)) {
            currentHost.hostname = value;
          }
          break;
        case "port":
          currentHost.port = parseInt(value, 10) || undefined;
          break;
        case "identityfile":
          currentHost.identityFile = value.replace(/^~/, os.homedir());
          break;
        case "user":
          currentHost.user = value;
          break;
      }
    }
  }

  return hosts.filter(
    (h) => !IGNORED_SSH_HOSTS.has(h.alias) && !isBlockedHost(h)
  );
}

function isValidSshAlias(alias: string): boolean {
  return (
    alias.length > 0 &&
    !alias.includes("*") && // 拒绝通配符
    !INVALID_SSH_ALIAS_PATTERN.test(alias)
  );
}

function isBlockedHost(host: SshHost): boolean {
  if (host.hostname) {
    for (const domain of BLOCKED_SSH_DOMAINS) {
      if (host.hostname === domain || host.hostname.endsWith("." + domain)) {
        return true;
      }
    }
  }
  return false;
}

// --- Config 文件读取 ---

function getConfigPath(codexHome: string): string {
  return path.join(codexHome, CONFIG_FILENAME);
}

/**
 * 读取并解析 config.toml
 */
async function readCodexConfig(
  codexHome: string
): Promise<{ status: "loaded" | "missing" | "error"; configPath: string; config?: CodexAppConfig }> {
  const configPath = getConfigPath(codexHome);

  if (!fs.existsSync(configPath)) {
    return { status: "missing", configPath };
  }

  try {
    const content = fs.readFileSync(configPath, "utf8");
    const config = parseToml(content); // TOML parser (smol-toml)
    return { status: "loaded", configPath, config };
  } catch {
    return { status: "error", configPath };
  }
}

function parseToml(content: string): CodexAppConfig {
  // 使用 smol-toml 库解析
  // 这里只展示结构
  return {
    version: 1,
    remoteConnections: [],
  };
}

// --- 连接合并 ---

/**
 * 合并 SSH config 发现的连接和用户配置的连接
 */
function resolveRemoteConnections({
  sshHosts,
  config,
  globalState,
}: {
  sshHosts: SshHost[];
  config: CodexAppConfig;
  globalState: GlobalState;
}): {
  remoteConnections: RemoteConnection[];
  changedGlobalStateKeys: string[];
} {
  // 1. 读取已保存的 Codex 管理的 SSH 连接
  const savedConnections =
    (globalState.get(STATE_KEYS.CODEX_MANAGED_REMOTE_CONNECTIONS) as RemoteConnection[]) ?? [];

  // 2. 合并
  const savedAliases = new Set(savedConnections.map((c) => c.alias?.trim()).filter(Boolean));
  const newDiscovered: RemoteConnection[] = [];

  for (const cfg of config.remoteConnections) {
    if (savedAliases.has(cfg.sshAlias)) continue;
    savedAliases.add(cfg.sshAlias);

    const sshHost = sshHosts.find((h) => h.alias === cfg.sshAlias);

    newDiscovered.push({
      hostId: makeHostId(cfg.sshAlias),
      displayName: cfg.sshAlias,
      source: "discovered",
      alias: cfg.sshAlias,
      hostname: sshHost?.hostname ?? null,
      sshPort: sshHost?.port ?? null,
      identity: sshHost?.identityFile ?? null,
      projects: cfg.projects,
    });
  }

  if (newDiscovered.length === 0) {
    return { remoteConnections: savedConnections, changedGlobalStateKeys: [] };
  }

  // 3. 更新全局状态
  globalState.set(STATE_KEYS.CODEX_MANAGED_REMOTE_CONNECTIONS, [
    ...savedConnections,
    ...newDiscovered,
  ]);

  return {
    remoteConnections: [...savedConnections, ...newDiscovered],
    changedGlobalStateKeys: [STATE_KEYS.CODEX_MANAGED_REMOTE_CONNECTIONS],
  };
}

function makeHostId(sshAlias: string): string {
  return `remote:${sshAlias}`;
}

// --- Remote Connections Handler ---

class RemoteConnectionsHandler {
  constructor(
    private appState: GlobalState,
    private sharedObjectRepo: SharedObjectRepo,
    private hostId: string,
    private connectionRegistry: AppServerConnectionRegistry,
    private desktopApiOptions: DesktopApiOptions,
    private appServerClient: AppServerClient,
    private remoteControlDeviceKeyClient: DeviceKeyClient,
    private getHostConfigForHostId: (id: string) => HostConfig,
    private getAppServerClientForHostId: (id: string) => AppServerClient
  ) {}

  // === SSH 连接发现 ===

  async refreshRemoteConnections(): Promise<RemoteConnection[]> {
    const sshConfigPath = path.join(os.homedir(), ".ssh", "config");
    const sshHosts = parseSshConfig(sshConfigPath);

    const configPath = getConfigPath(
      this.appState.get("codex_home") as string
    );
    const { config } = await readCodexConfig(configPath);

    if (!config) return [];

    const { remoteConnections } = resolveRemoteConnections({
      sshHosts,
      config,
      globalState: this.appState,
    });

    return remoteConnections;
  }

  async discoverRemoteConnections(): Promise<void> {
    await this.refreshRemoteConnections();
  }

  // === 远程控制 ===

  async refreshRemoteControlConnections(): Promise<void> {
    // 刷新远程控制环境列表
  }

  async authorizeRemoteControlConnections(): Promise<void> {
    // 触发 Device Key enrollment
  }

  async setRemoteControlConnectionsEnabled(enabled: boolean): Promise<void> {
    this.sharedObjectRepo.set("remote_control_connections_enabled", enabled);
  }

  // === SSH 连接管理 ===

  async saveCodexManagedRemoteSshConnections(
    connections: RemoteConnection[]
  ): Promise<void> {
    this.appState.set(
      STATE_KEYS.CODEX_MANAGED_REMOTE_CONNECTIONS,
      connections
    );
  }

  async setRemoteConnectionAutoConnect(
    hostId: string,
    autoConnect: boolean
  ): Promise<void> {
    const autoConnectMap =
      (this.appState.get(STATE_KEYS.REMOTE_CONNECTION_AUTO_CONNECT_BY_HOST_ID) as Record<string, boolean>) ?? {};

    autoConnectMap[hostId] = autoConnect;
    this.appState.set(
      STATE_KEYS.REMOTE_CONNECTION_AUTO_CONNECT_BY_HOST_ID,
      autoConnectMap
    );
  }

  // === 远程操作 ===

  async installRemoteCodex(hostId: string): Promise<void> {
    // SSH 到远程主机，安装 Codex agent
    // 使用 node-pty 或 SSH 客户端
  }

  async appServerConnectionState(hostId: string): Promise<unknown> {
    return this.connectionRegistry.getConnectionState(hostId);
  }

  async remoteWorkspaceDirectoryEntries(
    hostId: string,
    directoryPath: string,
    directoriesOnly: boolean
  ): Promise<unknown[]> {
    const client = this.getAppServerClientForHostId(hostId);
    return client.listDirectory(directoryPath, { directoriesOnly });
  }

  // === ChatGPT Login 端口转发 ===

  async startRemoteChatgptLoginPortForward(
    hostId: string,
    loginId: string
  ): Promise<void> {
    // SSH port forward: 远程 Codex → 本地 OAuth callback
    // 允许用户通过远程主机的浏览器完成 ChatGPT 登录
  }

  async stopRemoteChatgptLoginPortForward(
    hostId: string,
    loginId: string
  ): Promise<void> {
    // 关闭 SSH 端口转发
  }

  // === 连接管理 ===

  async connectRemoteConnectionsAndLogFailures(
    hostIds: string[]
  ): Promise<void> {
    for (const hostId of hostIds) {
      try {
        await this.connectionRegistry.connect(hostId);
      } catch (error) {
        // 日志记录但继续
      }
    }
  }

  reconcileRemoteConnections(all: RemoteConnection[]): void {
    // 同步远程连接状态到内部缓存
  }

  // === 环境管理 ===

  async renameRemoteControlEnvironment({
    envId,
    name,
  }: {
    envId: string;
    name: string;
  }): Promise<void> {
    // 重命名远程控制环境
  }

  async deleteRemoteControlEnvironment({
    envId,
  }: {
    envId: string;
  }): Promise<void> {
    // 删除远程控制环境
  }

  // === Identity 管理 ===

  handleLocalRemoteControlIdentityChanged(): void {
    const envId = this.appState.get(
      STATE_KEYS.LOCAL_REMOTE_CONTROL_ENVIRONMENT_ID
    );
    const installationId = this.appState.get(
      STATE_KEYS.LOCAL_REMOTE_CONTROL_INSTALLATION_ID
    );
    // 处理本地 identity 变化
  }
}

// --- 占位类型 ---

interface GlobalState {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

interface SharedObjectRepo {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

interface AppServerConnectionRegistry {
  getConnectionState(hostId: string): Promise<unknown>;
  connect(hostId: string): Promise<void>;
}

interface DesktopApiOptions {
  baseUrl: string;
}

interface AppServerClient {
  listDirectory(path: string, opts: unknown): Promise<unknown[]>;
}
interface HostConfig { id: string; }
interface DeviceKeyClient {
  createDeviceKey: Function;
  signDeviceKey: Function;
  deleteDeviceKey: Function;
}

export {
  RemoteConnectionsHandler,
  parseSshConfig,
  resolveRemoteConnections,
  readCodexConfig,
  getConfigPath,
  STATE_KEYS,
};

export type {
  RemoteConnection,
  RemoteConnectionConfig,
  RemoteProject,
  CodexAppConfig,
  SshHost,
  RemoteControlEnvironment,
};
