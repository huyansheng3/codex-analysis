# Codex 原生模块深度逆向

> 来源：`.node` 文件 nm 符号导出、JS wrapper 代码、原生可执行文件 strings 分析
> 版本：26.506.31421 (Build 2620)

---

## 1. objc-js：完整的 Objective-C 运行时桥接

**文件**：`node_modules/objc-js/`
- Native: `prebuilds/darwin-arm64/node.napi.armv8.node` (639 KB)
- JS Wrapper: `dist/index.js` (29 KB)

这是 Codex 最强大的原生模块，提供 JS ↔ Objective-C 的完整双向桥接。

### 1.1 架构概览

```
JavaScript (Node.js)
  │
  ├── NobjcLibrary (Proxy) ─── dlopen() 任意 .dylib/.framework
  ├── NobjcObject (Proxy)  ─── NSClassFromString() + objc_msgSend()
  ├── NobjcProtocol.implement() ─── 在 JS 中实现 ObjC 协议
  ├── NobjcClass.define()  ─── 运行时创建新 ObjC 类
  ├── callFunction()       ─── dlsym() + libffi 调用任意 C 函数
  ├── RunLoop              ─── CFRunLoopRun() / CFRunLoopStop()
  └── getPointer/fromPointer ─── 原始指针操作
```

### 1.2 Native 层导出函数

从 `nm -gU node.napi.armv8.node` 提取：

```c
// 动态库加载
napi_value LoadLibrary(napi_env, napi_callback_info);
// → dlopen(path, RTLD_LAZY)

// 类/对象操作
napi_value GetClassObject(napi_env, napi_callback_info);
// → NSClassFromString(className) → NobjcObject

napi_value GetPointer(napi_env, napi_callback_info);
// → 从 NobjcObject 提取原始指针为 Node Buffer

napi_value FromPointer(napi_env, napi_callback_info);
// → 从 Buffer/BigInt 重建 NobjcObject

// Protocol 和 Class 创建
napi_value CreateProtocolImplementation(napi_env, napi_callback_info);
// → 在 ObjC Runtime 中注册新 Protocol 实现

napi_value DefineClass(napi_env, napi_callback_info);
// → objc_allocateClassPair() + objc_registerClassPair()

// C 函数调用
napi_value CallFunction(napi_env, napi_callback_info);
// → dlsym(RTLD_DEFAULT, name) → libffi 调用

napi_value CallSuper(napi_env, napi_callback_info);
// → objc_msgSendSuper()

// RunLoop
napi_value PumpRunLoop(napi_env, napi_callback_info);
// → CFRunLoopRunInMode(kCFRunLoopDefaultMode, seconds, true)
```

### 1.3 C++ 核心类结构

从符号重建：

```cpp
// ObjcObject: 包装任意 ObjC id
class ObjcObject {
  id _object;  // 被包装的 ObjC 对象
  bool _owns;  // 是否持有所有权

  // 消息发送（慢路径：每次查找 selector + signature）
  static napi_value $MsgSend(napi_env, napi_callback_info);

  // 检查 selector 是否存在
  static napi_value $RespondsToSelector(napi_env, napi_callback_info);

  // 快速路径：缓存 selector + method signature
  static napi_value $PrepareSend(napi_env, napi_callback_info);
  static napi_value $MsgSendPrepared(napi_env, napi_callback_info);
};

// 类型转换系统 (bridge.h)
// ObjC type encodings: c, i, s, l, q, C, I, S, L, Q, f, d, B, *, :, @, #, ^, {, (
// 完整支持 struct 编码解析（如 {CGRect={CGPoint=dd}{CGSize=dd}}）
// Buffer/TypedArray 用于指针类型（^v, ^i, ^{...}）

// Block 回调
void BlockInvokeCallback(/* libffi cif, args */);
void BlockTSFNCallback(/* N-API ThreadSafe Function */);
void FallbackToTSFN(/* ... */);

// Protocol 实现
void ForwardInvocation(void *self, SEL _cmd, NSInvocation *invocation);
BOOL RespondsToSelector(void *self, SEL _cmd, SEL selector);
NSMethodSignature *MethodSignatureForSelector(void *self, SEL _cmd, SEL selector);
void DeallocImplementation(void *self, SEL _cmd);
```

### 1.4 JS 层 API 重建

```typescript
// === NobjcLibrary ===
// 延迟加载动态库的 Proxy
class NobjcLibrary {
  constructor(path: string);
  // Proxy: library.$SymbolName → dlsym + 类型转换
  // 支持: 函数、全局变量、常量
}

// === NobjcObject ===
// 包装 ObjC 对象的 Proxy
class NobjcObject {
  constructor(className: string, ...args: unknown[]);
  // Proxy: obj.$methodName(arg1, arg2) → objc_msgSend 调用
  // methodName → selector: 每个 $ → 下一个字母大写 + :
  // 例如: obj.$setFrame$display() → [obj setFrame:arg1 display:arg2]

  // 性能优化 API
  $prepareSend(methodName: string): PreparedSend;
  $respondsToSelector(selector: string): boolean;

  // 类型转换
  static fromPointer(ptr: Buffer | BigInt): NobjcObject;
  getPointer(): Buffer;
}

// === NobjcProtocol ===
class NobjcProtocol {
  static implement(protocolName: string, implementation: Record<string, Function>): ProtocolImpl;
}

// === NobjcClass ===
class NobjcClass {
  static define(options: {
    className: string;
    superclass?: string;
    protocols?: string[];
    methods?: Record<string, {
      types: string;  // ObjC type encoding
      implementation: Function;
    }>;
  }): NobjcClass;
  static super(obj: NobjcObject): SuperProxy;
}

// === C 函数调用 ===
function callFunction(
  name: string,
  ...args: unknown[]
): unknown;
// → dlsym(RTLD_DEFAULT, name) → libffi call
// 类型自动推断

function callVariadicFunction(
  name: string,
  options: { returns?: string; args?: string[] },
  ...args: unknown[]
): unknown;
// 可变参数版本（ARM64 需要不同调用约定）

// === RunLoop ===
const RunLoop = {
  pump(seconds?: number): void;  // CFRunLoopRunInMode
  run(): void;                   // CFRunLoopRun
  stop(): void;                  // CFRunLoopStop
};
```

### 1.5 安全分析

```typescript
// ⚠️ CRITICAL: objc-js 提供了几乎无限制的系统访问

// 任意动态库加载
const Security = new NobjcLibrary("/System/Library/Frameworks/Security.framework/Security");

// 任意类实例化
const NSAppleScript = new NobjcObject("NSAppleScript", 'tell app "Finder" to ...');
const NSProcessInfo = new NobjcObject("NSProcessInfo");

// 任意 ObjC 消息发送
someObject.$launchApplicationAtURL$options$configuration$error$(
  appURL, options, config, errorPtr
);

// 任意 C 函数调用
callFunction("system", "rm -rf /");  // (理论上可能)

// 创建新的 ObjC 类（运行时修改）
NobjcClass.define({
  className: "MyHookedClass",
  superclass: "NSApplication",
  // 可 hook/monkey-patch 系统类
});

// Protocol 实现（可劫持回调）
NobjcProtocol.implement("NSApplicationDelegate", {
  applicationDidFinishLaunching: (notification) => {
    // 注入代码
  },
});
```

**攻击面**：
1. 任何能够调用 objc-js 的代码都拥有相当于应用程序本身的权限
2. 没有 API 白名单——所有 ObjC 类、消息、C 函数和动态库都可访问
3. 运行时类创建和 Protocol 实现允许 hook/劫持系统行为
4. `fromPointer` 可从未知指针重建 ObjC 对象，绕过类型安全

---

## 2. better-sqlite3：本地数据库

**文件**：`node_modules/better-sqlite3/build/Release/better_sqlite3.node` (1.9 MB)
**JS Wrapper**：`lib/database.js` + `lib/methods/*.js`

### 2.1 Native 类结构

```cpp
// Database - 核心数据库类
class Database {
  // 构造/析构
  static napi_value JS_new(napi_env, napi_callback_info);
  static napi_value JS_open(napi_env, napi_callback_info);
  static napi_value JS_close(napi_env, napi_callback_info);

  // 执行
  static napi_value JS_exec(napi_env, napi_callback_info);     // exec(sql)
  static napi_value JS_prepare(napi_env, napi_callback_info);  // prepare(sql) → Statement

  // 扩展
  static napi_value JS_function(napi_env, napi_callback_info);   // 注册自定义 SQL 函数
  static napi_value JS_aggregate(napi_env, napi_callback_info);  // 注册自定义聚合函数
  static napi_value JS_loadExtension(napi_env, napi_callback_info);
  // ⚠️ 可加载任意 SQLite 扩展

  // 备份/序列化
  static napi_value JS_backup(napi_env, napi_callback_info);
  static napi_value JS_serialize(napi_env, napi_callback_info);
  // ⚠️ 可将整个数据库序列化到内存

  // 表
  static napi_value JS_table(napi_env, napi_callback_info);  // 虚拟表

  // 配置
  static napi_value JS_unsafeMode(napi_env, napi_callback_info);
  // ⚠️ unsafeMode 禁用安全检查
  static napi_value JS_defaultSafeIntegers(napi_env, napi_callback_info);
  static napi_value JS_inTransaction(napi_env, napi_callback_info);
};

// Statement - 预编译语句
class Statement {
  static napi_value JS_new(napi_env, napi_callback_info);
  static napi_value JS_run(napi_env, napi_callback_info);     // run()
  static napi_value JS_get(napi_env, napi_callback_info);     // get() → 单行
  static napi_value JS_all(napi_env, napi_callback_info);     // all() → 所有行
  static napi_value JS_iterate(napi_env, napi_callback_info); // iterate() → 迭代器
  static napi_value JS_bind(napi_env, napi_callback_info);
  static napi_value JS_columns(napi_env, napi_callback_info);
  static napi_value JS_raw(napi_env, napi_callback_info);
  static napi_value JS_pluck(napi_env, napi_callback_info);
  static napi_value JS_expand(napi_env, napi_callback_info);
  static napi_value JS_safeIntegers(napi_env, napi_callback_info);
};

// Backup - 数据库备份
class Backup {
  static napi_value JS_new(napi_env, napi_callback_info);
  static napi_value JS_transfer(napi_env, napi_callback_info);  // transfer(pages)
  static napi_value JS_close(napi_env, napi_callback_info);
};
```

### 2.2 JS API 重建

```typescript
interface DatabaseOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  timeout?: number;
  nativeBinding?: string;
}

class Database {
  constructor(path: string, options?: DatabaseOptions);
  name: string;
  open: boolean;
  inTransaction: boolean;
  readonly: boolean;
  memory: boolean;

  prepare(sql: string): Statement;
  exec(sql: string): this;
  pragma(source: string, options?: { simple?: boolean }): unknown;

  // 自定义函数
  function(name: string, options: FunctionOptions, fn: (...args: unknown[]) => unknown): this;
  aggregate(name: string, options: AggregateOptions): this;

  // 备份
  backup(destPath: string, options?: { attached?: string; progress?: (info: BackupInfo) => void }): Promise<void>;

  // 序列化
  serialize(options?: { attached?: string }): Buffer;
  // ⚠️ 将整个 DB 序列化到内存，可被窃取

  // 扩展
  loadExtension(path: string, entryPoint?: string): this;
  // ⚠️ 加载任意 .dylib 扩展

  // ⚠️ 安全模式
  unsafeMode(unsafe?: boolean): this;
  // 禁用所有安全保护

  defaultSafeIntegers(toggleState?: boolean): this;

  // 虚拟表
  table(name: string, options: VirtualTableOptions): this;

  close(): void;
}

class Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
  bind(...params: unknown[]): this;
  columns(): ColumnDefinition[];
  raw(toggleState?: boolean): this;
  pluck(toggleState?: boolean): this;
  expand(toggleState?: boolean): this;
  safeIntegers(toggleState?: boolean): this;
}
```

### 2.3 存储的 SQLite 完整 API

系统静态链接了完整的 SQLite3 C API（400+ 符号）：

- `sqlite3_open_v2`, `sqlite3_prepare_v2`, `sqlite3_step`, `sqlite3_exec`
- `sqlite3_load_extension` ⚠️ 扩展加载
- `sqlite3_serialize` / `sqlite3_deserialize` ⚠️ 内存序列化
- `sqlite3_blob_open` / `sqlite3_blob_read` / `sqlite3_blob_write` ⚠️ BLOB 直接读写
- `sqlite3_set_authorizer` — 访问控制钩子
- `sqlite3_trace_v2` — SQL 追踪
- `sqlite3_update_hook` / `sqlite3_commit_hook` / `sqlite3_rollback_hook`
- `sqlite3_create_module` — 虚拟表模块
- `sqlite3_db_config` — 数据库配置
- RTREE 扩展: `sqlite3_rtree_geometry_callback`, `sqlite3_rtree_query_callback`

---

## 3. node-pty：伪终端

**文件**：`node_modules/node-pty/build/Release/pty.node` (105 KB)

### 3.1 Native 导出函数

```c
napi_value PtyFork(napi_env, napi_callback_info);
// → fork() + setsid() + ioctl(TIOCSCTTY) + exec()

napi_value PtyOpen(napi_env, napi_callback_info);
// → posix_openpt() + grantpt() + unlockpt()

napi_value PtyResize(napi_env, napi_callback_info);
// → ioctl(TIOCSWINSZ) 设置 cols/rows

napi_value PtyGetProc(napi_env, napi_callback_info);
// → 获取 PTY 关联的进程名

napi_value SetupExitCallback(napi_env, napi_callback_info);
// → 注册子进程退出回调
```

### 3.2 JS API

```typescript
interface PtyOptions {
  name?: string;
  cols?: number;
  rows?: number;
  uid?: number;
  gid?: number;
  cwd?: string;
  env?: Record<string, string>;
  encoding?: string;
  handleFlowControl?: boolean;
}

class UnixTerminal extends EventEmitter {
  pid: number;
  fd: number;
  process: string;
  ptsName: string;

  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  destroy(): void;

  // 流控制 (XON/XOFF)
  pause(): void;
  resume(): void;
  end(): void;
  pipe(dest: WritableStream): void;

  onData: (data: string) => void;
  onExit: (exitCode: number, signal?: string) => void;
}
```

---

## 4. sparkle.node：自动更新

**文件**：`/Applications/Codex.app/Contents/Resources/native/sparkle.node` (Mach-O bundle, arm64)

### 4.1 ObjC 类

```objc
// 从符号重建
@interface CodexSparkleDelegate : NSObject <SPUStandardUserDriverDelegate, SPUUpdaterDelegate>
@end
```

### 4.2 Native 导出函数

```c
napi_value Init(napi_env, napi_callback_info);
// → 创建 SPUUpdater + SPUStandardUserDriver

napi_value CheckForUpdates(napi_env, napi_callback_info);
napi_value CheckForUpdatesInBackground(napi_env, napi_callback_info);
napi_value InstallUpdatesIfAvailable(napi_env, napi_callback_info);

napi_value SetLogSink(napi_env, napi_callback_info);
// → 注册 JS 日志回调

napi_value SetUpdateReadySink(napi_env, napi_callback_info);
// → 注册 JS "更新就绪"回调

napi_value SetUpdateLifecycleStateSink(napi_env, napi_callback_info);
// → 注册 JS 更新状态回调
```

### 4.3 SPUUpdaterDelegate 方法

```objc
// Sparkle 委托方法（完整列表，从符号中提取）
- (NSSet<NSString *> *)allowedChannelsForUpdater:(SPUUpdater *)updater;
- (NSURL *)feedURLStringForUpdater:(SPUUpdater *)updater;
- (NSSet<NSString *> *)allowedSystemProfileKeysForUpdater:(SPUUpdater *)updater;
- (NSString *)decryptionPasswordForUpdater:(SPUUpdater *)updater;
- (id<SUVersionComparison>)versionComparatorForUpdater:(SPUUpdater *)updater;
- (void)bestValidUpdateInAppcast:(SUAppcast *)appcast forUpdater:(SPUUpdater *)updater;
- (BOOL)standardUserDriverShouldHandleShowingScheduledUpdate:(id<SPUStandardUserDriver>)userDriver;
- (void)standardUserDriverWillShowModalAlert:(id<SPUStandardUserDriver>)userDriver;
- (void)standardUserDriverWillFinishUpdateSession:(id<SPUStandardUserDriver>)userDriver;
- (BOOL)supportsGentleScheduledUpdateReminders;
```

### 4.4 Sparkle Feed 配置

```typescript
// 从 package.json
const sparkleFeedUrl = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";
const sparklePublicKey = "rhcBvttuqDFriyNqwTQJR3L4UT1WjIK4QxtwtwusVic=";

// Computer Use 子应用的更新 Feed
const cuaFeedUrl = "https://oaisidekickupdates.blob.core.windows.net/mac/cua/alpha/appcast.xml";
const cuaPublicKey = "5Yw9jMXMH6O3mJZmpFuQT6ECfC3ZKBfVjWUVMNrElRo=";
```

---

## 5. browser-use-peer-authorization.node：代码签名验证

**文件**：`/Applications/Codex.app/Contents/Resources/native/browser-use-peer-authorization.node`

### 5.1 导出函数

```c
// 使用 Touch ID 进行授权
napi_value extension_host_prompt_touch_id(const char *purpose);

// 获取审计令牌的代码签名身份
napi_value extension_host_copy_code_identity_for_audit_token(audit_token_t token);

// 获取指定深度的代码签名身份
napi_value extension_host_copy_code_identity_for_audit_token_at_depth(audit_token_t token, int depth);
```

### 5.2 验证链

```typescript
// 使用 macOS Security Framework 验证对等进程身份
// 1. Unix Domain Socket 连接时获取对等的 LOCAL_PEERTOKEN
// 2. 调用 SecCodeCopyGuestWithAttributes 获取 signingIdentifier
// 3. 验证 bundle ID 是否在允许列表中

const ALLOWED_BUNDLE_IDS = [
  "com.openai.codex",
  "com.openai.codex.agent",
  "com.openai.codex.alpha",
  "com.openai.codex.beta",
  "com.openai.codex.dev",
  "com.openai.codex.nightly",
  "com.openai.codex.owl",
  "com.openai.codex.runtime",
];

const ALLOWED_TEAM_ID = "2DC432GLL2";  // OpenAI Team ID

// 错误类型：
// - "missing-code-signing-identity": 对等进程没有代码签名
// - "untrusted-code-signing-identity": 签名不在允许列表中
```

---

## 6. remote-control-device-key.node：Secure Enclave 密钥

**文件**：`/Applications/Codex.app/Contents/Resources/native/remote-control-device-key.node`

### 6.1 导出函数

```c
napi_value createDeviceKey(napi_env, napi_callback_info);
napi_value deleteDeviceKey(napi_env, napi_callback_info);
napi_value getDeviceKeyPublic(napi_env, napi_callback_info);
napi_value signDeviceKey(napi_env, napi_callback_info);
```

### 6.2 密钥保护策略

```typescript
type KeyProtection =
  | "hardware_secure_enclave"    // Secure Enclave (硬件隔离)
  | "os_protected_nonextractable" // OS 级别保护，不可导出
  | "hardware_only";             // 仅硬件
// 默认: hardware_secure_enclave

// 密钥类型: ECDSA P-256 (ecdsa_p256_sha256)
// 公钥格式: SPKI DER Base64
// 存储: NSUserDefaults / Keychain
// Key ID: dk_hse_<id> (Secure Enclave) 或 dk_osn_<id> (OS 保护)
// Bundle ID: com.openai.codex.device-key.<protection>.<id>
```

---

## 7. bare-modifier-monitor：修饰键监控

**文件**：`/Applications/Codex.app/Contents/Resources/native/bare-modifier-monitor`

### 7.1 功能

监控裸修饰键按下（单独按下 Option/Command/Control 而不与其他键组合）：

```typescript
// 使用 CoreGraphics 事件 API
// 支持的模式:
//   --immediate       → 立即触发
//   --trigger-on-release → 释放时触发（默认）
//   --release-modifiers <modifiers> → 手动释放修饰键

enum BareModifierKey {
  LeftOption = "LeftOption",
  RightOption = "RightOption",
  LeftCommand = "LeftCommand",
  DoubleCommand = "DoubleCommand",
  RightCommand = "RightCommand",
  LeftControl = "LeftControl",
}

enum ReleaseModifier {
  Command = "command",
  Control = "control",
  Alternate = "alternate",
  Shift = "shift",
}

// 内部状态机:
// - targetIsDown: 目标键当前按下
// - committedIsDown: 已确认按下（超过延迟阈值）
// - canceledUntilRelease: 已取消直到释放
// - pressGeneration: 代次追踪（处理快速重复按下）
```

**用途**：实现类似 "长按 Option 激活热键窗口" 的功能。

---

## 8. launch-services-helper：应用启动器

**文件**：`/Applications/Codex.app/Contents/Resources/native/launch-services-helper`

### 8.1 用法

```bash
launch-services-helper <file-path>
# 输出 JSON:
# {
#   "appPath": "/Applications/Safari.app",
#   "bundleId": "com.apple.Safari",
#   "displayName": "Safari"
# }
```

### 8.2 实现

```swift
// 从 strings 分析重建
func main() {
  let path = CommandLine.arguments[1]
  let url = URL(fileURLWithPath: path)
  let ws = NSWorkspace.shared
  let appURL = ws.urlForApplication(toOpen: url)

  if let bundle = Bundle(url: appURL) {
    print(JSON.encode([
      "appPath": appURL.path,
      "bundleId": bundle.bundleIdentifier,
      "displayName": ws.displayName(atPath: appURL.path)
    ]))
  }
}
```

用于 "Open In..." 功能：当用户选择用外部应用打开文件时，查询合适的应用。
