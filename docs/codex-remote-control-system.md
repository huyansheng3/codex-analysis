# Codex Remote Control / 远程连接系统完整逆向

> 来源：main.js (device key enrollment + SSH discovery + WebSocket), app-session.js (state keys), remote-control-device-key.node (Secure Enclave)
> 版本：26.506.31421

---

## 1. 系统概览

Remote Control 是 Codex 的多组件远程连接平台，**不仅仅是 SSH remote**。它由四个独立子系统组成：

```
┌─────────────────────────────────────────────────────────────────┐
│                 Codex Remote Control System                      │
│                                                                  │
│  1. Device Key System ── 硬件身份 + 签名认证                     │
│     └── Secure Enclave ECDSA P-256 + enrollment 流程             │
│                                                                  │
│  2. SSH Remote Connections ── ~/.ssh/config 发现 + 管理          │
│     └── Codex 自动发现 SSH 别名，安装 Codex 到远程主机            │
│                                                                  │
│  3. Remote Control WebSocket ── 实时远程控制通信                 │
│     └── Device Key 认证 + token 授权 + scope 控制                │
│                                                                  │
│  4. Remote App Server ── 远程工作区 + 文件浏览 + 终端            │
│     └── 远程目录浏览、远程 Chat Login、远程 App Server 连接       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Device Key 系统

### 2.1 架构

Device Key 是 Remote Control 的**身份基石**。每个设备生成唯一的 ECDSA P-256 密钥对，私钥存储在 Secure Enclave 中。

```
用户设备 (MacBook)
  │
  ├── remote-control-device-key.node
  │   ├── createDeviceKey(protection)  → ECDSA P-256 in Secure Enclave
  │   ├── getDeviceKeyPublic(keyId)    → SPKI DER Base64
  │   ├── signDeviceKey(keyId, payload)→ ECDSA signature
  │   └── deleteDeviceKey(keyId)       → 删除密钥
  │
  └── 密钥保护级别:
      ├── hardware_secure_enclave    → Secure Enclave (iPhone/Mac T2+)
      ├── os_protected_nonextractable → Keychain (不可导出)
      └── hardware_tpm              → TPM (Windows)
```

### 2.2 Enrollment 流程（7 步握手）

```
┌─────────────┐         ┌──────────────┐         ┌──────────────┐
│  Codex App   │         │  OpenAI API  │         │   Device     │
│  (Client)    │         │  (Server)    │         │   Key Node   │
└──────┬───────┘         └──────┬───────┘         └──────┬───────┘
       │                        │                        │
       │ 1. POST /codex/remote/ │                        │
       │    control/client/     │                        │
       │    enroll/start        │                        │
       │───────────────────────→│                        │
       │                        │                        │
       │ 2. ← challenge         │                        │
       │    {challenge_id,      │                        │
       │     nonce, audience,   │                        │
       │     client_id,         │                        │
       │     account_user_id}   │                        │
       │←───────────────────────│                        │
       │                        │                        │
       │ 3. createDeviceKey()   │                        │
       │────────────────────────────────────────────────→│
       │ 4. ← {keyId, publicKey}│                        │
       │←────────────────────────────────────────────────│
       │                        │                        │
       │ 5. Step-Up Auth        │                        │
       │   (重新认证用户身份)     │                        │
       │───────────────────────→│                        │
       │ 6. ← step_up_token     │                        │
       │←───────────────────────│                        │
       │                        │                        │
       │ 7. signDeviceKey()     │                        │
       │   (签名 challenge)      │                        │
       │────────────────────────────────────────────────→│
       │ 8. ← signature         │                        │
       │←────────────────────────────────────────────────│
       │                        │                        │
       │ 9. POST /codex/remote/ │                        │
       │    control/client/     │                        │
       │    enroll/finish       │                        │
       │   {client_id,          │                        │
       │    step_up_token,      │                        │
       │    device_identity,    │                        │
       │    device_key_proof}   │                        │
       │───────────────────────→│                        │
       │                        │                        │
       │10. ← {remote_control_  │                        │
       │      token, scopes,    │                        │
       │      expires_at}       │                        │
       │←───────────────────────│                        │
       │                        │                        │
       │11. 持久化 enrollment   │                        │
       │    到 Electron State   │                        │
```

### 2.3 Device Key Challenge 签名载荷

```typescript
// Device Key 对 challenge 的签名载荷结构
interface DeviceKeyChallengePayload {
  type: "device_key_challenge";
  nonce: string;              // 服务端随机数 (base64url, >=32 bytes)
  purpose: "remote_control_client_enrollment";
  audience: "remote_control_client_enrollment";
  challenge_id: string;        // 服务端生成的 challenge ID
  target_origin: string;       // 目标 origin URL
  target_path: string;         // 目标路径 (/codex/remote/control/client/enroll/finish)
  account_user_id: string;     // ChatGPT 账户 ID
  client_id: string;           // 设备客户端 ID
  challenge_token: string;     // 服务端 challenge token
  device_identity_hash?: string; // 设备身份 SHA256 hash (base64url)
  challenge_expires_at: number;  // challenge 过期时间戳
}

// 签名结果
interface DeviceKeyProof {
  challenge_token: string;
  key_id: string;
  signature_der_base64: string;     // ECDSA DER 签名
  signed_payload_base64: string;    // 被签名的原始 payload
  algorithm: "ecdsa_p256_sha256";
}
```

### 2.4 设备身份

```typescript
// 设备身份 = 设备密钥的公钥信息
interface DeviceIdentity {
  key_id: string;
  public_key_spki_der_base64: string;
  algorithm: "ecdsa_p256_sha256";
  protection_class: "hardware_secure_enclave" | "os_protected_nonextractable";
}

// device_identity_hash = SHA256(JSON.stringify(DeviceIdentity)) → base64url
function computeDeviceIdentityHash(identity: DeviceIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify({
      algorithm: identity.algorithm,
      keyId: identity.key_id,
      protectionClass: identity.protection_class,
      publicKeySpkiDerBase64: identity.public_key_spki_der_base64,
    }))
    .digest("base64url");
}
```

### 2.5 本地 Enrollment 状态管理

```typescript
// 存储在 Electron State 中
interface RemoteControlClientEnrollment {
  accountUserId: string;
  algorithm: "ecdsa_p256_sha256";
  clientId: string;
  keyId: string;
  protectionClass: string;
  publicKeySpkiDerBase64: string;
}

// State key: "electron-remote-control-client-enrollments"
// 支持多个 account 的 enrollment
```

### 2.6 Remote Control Token

```typescript
// Server 返回的 bearer token（用于后续 WebSocket 和 API 调用）
interface RemoteControlToken {
  client_id: string;
  account_user_id: string;
  remote_control_token: string;     // JWT/Bearer token
  expires_at: number;
  scopes: string[];                 // 通常包含 "remote_control_controller_websocket"
}

// token 有有效期，过期后需要 refresh
// refresh 使用已注册的 device key 签名新的 challenge
```

---

## 3. SSH Remote Connections 系统

### 3.1 配置来源

Codex 从 `~/.codex/config.toml` 读取 SSH 远程连接配置：

```toml
# config.toml
version = 1

[[remoteConnections]]
sshAlias = "my-server"           # SSH config 中的 Host 别名
[[remoteConnections.projects]]
remotePath = "/home/user/project"
label = "My Project"

[[remoteConnections]]
sshAlias = "dev-box"
[[remoteConnections.projects]]
remotePath = "/opt/app"
```

### 3.2 Zod Schema

```typescript
// config.toml 的 Zod 验证 schema（从 main.js 反编译）
const RemoteProjectSchema = z.object({
  remotePath: z.string().trim().min(1),
  label: z.string().optional(),
}).strict();

const RemoteConnectionSchema = z.object({
  sshAlias: z.string().trim().min(1),
  projects: z.array(RemoteProjectSchema).default([]),
}).strict();

const CodexConfigSchema = z.object({
  version: z.literal(1).optional().default(1),
  remoteConnectionMaxRetryAttempts: z.number().int().nonnegative().optional(),
  remoteConnections: z.array(RemoteConnectionSchema).default([]),
}).strict();
```

### 3.3 SSH Host 发现

Codex 读取用户的 `~/.ssh/config` 来发现可用的 SSH 主机：

```typescript
// SSH Host 发现流程
async function discoverRemoteConnections() {
  // 1. 读取 ~/.ssh/config
  // 2. 解析所有 Host 条目
  // 3. 过滤已知的占位符（colima 等）
  // 4. 与 config.toml 中的 sshAlias 匹配
  // 5. 合并已发现的和用户配置的连接
}

// 过滤规则
const IGNORED_HOSTS = new Set(["colima"]);
const BLOCKED_DOMAINS = new Set(["github.com"]);  // 不允许 SSH 到 GitHub
const SSH_CONFIG_VALIDATION = /[!*?[\]]/;          // 拒绝包含特殊字符的别名
```

### 3.4 RemoteConnection 内部模型

```typescript
// 从 SSH config + config.toml 合并后的内部模型
interface RemoteConnection {
  hostId: string;           // 唯一标识符
  displayName: string;      // 显示名（SSH alias）
  source: "discovered" | "configured";  // 来源

  // SSH 连接信息（从 ~/.ssh/config 解析）
  alias: string;            // SSH Host 别名
  hostname: string | null;  // 实际主机名/IP
  sshPort: number | null;   // SSH 端口
  identity: string | null;  // SSH 密钥路径

  // 配置的远程项目
  projects?: RemoteProject[];

  // 自动连接
  autoConnect?: boolean;

  // 远程 Codex 安装状态
  remoteCodexInstalled?: boolean;
}

interface RemoteProject {
  remotePath: string;
  label?: string;
}
```

### 3.5 Remote Connections Handler 完整 API

```typescript
class RemoteConnectionsHandler {
  // === 连接发现和管理 ===
  refreshRemoteConnections(): Promise<RemoteConnection[]>;
  discoverRemoteConnections(): Promise<void>;       // 扫描 ~/.ssh/config
  refreshRemoteControlConnections(): Promise<void>; // 刷新远程控制连接
  reconcileRemoteConnections(all: RemoteConnection[]): void;

  // === 远程环境管理 ===
  renameRemoteControlEnvironment({envId, name}): Promise<void>;
  deleteRemoteControlEnvironment({envId}): Promise<void>;

  // === 授权 ===
  authorizeRemoteControlConnections(): Promise<void>; // 触发 enrollment
  setRemoteControlConnectionsEnabled(enabled: boolean): Promise<void>;

  // === SSH 连接管理 ===
  saveCodexManagedRemoteSshConnections(connections): Promise<void>;
  setRemoteConnectionAutoConnect(hostId: string, autoConnect: boolean): Promise<void>;

  // === 远程操作 ===
  installRemoteCodex(hostId: string): Promise<void>;   // SSH 到远程安装 Codex
  appServerConnectionState(hostId: string): Promise<AppServerState>;
  remoteWorkspaceDirectoryEntries(hostId, path, dirsOnly): Promise<Entry[]>;

  // === ChatGPT Login（远程认证） ===
  startRemoteChatgptLoginPortForward(hostId, loginId): Promise<void>;
  stopRemoteChatgptLoginPortForward(hostId, loginId): Promise<void>;
  connectRemoteConnectionsAndLogFailures(hostIds: string[]): void;

  // === 本地 Identity 变化处理 ===
  handleLocalRemoteControlIdentityChanged(): void;
}
```

---

## 4. Remote Control WebSocket

### 4.1 WebSocket 连接

```typescript
// WebSocket 地址构造
const WEBSOCKET_SCOPE = "remote_control_controller_websocket";
const ENROLL_PATH = "codex.remote_control.enroll";

// 连接需要:
// 1. Device Key enrollment 已完成
// 2. Remote Control Token 有效
// 3. Scope 包含 "remote_control_controller_websocket"

// WebSocket 连接时:
// 1. 使用 device key 签名 connection challenge
// 2. Server 验证签名 + token
// 3. 建立 wss 连接
```

### 4.2 Connection Challenge 签名

```typescript
// WebSocket 连接时的 challenge 签名
interface ConnectionChallengeParams {
  type: "remoteControlClientConnection";
  nonce: string;
  audience: "remote_control_client_websocket";
  scopes: ["remote_control_controller_websocket"];  // 严格: 只能有这一个 scope
  sessionId: string;
  targetOrigin: string;
  targetPath: string;
  tokenExpiresAt: number;
  tokenSha256Base64url: string;  // Remote Control Token 的 SHA256
  accountUserId: string;
  clientId: string;
}
```

### 4.3 重试和重连

```typescript
const REMOTE_CONTROL_CONFIG = {
  // WebSocket 连接配置
  websocketScope: "remote_control_controller_websocket",
  enrollPath: "codex.remote_control.enroll",
  enrollmentTimeout: 500,  // ms

  // 重连配置
  remoteConnectionMaxRetryAttempts: number,  // 从 config.toml 读取
};
```

---

## 5. 完整的 IPC 命令列表

```typescript
// 所有 Remote Control 相关的渲染进程可调用的命令
const REMOTE_CONTROL_COMMANDS = {
  // === SSH 连接 ===
  "refresh-remote-connections":            // 刷新远程连接列表
  "discover-remote-ssh-connections":       // 扫描 ~/.ssh/config
  "save-codex-managed-remote-ssh-connections": // 保存 Codex 管理的 SSH 连接
  "set-remote-connection-auto-connect":    // 设置自动连接

  // === 远程控制 ===
  "refresh-remote-control-connections":    // 刷新远程控制连接
  "rename-remote-control-environment":     // 重命名远程环境
  "delete-remote-control-environment":     // 删除远程环境
  "authorize-remote-control-connections":  // 授权（触发 enrollment）
  "set-remote-control-connections-enabled": // 启用/禁用远程控制

  // === 远程操作 ===
  "install-remote-codex":                  // SSH 安装 Codex 到远程
  "start-remote-chatgpt-login-port-forward": // 启动远程 ChatGPT 登录转发
  "stop-remote-chatgpt-login-port-forward":  // 停止远程登录转发
  "app-server-connection-state":           // 查询 App Server 连接状态
  "remote-workspace-directory-entries":    // 浏览远程工作区目录
};
```

---

## 6. 数据流示例

### 6.1 用户添加远程服务器

```
1. 用户编辑 ~/.ssh/config:
   Host my-server
       HostName 192.168.1.100
       User dev
       IdentityFile ~/.ssh/id_rsa

2. Codex 自动发现:
   discover-remote-ssh-connections
   → 解析 ~/.ssh/config → 找到 "my-server"
   → 显示在 Remote Connections 列表中

3. 用户编辑 ~/.codex/config.toml:
   [[remoteConnections]]
   sshAlias = "my-server"
   [[remoteConnections.projects]]
   remotePath = "/home/dev/project"

4. Codex 应用配置:
   save-codex-managed-remote-ssh-connections
   → 存储到 Electron State
   → global-state-updated 事件广播

5. 安装远程 Codex:
   install-remote-codex(hostId="my-server")
   → SSH 到 my-server
   → 下载并安装 Codex agent
   → 启动 app-server (远程)

6. 连接:
   connectRemoteConnectionsAndLogFailures(["my-server"])
   → 建立 App Server 连接
   → 远程工作区可用
```

### 6.2 Remote Control 设备授权

```
1. 用户点击 "Enable Remote Control"
   → authorize-remote-control-connections

2. 检查现有 enrollment:
   → 从 state 读取 "electron-remote-control-client-enrollments"
   → 如果没有，开始 enrollment 流程

3. Device Key enrollment (7 步握手):
   → POST /codex/remote/control/client/enroll/start → challenge
   → createDeviceKey("hardware_secure_enclave") → Secure Enclave key
   → Step-Up Auth (重新认证) → step_up_token
   → signDeviceKey(challenge) → ECDSA 签名
   → POST /codex/remote/control/client/enroll/finish → token

4. 建立 WebSocket 连接:
   → wss://... → remote_control_controller_websocket
   → 用 device key 签名 connection challenge
   → 获得实时通信通道
```

---

## 7. 安全分析

### 7.1 密钥安全

| 组件 | 存储 | 风险 |
|------|------|------|
| Device Key 私钥 | Secure Enclave | 硬件隔离，不可导出 ✅ |
| Enrollment State | Electron State (明文) | 可被渲染进程读取 ⚠️ |
| Remote Control Token | 内存 | 重启丢失，需 refresh |
| SSH 密钥 | ~/.ssh/ | 文件系统权限保护 ⚠️ |

### 7.2 认证链

```
用户身份 (ChatGPT Account)
  │
  ├── Step-Up Auth → 验证用户确实有账户控制权
  │
  ├── Device Key Enrollment → 绑定设备身份到用户账户
  │   └── ECDSA P-256 签名 = 设备身份的密码学证明
  │
  ├── Remote Control Token → JWT (短期有效)
  │   └── Device Key 签名 = Token 绑定了设备
  │
  └── WebSocket Connection → Token + 实时签名
      └── 每次连接都需要新的 device key 签名
```

### 7.3 攻击面

| 向量 | 严重度 | 说明 |
|------|--------|------|
| Enrollment State 读取 | Medium | 任何 preload 渲染进程可读 `electron-remote-control-client-enrollments` |
| SSH Config 注入 | Medium | 如果用户 ~/.ssh/config 被恶意修改，Codex 会自动连接 |
| Token Refresh 失败 | Low | 有完善的重试机制，但频繁失败会触发 devic key 清理 |
| `install-remote-codex` | High | SSH 到远程安装软件，需确保目标主机可信 |
| Port Forward | Medium | `start-remote-chatgpt-login-port-forward` 建立 SSH 隧道 |

### 7.4 与 Computer Use 的对比

| | Remote Control | Computer Use |
|------|---------------|-------------|
| 目标 | 远程开发机控制 | 本地桌面控制 |
| 认证 | Device Key (ECDSA) + Token | Accessibility 权限 |
| 通信 | WebSocket (wss) | Apple Events (本地) |
| 范围 | SSH 主机 + 远程工作区 | macOS 桌面应用 |
| 安装 | SSH 安装 Codex agent | 内置 Swift 应用 |
