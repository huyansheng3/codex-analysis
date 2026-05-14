# Codex Computer Use 实现完整逆向

> 来源：SkyComputerUseService/SkyComputerUseClient 二进制 strings、Info.plist、SKILL.md、AppInstructions、main.js 代码提取
> 版本：1.0.780 (Bundle: com.openai.sky.CUAService)

---

## 1. 架构概览

Computer Use 由**两个 Swift 原生进程**组成：

```
┌──────────────────────────────────────────────────────────────┐
│  Electron 主进程 (main.js)                                    │
│  ├── computerUse feature flag 检查                           │
│  ├── 路径查找优先级：                                         │
│  │   1. CODEX_ELECTRON_COMPUTER_USE_APP_PATH 环境变量        │
│  │   2. 已安装的 computer-use 插件目录                        │
│  │   3. 内置 bundled plugin 路径                             │
│  └── spawn("SkyComputerUseClient", ["mcp"])                  │
│      → stdin/stdout JSON-RPC (MCP Protocol)                  │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐     │
│  │  SkyComputerUseClient.app (CLI MCP Server)           │     │
│  │  Bundle: com.openai.sky.CUAService.cli               │     │
│  │  Swift arm64 二进制                                  │     │
│  │                                                      │     │
│  │  核心模块:                                            │     │
│  │  ├── ComputerUseMCPServer ── 9 个 MCP Tools          │     │
│  │  ├── CodexAppServerJSONRPCConnection ── 与 Service 通信│    │
│  │  ├── AppApprovalStore ── SQLite 审批状态              │     │
│  │  ├── ComputerUseMCPTurnMetricsTracker ── 遥测         │     │
│  │  ├── CodexAppServerComputerUsePolicyProvider ── 策略  │     │
│  │  └── AppInstructionDeliveryState ── 应用指令分发       │     │
│  │         │                                             │     │
│  │         │ Apple Events (NSAppleEventDescriptor)       │     │
│  │         │ + Unix Domain Socket IPC                     │     │
│  │         ▼                                             │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐     │
│  │  Codex Computer Use.app (GUI Service)                 │     │
│  │  Bundle: com.openai.sky.CUAService                   │     │
│  │  Binary: SkyComputerUseService                       │     │
│  │  LSUIElement=1 (无 Dock 图标，仅菜单栏)               │     │
│  │                                                      │     │
│  │  核心模块:                                            │     │
│  │  ├── CUAServiceApplicationDelegate ── 应用入口        │     │
│  │  │   ├── accessCoordinator                           │     │
│  │  │   ├── computerUseIPCServer                        │     │
│  │  │   ├── codexComputerUseSessionTracker              │     │
│  │  │   ├── codexAppServerThreadEventObserver           │     │
│  │  │   ├── permissionState                             │     │
│  │  │   ├── permissionsWindow                           │     │
│  │  │   ├── statusItemController                        │     │
│  │  │   └── inactivityTask                              │     │
│  │  │                                                  │     │
│  │  ├── Accessibility Engine                            │     │
│  │  │   ├── AXUIElementCopyAttributeValue ── 读取 UI 树 │     │
│  │  │   ├── AXUIElementPerformAction ── 点击/滚动       │     │
│  │  │   ├── AXUIElementSetAttributeValue ── 设置值      │     │
│  │  │   └── AXObserverCreate ── UI 变化通知             │     │
│  │  │                                                  │     │
│  │  ├── Screen Capture Engine                           │     │
│  │  │   ├── SCShareableContent ── 获取屏幕共享内容      │     │
│  │  │   ├── CGWindowListCreateImage ── 窗口截图         │     │
│  │  │   └── CGImage ── 像素级图像处理                   │     │
│  │  │                                                  │     │
│  │  ├── Input Simulation Engine                         │     │
│  │  │   ├── CGEventCreateKeyboardEvent ── 键盘事件      │     │
│  │  │   ├── CGEventCreateMouseEvent ── 鼠标事件         │     │
│  │  │   ├── CGEventPost ── 发送事件到系统               │     │
│  │  │   └── SAIVirtualKeyPress ── 虚拟按键（高级）      │     │
│  │  │                                                  │     │
│  │  └── 包含的 Bundles:                                 │     │
│  │      ├── Package_ComputerUse.bundle ── 核心引擎      │     │
│  │      │   └── LensSequence/ (45帧 PNG) ── 动画序列    │     │
│  │      ├── Package_SlimCore.bundle ── 轻量运行时       │     │
│  │      ├── Package_ComputerUseClient.bundle ── 客户端   │     │
│  │      │   └── AppInstructions/*.md ── 应用特定指令     │     │
│  │      └── SwiftProtobuf_SwiftProtobuf.bundle ── 序列化 │     │
│  └─────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

### 1.1 两个进程的分工

| 职责 | SkyComputerUseService (GUI) | SkyComputerUseClient (CLI) |
|------|---------------------------|---------------------------|
| 运行方式 | 独立 .app (LSUIElement) | 由 Electron spawn 的子进程 |
| 系统权限 | Accessibility + Screen Recording | 无（通过 Apple Events 委托给 Service） |
| MCP 协议 | 不直接处理 | stdin/stdout JSON-RPC |
| UI | 权限窗口 + 菜单栏图标 + 状态项 | 无 |
| 会话管理 | bundleIDsByConversationID | turnMetricsTracker |
| IPC | Unix Domain Socket Server | Apple Events → Service |

---

## 2. 启动流程

### 2.1 路径查找（main.js 反编译）

```typescript
// 环境变量 key
const SKY_CUA_SERVICE_PATH = "SKY_CUA_SERVICE_PATH";
const SKY_CUA_WINDOWS_HELPER_PATH = "SKY_CUA_WINDOWS_HELPER_PATH";

// 内置 Service App 名称
const SERVICE_APP_NAME = "Codex Computer Use.app";

// 查找优先级
function resolveComputerUsePath({
  env = process.env,
  installedPluginRoot,
  pathExists = fs.existsSync,
}) {
  // 1. 环境变量覆盖（开发/调试用）
  const envPath = env[SKY_CUA_SERVICE_PATH]?.trim();
  if (envPath) return envPath;

  // 2. 已安装插件目录
  if (installedPluginRoot) {
    const pluginServicePath = path.join(
      installedPluginRoot, SERVICE_APP_NAME
    );
    if (pathExists(pluginServicePath)) return pluginServicePath;
  }

  // 3. 内置 bundled plugin
  // 搜索 marketplaces 中 computer-use 插件的本地路径
  for (const marketplace of marketplaces) {
    const plugin = marketplace.plugins.find(
      p => p.name === "computer-use" && p.installed && p.enabled
    );
    if (plugin?.source?.type === "local") {
      return resolveFromPluginRoot(plugin.source.path);
    }
  }

  return null;
}

// Windows 平台特殊处理
// CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE === "1" 时才启用
// Windows 上查找 bin/computer-use-helper.exe
```

### 2.2 子进程 spawn（main.js 反编译）

```typescript
const CUA_BUNDLE_ID = "com.openai.sky.CUAService";
const CUA_BRIDGE_NAME = "CodexComputerUseNativeBridge-1";

// IPC 请求类型
const IPCMessageTypes = {
  getFrontmostWindow: "ComputerUseIPCFrontmostWindowRequest",
};

// 启动 Computer Use MCP Server
async function launchComputerUseServer({
  appServerConnection,
  codexHome,
  nodePath,
}) {
  // 1. 查找 SkyComputerUseClient 路径
  const servicePath = await resolveComputerUsePath({ appServerConnection });
  if (!servicePath) return null;

  // 2. 获取 SkyComputerUseClient.app（嵌入在 Service app 的 SharedSupport 中）
  const clientPath = path.join(
    servicePath, "Contents", "SharedSupport",
    "SkyComputerUseClient.app", "Contents", "MacOS", "SkyComputerUseClient"
  );

  // 3. 验证 Service bundle identifier
  const actualBundleId = getBundleIdentifier(servicePath);
  if (actualBundleId !== CUA_BUNDLE_ID) {
    throw new Error(
      `Codex Computer Use service app has bundle identifier '${actualBundleId}', expected '${CUA_BUNDLE_ID}'`
    );
  }

  // 4. 启动 Service app（如果尚未运行）
  const runningInstance = findRunningInstance(CUA_BUNDLE_ID);
  if (runningInstance) {
    return runningInstance;
  }
  return launchApp(servicePath);
}
```

### 2.3 本地到内置迁移

```typescript
// computer_use_local_to_bundled_migration
// 如果用户之前单独安装了 Computer Use 插件，自动迁移到内置版本
async function migrateLocalToBundled({
  appServerConnection,
  codexHome,
  isMacAppNotarized,
}) {
  const localPlugin = findLocalComputerUsePlugin(codexHome);
  if (!localPlugin) return;

  const buildNumber = getBuildNumber(localPlugin.path);
  const hasBuildNumber = buildNumber != null && buildNumber > 0;

  // 如果本地版本有 build number 或经过公证，迁移到内置
  const shouldMigrate = hasBuildNumber
    || await isMacAppNotarized(path.join(localPlugin.path, SERVICE_APP_NAME));

  if (shouldMigrate) {
    await appServerConnection.uninstallPlugin({ pluginId: localPlugin.id });
    await trashItem(localPlugin.path);
    await appServerConnection.installPlugin({
      marketplacePath: bundledMarketplace.path,
      pluginName: "computer-use",
    });
  }
}
```

---

## 3. MCP Tools 完整接口

### 3.1 接口定义（从 SkyComputerUseClient 二进制 strings 还原）

```typescript
// Computer Use MCP Server 注册的 9 个 Tools

const COMPUTER_USE_TOOLS = {
  // ─── Tool 1: list_apps ───
  list_apps: {
    description: `List the apps on this computer. Returns the set of apps
that are currently running, as well as any that have been used in the last
14 days, including details on usage frequency.`,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    // 返回: { apps: App[] }
    // 不需要 get_app_state 前置调用
  },

  // ─── Tool 2: get_app_state ───
  get_app_state: {
    description: `Start an app use session if needed, then get the state of
the app's key window and return a screenshot and accessibility tree. This
must be called once per assistant turn before interacting with the app.`,
    parameters: {
      type: "object",
      properties: {
        app: {
          type: "string",
          description: "App name or bundle identifier",
        },
      },
      required: ["app"],
      additionalProperties: false,
    },
    // 返回:
    // {
    //   screenshot: string,          // base64 PNG
    //   accessibilityTree: Element[], // UI 元素树
    //   appInfo: AppInfo,            // { bundleIdentifier, windowTitle, ... }
    //   cuaAppVersion: string,       // Service 版本号
    // }
  },

  // ─── Tool 3: click ───
  click: {
    description: `Click an element by index or pixel coordinates from screenshot.`,
    parameters: {
      type: "object",
      properties: {
        elementIndex: {
          type: "number",
          description: "Element index to click",
        },
        x: {
          type: "number",
          description: "X coordinate in screenshot pixel coordinates",
        },
        y: {
          type: "number",
          description: "Y coordinate in screenshot pixel coordinates",
        },
        button: {
          type: "string",
          description: "Mouse button to click. Defaults to left.",
          enum: ["left", "right", "center"],
        },
        clicks: {
          type: "number",
          description: "Number of clicks. Defaults to 1.",
        },
      },
      // elementIndex 或 (x, y) 二选一
    },
  },

  // ─── Tool 4: perform_secondary_action ───
  perform_secondary_action: {
    description: `Invoke a secondary accessibility action exposed by an element.`,
    parameters: {
      type: "object",
      properties: {
        elementIndex: {
          type: "number",
          description: "Element identifier",
        },
        actionName: {
          type: "string",
          description: "Secondary accessibility action name",
        },
      },
      required: ["elementIndex", "actionName"],
      additionalProperties: false,
    },
  },

  // ─── Tool 5: set_value ───
  set_value: {
    description: `Set the value of a settable accessibility element.`,
    parameters: {
      type: "object",
      properties: {
        elementIndex: {
          type: "number",
          description: "Element identifier",
        },
        value: {
          type: "string",
          description: "Value to set",
        },
      },
      required: ["elementIndex", "value"],
      additionalProperties: false,
    },
  },

  // ─── Tool 6: scroll ───
  scroll: {
    description: `Scroll an element in a direction by a number of pages.`,
    parameters: {
      type: "object",
      properties: {
        elementIndex: {
          type: "number",
          description: "Element identifier",
        },
        direction: {
          type: "string",
          description: "Scroll direction: up, down, left, or right",
          enum: ["up", "down", "left", "right"],
        },
        pages: {
          type: "number",
          description: `Number of pages to scroll. Fractional values are
supported. Defaults to 1.`,
        },
      },
      required: ["elementIndex", "direction"],
      additionalProperties: false,
    },
  },

  // ─── Tool 7: drag ───
  drag: {
    description: `Drag from one point to another using pixel coordinates.`,
    parameters: {
      type: "object",
      properties: {
        startX: {
          type: "number",
          description: "Start X coordinate",
        },
        startY: {
          type: "number",
          description: "Start Y coordinate",
        },
        endX: {
          type: "number",
          description: "End X coordinate",
        },
        endY: {
          type: "number",
          description: "End Y coordinate",
        },
      },
      required: ["startX", "startY", "endX", "endY"],
      additionalProperties: false,
    },
  },

  // ─── Tool 8: press_key ───
  press_key: {
    description: `Press a key or key-combination on the keyboard, including
modifier and navigation keys.
  - This supports xdotool's \`key\` syntax.
  - Examples: "a", "Return", "Tab", "super+c", "Up", "KP_0"
    (for the numpad 0 key).`,
    parameters: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Key or key combination to press",
        },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },

  // ─── Tool 9: type_text ───
  type_text: {
    description: `Type literal text using keyboard input.`,
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Literal text to type",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
};
```

### 3.2 支持的所有按键（从 xdotool key syntax）

从 SkyComputerUseService 二进制 strings 提取的完整按键列表：

```
可打印字符: a-z, 0-9, Space, Tab
特殊键:
  BackSpace, Linefeed, Clear, Return, Escape, Delete,
  Pause, Scroll_Lock, Sys_Req

导航键:
  Back, Home, Left, Right, Up, Down,
  Prior (Page_Up), Next (Page_Down), Begin, End

功能键:
  Insert, Menu, Help, Select, Print, Execute,
  Undo, Redo, Find, Cancel, Break, Mode_switch,
  script_switch, Num_Lock

小键盘:
  KP_Delete, KP_Enter, KP_Equal, KP_Multiply,
  KP_Add, KP_Subtract, KP_Decimal, KP_Divide,
  KP_0 ~ KP_9, KP_Space, KP_Tab,
  KP_F1 ~ KP_F4,
  KP_Home, KP_Left, KP_Up, KP_Right, KP_Down,
  KP_Prior, KP_Next, KP_End, KP_Begin,
  KP_Insert, KP_Separator

修饰键:
  Shift_L/R, Control_L/R, Meta_L/R, Alt_L/R, Super_L/R,
  Caps_Lock, Shift_Lock, Hyper_L/R

修饰键简写（用于组合）:
  ctrl, shift, super, meta, alt, command
  // 例如: "ctrl+c", "super+v", "command+q"
```

---

## 4. 权限系统

### 4.1 系统权限（macOS）

```swift
// CUAServicePermissionState (从 strings 还原)
class CUAServicePermissionState: Observable {
  private var _isAccessibilityGranted: Bool
  private var _isScreenRecordingGranted: Bool
  private var _activePermissionRequest: Bool
  private var _inProgressPermission: Bool

  // Accessibility 权限检查
  // → AXIsProcessTrusted() 或检查 TCC.db
  var isAccessibilityGranted: Bool { ... }

  // Screen Recording 权限检查
  // → CGPreflightScreenCaptureAccess() 或检查 TCC.db
  var isScreenRecordingGranted: Bool { ... }

  // 权限状态枚举
  enum PermissionState {
    case notGranted         // 未授权
    case inProgress         // 正在请求中
    case granted            // 已授权
  }
}
```

### 4.2 权限窗口（SwiftUI）

```swift
// CUAServicePermissionsWindow
// 当权限未授予时显示引导窗口

struct PermissionsWindowContent {
  let title = "Enable Codex Computer Use"
  let description = """
    Codex Computer Use needs these permissions to use apps on your Mac.
    These permissions are only used when you ask Codex to perform tasks.
    """

  let accessibilityRow = PermissionRow(
    title: "Accessibility",
    description: "Allows Codex to access app interfaces"
  )

  let screenRecordingRow = PermissionRow(
    title: "Screen Recording",
    description: "Codex uses screenshots to know where to click"
  )

  let actionButton = "COMPLETE IN SYSTEM SETTINGS"
  // → 打开 com.apple.settings.PrivacySecurity.extension
}
```

### 4.3 应用级审批

```swift
// AppApprovalStore (基于 SQLite)
class AppApprovalStore {
  let storageURL: URL
  var sessionApprovedBundleIdentifiers: Set<String>
  var persistentApprovals: [Approval]
  var persistentApprovalsModificationDate: Date

  var approvedBundleIdentifiers: [String] {
    // sessionApproved + 未过期的 persistentApprovals
  }

  // SQLite schema (推测)
  // CREATE TABLE approvals (
  //   bundle_id TEXT PRIMARY KEY,
  //   approved_at INTEGER,
  //   persistence TEXT CHECK(persistence IN ('session','forever','timed')),
  //   expiry INTEGER
  // );
}

// CodexAppServerComputerUsePolicyProvider
class ComputerUsePolicyProvider {
  let timeout: TimeInterval
  var cachedPolicy: Policy?
  var cachedAt: Date?

  var allowed_bundle_ids: [String]
  var denied_bundle_ids: [String]
  var allow_persistent_approval: Bool
  var optOutNotificationMethods: [String]
}

// 审批流程
const approvalFlow = {
  // 1. 检查硬编码阻止列表
  blockedList: [
    "com.1password.1password",
    "com.1password.safari",
    "com.bitwarden.desktop",
    "com.dashlane.dashlanephonefinal",
    "com.lastpass.LastPass",
    "com.nordsec.nordpass",
    "me.proton.pass.electron",
    "me.proton.pass.catalyst",
  ],
  // → "Computer Use is blocked from using the app 'X' by your organization's policy."

  // 2. 检查持久化审批
  persistentApprovalCheck: {
    // 从 SQLite 读取，检查是否过期
  },

  // 3. MCP 即时审批（elicitation）
  mcpElicitation: {
    question: "Allow Codex to use {appName}?",
    warning: `Allowing Codex to use this app introduces new risks,
including those related to prompt injection attacks, such as data
theft or loss. Carefully monitor Codex while it uses this app.`,
    options: ["allow_once", "allow_always", "deny"],
  },

  // 4. 拒绝处理
  onDeny: {
    message: "Computer Use approval denied via MCP elicitation for app 'X'",
    // 本次会话不再询问
  },

  // 5. 持久化保存失败
  persistError: {
    message: "Computer Use could not persist the approval permanently for app 'X'",
  },
};
```

---

## 5. 进程间通信

### 5.1 JSON-RPC 连接（Client → Service）

```swift
// CodexAppServerJSONRPCConnection
class CodexAppServerJSONRPCConnection {
  var process: Process          // 子进程引用
  var outputPipe: Pipe          // stdout 管道
  var readerTask: Task          // 异步读取任务
  var lineBuffer: JSONRPCLineBuffer  // 行缓冲

  // 协议: JSON-RPC 2.0 over stdin/stdout
  // 每行一个 JSON 消息
  // 帧格式: Content-Length: <N>\r\n\r\n<JSON>

  // 错误处理:
  // - "Codex appserver IPC connection closed before a complete frame was read"
  // - "Codex appserver IPC frame is too large: {size}"
  // - "Failed to connect to Codex appserver IPC socket: {error}"
  // - "Codex appserver IPC socket path is too long: {path}"
  // - "Failed to create Codex appserver IPC socket: {error}"
}

// JSONRPCLineBuffer
class JSONRPCLineBuffer {
  var waiter: UnsafeMutablePointer<...>
  // 行缓冲，用于拼装跨多个 read() 的 JSON 消息
}
```

### 5.2 Apple Events（进程间方法调用）

SkyComputerUseClient 通过 Apple Events 调用 SkyComputerUseService 的方法：

```
Client → Service (Apple Event):
  ├── getFrontmostWindow
  │   → 获取最前窗口信息
  │
  ├── get_app_state(bundleIdentifier)
  │   → 截图 + accessibility tree
  │
  ├── click(elementIndex / coords)
  │   → AXUIElementPerformAction / CGEventPost
  │
  ├── type_text(text)
  │   → CGEventCreateKeyboardEvent + CGEventPost
  │
  └── ... (其他 MCP Tool 调用)

错误处理:
  - "Could not get sender PID from Apple event"
  - "Sender process is not authenticated"
  - "Apple event error {code}"
  - "Could not get response data"
  - "Could not find Service app"
```

### 5.3 Session 追踪

```swift
// CodexComputerUseSessionTracker
class CodexComputerUseSessionTracker {
  var bundleIDsByConversationID: [String: Set<String>]
  // 追踪每个对话使用的 app bundle IDs
  // key: conversationID, value: 已审批的 bundle IDs
}

// CodexAppServerThreadEventObserver
class CodexAppServerThreadEventObserver {
  var connectionQueue: DispatchQueue
  // 监听事件: "thread-stream-state-changed"
  // 回调: onTurnEnded()
  // → 通知 Service 当前 turn 结束
  // → 自动停止 session（每个 assistant turn 后重置）
}
```

---

## 6. 遥测系统

### 6.1 事件上报

```typescript
// 上报地址
const TELEMETRY_URL = "https://chatgpt.com/ces/v1/rgstr";
const TELEMETRY_HEADER = "X-OpenAI-Authorization";

// Protobuf 格式
const EVENT_ENVELOPE = "protobuf_analytics_events.v1.AnalyticsEventEnvelope";

// 事件类型:
enum ComputerUseEvent {
  CodexComputerUseAppStartup = "cua_service_launched",
  CodexComputerUseIdleTimeoutReached = "cua_service_idle_timeout_reached",
  CodexComputerUsePermissionGrantFinished = "cua_service_permission_grant_finished",
  CodexComputerUsePermissionWindowShown = "cua_service_permission_window_shown",
  CodexComputerUsePermissionRequested = "cua_service_permission_requested",
  CodexComputerUseMcpServerLaunched = "computer_use_mcp_server_launched",
  CodexComputerUseMcpToolCalled = "computer_use_mcp_tool_called",
  CodexComputerUseMcpAppApprovalRequested = "computer_use_mcp_app_approval_requested",
  CodexComputerUseMcpAppApprovalResolved = "computer_use_mcp_app_approval_resolved",
  CodexComputerUseStarted = undefined,  // 会话开始
  CodexComputerUseEnded = undefined,     // 会话结束
  CodexComputerUseIpcRequestFailed = undefined,  // IPC 失败
}

// 每个事件包含:
// - StatsigUser (用户标识)
// - StatsigMetadata (实验分组)
// - ClientMetadata (客户端信息)
// - AnalyticsEventUserParams (用户参数)
// - AnalyticsEventDeviceParams (设备参数)

// Turn Metrics (性能指标):
const turnMetrics = {
  computer_use_mcp_time_to_first_get_app_state: number,   // 首次 get_app_state 耗时
  computer_use_mcp_time_to_first_write: number,           // 首次写入操作耗时
  computer_use_mcp_time_from_first_get_app_state_to_first_write: number,
};
```

---

## 7. Turn 生命周期

### 7.1 完整工作流

```
用户: "帮我在 Spotify 搜索 Discover Weekly"

┌── Turn 开始 ──────────────────────────────────────────────┐
│                                                            │
│ 1. LLM 读取 SKILL.md                                       │
│    → 学习: get_app_state 每轮必须首先调用                    │
│    → 学习: element index 优于 pixel coordinate             │
│    → 学习: 每次操作后验证结果                               │
│                                                            │
│ 2. MCP Tool Call: list_apps                                │
│    → Client → Service: 获取应用列表                         │
│    → NSWorkspace.runningApplications                       │
│    → 最近 14 天使用记录                                    │
│    ← [{ Spotify: { bundleId: "com.spotify.client",         │
│                    running: true, ... } }]                 │
│                                                            │
│ 3. MCP Tool Call: get_app_state(app="Spotify")             │
│    → 检查审批状态 (首次使用需用户批准)                       │
│    → 启动/激活 Spotify                                     │
│    → AXUIElement 获取 key window 的 accessibility tree     │
│    → SCShareableContent / CGWindowListCreateImage 截图     │
│    ← {                                                     │
│        screenshot: "base64...",                            │
│        accessibilityTree: [                                │
│          { index: 0, role: "AXWindow", ... },              │
│          { index: 1, role: "AXToolbar", ... },             │
│          { index: 42, role: "AXTextField",                 │
│            description: "Search", ... },                   │
│          ...                                               │
│        ],                                                  │
│        appInfo: { bundleIdentifier, windowTitle },         │
│      }                                                     │
│                                                            │
│ 4. LLM 分析截图 + accessibility tree                        │
│    → 找到 Search 文本框 (index=42)                          │
│                                                            │
│ 5. MCP Tool Call: click(elementIndex=42)                   │
│    → Service → AXUIElementPerformAction(index42, "press")  │
│    ← "Action completed. Call get_app_state..."             │
│                                                            │
│ 6. MCP Tool Call: get_app_state(app="Spotify")             │
│    → 验证搜索框已获得焦点                                   │
│                                                            │
│ 7. MCP Tool Call: type_text(text="Discover Weekly")        │
│    → Service → CGEventCreateKeyboardEvent + CGEventPost    │
│    ← "Action completed."                                   │
│                                                            │
│ 8. MCP Tool Call: press_key(key="Return")                  │
│    → Service → CGEventPost                                  │
│                                                            │
│ 9. MCP Tool Call: get_app_state(app="Spotify")             │
│    → 验证搜索结果已加载                                     │
│    → LLM 在 accessibility tree 中找到播放按钮               │
│                                                            │
│ 10. MCP Tool Call: click(elementIndex=...)                 │
│     → 点击播放                                              │
│                                                            │
│ 11. onTurnEnded → Service 自动停止 session                  │
│                                                            │
└── Turn 结束 ──────────────────────────────────────────────┘
```

### 7.2 错误处理

```typescript
const COMPUTER_USE_ERRORS = {
  // 权限错误
  PERMISSIONS_PENDING: `Computer Use permissions are still pending.
The user has not finished granting Accessibility and Screen Recording
permissions in the Codex Computer Use window. Call this tool again,
as the user is almost done finishing granting permissions. Do not
end your turn yet, just call this tool again.`,

  PERMISSIONS_NOT_GRANTED: `Computer Use permissions are not granted.`,

  // Session 状态错误
  NOT_ACTIVE: `Computer Use is not active for '{app}'. You first must
call \`get_app_state\` to get the latest state before doing other
Computer Use actions.`,

  // 版本不匹配
  VERSION_MISMATCH: `The Computer Use server and client have a version
mismatch. To use Computer Use, ask the user to relaunch their Codex
app so that the client will be updated to the latest version.`,

  // URL 限制
  URL_BLOCKED: `This session has been stopped because Computer Use is
not allowed on the current browser URL.`,

  // 用户停止
  SESSION_STOPPED: `This application session has been explicitly stopped
by the user for this turn. Stop your work and send a final message noting
they stopped the session. Computer Use can be used again in the next
assistant turn.`,

  // 安全阻止
  APP_BLOCKED: `Computer Use is not allowed to use the app 'X' for
safety reasons.`,

  // 应用未运行
  APP_NOT_FOUND: `Running application not found: {app}`,

  // Accessibility 错误
  AX_ERROR: `Accessibility error: {error}`,
  // AXError 枚举值:
  // apiDisabled, actionUnsupported, attributeUnsupported,
  // illegalArgument, invalidUIElement, invalidUIElementObserver,
  // cannotComplete, notEnoughPrecision, notImplemented,
  // notificationAlreadyRegistered, notificationNotRegistered,
  // notificationUnsupported, parameterizedAttributeUnsupported
};
```

---

## 8. 应用特定指令 (AppInstructions)

### 8.1 内置指令集

| 应用 | 特殊指令 |
|------|----------|
| **Spotify** | 播放状态不会立即更新，先 `get_app_state` 验证；搜索前确保搜索框已聚焦；需要等待网络响应 |
| **Notion** | (专用指令) |
| **Numbers** | (专用指令) |
| **Clock** | (专用指令) |
| **Apple Music** | (专用指令) |
| **iPhone Mirroring** | (专用指令) |

### 8.2 指令分发机制

```swift
// AppInstructionDeliveryState
class AppInstructionDeliveryState {
  var bundleIdentifiersWithDeliveredInstructions: Set<String>

  // 首次使用某个 app 时，从 Package_ComputerUseClient.bundle
  // 读取对应的 AppInstructions/{AppName}.md
  // 注入到 MCP tool description 的 <app_specific_instructions> 标签中

  // MCP tool description 模板:
  // "... Computer Use state (CUA App Version: {version})
  //  <app_specific_instructions>
  //  {AppInstructions 内容}
  //  </app_specific_instructions>"
}
```

---

## 9. 键盘布局处理

```swift
// 键盘布局感知
// 从 System/Library/PrivateFrameworks 和 /System/Library/Frameworks
// 动态加载键盘布局相关 framework
// 路径搜索:
//   /System/Library/PrivateFrameworks/{name}.framework
//   /System/Library/Frameworks/{name}.framework/Versions/C/
//   /usr/lib/system/lib{name}.dylib

// type_text 需要键盘布局来映射字符到 CGKeyCode
// 如果无法获取: "Unable to get current keyboard layout."
// 如果字符无对应键码: "Could not find key code for character: %C"

// CGEvent 结构:
// <SAIVirtualKeyPress: keyCode, flags, characters>
```

---

## 10. 安全边界总结

| 层级 | 机制 | 绕过难度 |
|------|------|----------|
| **macOS TCC** | Accessibility + Screen Recording 权限 | 高（需用户授权） |
| **代码签名** | Team ID `2DC432GLL2` (OpenAI) | 高（需 Apple 证书） |
| **父进程验证** | `.coderequirement` plist | 中（需同 Team ID） |
| **Apple Event 验证** | 发件人 bundle ID + audit token | 中 |
| **密码管理器阻止** | 硬编码 bundle ID 黑名单 | 低（改名可绕过） |
| **应用审批** | SQLite + MCP elicitation | 低（依赖用户决策） |
| **Session 隔离** | bundleIDsByConversationID | 中（服务端控制） |
| **URL 限制** | 浏览器 URL 白名单 | 中 |
| **遥测** | Protobuf → chatgpt.com | 数据隐私风险 |
| **空闲超时** | inactivityTask | 服务端配置 |
