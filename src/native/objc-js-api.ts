// ============================================================
// objc-js API — 从 dist/index.js + nm 符号 逆向重建
// macOS Objective-C Runtime 的完整 JS 桥接
// ============================================================

// --- NobjcLibrary: 动态库加载 ---

/**
 * 延迟加载的动态库 Proxy
 * library.$SymbolName → dlsym + 类型推断
 */
declare class NobjcLibrary {
  constructor(path: string);

  // Proxy trap: 任意属性访问 → dlsym(symbol)
  // 支持: 函数、全局变量、常量
  [symbol: string]: unknown;
}

// --- NobjcObject: ObjC 对象包装 ---

/**
 * ObjC 对象的 JS Proxy 包装
 *
 * 核心机制: obj.$methodName(arg1, arg2)
 *   → 将 $ 转换为 :（ObjC 选择器语法）
 *   → objc_msgSend(obj, selector, arg1, arg2)
 *
 * 例如:
 *   obj.$setFrame$display(frame, true)
 *   → [obj setFrame:frame display:YES]
 */
declare class NobjcObject {
  /**
   * 通过类名创建 ObjC 实例
   * → NSClassFromString(name) → [[cls alloc] init]
   */
  constructor(className: string, ...args: unknown[]);

  // --- 性能优化 API ---

  /** 预热: 缓存 selector + method signature */
  $prepareSend(methodName: string): PreparedSend;

  /** 检查对象是否响应某个 selector */
  $respondsToSelector(selector: string): boolean;

  // --- 指针操作 ---

  /** 从 Buffer 或 BigInt 指针重建 ObjC 对象 */
  static fromPointer(ptr: Buffer | BigInt): NobjcObject;

  /** 提取对象的原始指针为 Node Buffer */
  getPointer(): Buffer;
}

interface PreparedSend {
  (obj: NobjcObject, ...args: unknown[]): unknown;
}

// --- NobjcProtocol: 在 JS 中实现 ObjC 协议 ---

declare class NobjcProtocol {
  /**
   * 创建协议的 JS 实现
   *
   * 类型自动转换:
   *   JS string ↔ NSString
   *   JS number ↔ NSNumber / CGFloat
   *   JS boolean ↔ BOOL
   *   JS null ↔ nil
   *   JS object ↔ id (WeakMap 缓存)
   */
  static implement(
    protocolName: string,
    implementation: Record<string, (...args: unknown[]) => unknown>
  ): ProtocolImpl;
}

interface ProtocolImpl {
  // ObjC 协议实现的内部引用
}

// --- NobjcClass: 运行时创建 ObjC 类 ---

declare class NobjcClass {
  /**
   * 在 ObjC Runtime 中定义新类
   * → objc_allocateClassPair() → class_addMethod() →
   *   class_addProtocol() → objc_registerClassPair()
   */
  static define(options: {
    className: string;
    superclass?: string;         // 默认 NSObject
    protocols?: string[];        // 要实现的协议
    methods?: Record<
      string,                   // 方法名（如 "applicationDidFinishLaunching:"）
      {
        types: string;          // ObjC type encoding
        implementation: (...args: unknown[]) => unknown;
      }
    >;
  }): NobjcClass;

  /** 调用 superclass 实现 */
  static super(obj: NobjcObject): SuperProxy;
}

interface SuperProxy {
  // 所有发送到 SuperProxy 的消息都转发到 super
  [method: string]: (...args: unknown[]) => unknown;
}

// --- callFunction: libffi C 函数调用 ---

/**
 * 通过 dlsym + libffi 调用任意 C 函数
 * 类型自动推断
 *
 * 例如:
 *   callFunction("NSLog", "Hello %@", obj)
 *   callFunction("NSHomeDirectory", { returns: "@" })
 */
declare function callFunction(
  name: string,
  ...args: unknown[]
): unknown;

/**
 * 可变参数版本的 callFunction
 * ARM64 需要不同的调用约定
 */
declare function callVariadicFunction(
  name: string,
  options: { returns?: string; args?: string[] },
  ...args: unknown[]
): unknown;

// --- RunLoop ---

declare const RunLoop: {
  /** CFRunLoopRunInMode(kCFRunLoopDefaultMode, seconds, true) */
  pump(seconds?: number): void;

  /** CFRunLoopRun() — 阻塞当前线程 */
  run(): void;

  /** CFRunLoopStop(CFRunLoopGetCurrent()) */
  stop(): void;
};

// --- 类型转换 ---

/**
 * ObjC type encodings (bridge.h):
 *
 * c = char            C = unsigned char
 * i = int             I = unsigned int
 * s = short           S = unsigned short
 * l = long            L = unsigned long
 * q = long long       Q = unsigned long long
 * f = float           d = double
 * B = BOOL            * = char *
 * : = SEL             @ = id
 * # = Class           ^ = pointer
 * { = struct begin    } = struct end
 * ( = union begin     ) = union end
 *
 * 完整支持 struct 编码解析:
 *   {CGRect={CGPoint=dd}{CGSize=dd}}
 *   → JS: { origin: { x: number, y: number }, size: { width: number, height: number } }
 *
 * Buffer/TypedArray 用于指针类型:
 *   ^v → Node Buffer
 *   ^i → Int32Array
 *   ^{...} → Node Buffer
 */

export type {
  NobjcLibrary,
  NobjcObject,
  NobjcProtocol,
  NobjcClass,
  ProtocolImpl,
  PreparedSend,
  SuperProxy,
};

export {
  callFunction,
  callVariadicFunction,
  RunLoop,
};
