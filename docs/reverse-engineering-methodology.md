# 软件逆向工程方法论：从零到完整架构重建

> 一份面向实战的逆向分析方法指南，涵盖 Electron 应用、原生模块、WASM 运行时和混淆代码。

---

## 一、什么是软件逆向工程

软件逆向工程（Software Reverse Engineering）是在**没有源代码、没有文档、没有原始符号**的情况下，从编译产物中推断出原始设计、架构和逻辑的过程。

与漏洞挖掘不同，本文讨论的是**理解型逆向**——目标是弄清楚"这个软件是怎么做的"，而非"这个软件有什么漏洞"。两者的方法高度重叠，但产出不同：前者是一份架构文档，后者是一份漏洞报告。

### 三种逆向的输入形态

| 形态 | 典型目标 | 难度 |
|------|---------|------|
| **解释型/中间码** | Python `.pyc`、Java `.class`、.NET IL、WASM | ⭐⭐ |
| **脚本打包** | Electron ASAR、React Native Bundle、混淆 JS | ⭐⭐⭐ |
| **原生编译** | Mach-O、ELF、PE 二进制、`.node` addon | ⭐⭐⭐⭐⭐ |

难度递增的核心原因是**信息损失**：解释型保留了类型系统和控制流结构；脚本打包丢失了变量名和模块边界；原生编译则连函数边界都需要从机器码推断。

---

## 二、通用方法论：五个阶段

任何逆向工程都遵循一个通用流程。这不是线性瀑布，而是一个不断回溯的螺旋。

### 阶段一：侦察与信息收集

**目标**：在不深入代码的情况下，尽可能多地获取元信息。

**具体做法**：

1. **文件系统侦察**
   ```bash
   # 目录结构 → 模块边界
   find . -maxdepth 3 -type d | head -50

   # 文件大小分布 → 识别核心模块和第三方库
   find . -name "*.js" -exec wc -c {} \; | sort -rn | head -20

   # 二进制文件识别
   file **/* 2>/dev/null | grep -v "directory"
   ```

   目录名本身就是信息。看到一个 `plugins/` 目录和里面的 `.json` 文件，不需要读任何代码就能推断出插件系统的存在。

2. **字符串指纹分析**
   ```bash
   strings binary | sort -u > /tmp/strings.txt
   ```

   字符串是逆向工程中最被低估的信息源。一个二进制可能没有符号表，但它一定有字符串——错误消息、日志格式、文件路径、URL、类名。这些字符串组成了二进制的"骨骼"。

   实战技巧：按类别过滤字符串：

   ```bash
   # 错误和异常 → 异常处理流程
   grep -iE 'error|exception|fail|invalid|timeout'

   # 路径和文件 → 模块结构和依赖
   grep -iE '/.*\.(js|json|wasm|node|dylib)'

   # 协议和 URL → 网络通信
   grep -iE 'https?://|wss?://|ipc://|file://'

   # 环境变量 → 配置和开关
   grep -iE 'process\.env\.|[A-Z_]{4,}'
   ```

3. **符号表导出（如果存在）**

   对于 macOS 的 `.node` 原生模块：
   ```bash
   nm -gU module.node | c++filt | sort
   ```

   `nm -gU` 只显示外部可见符号。即使用了 `c++filt` demangle C++ 符号，导出的类名和方法名揭示了模块的完整 API 表面。一个名为 `BetterSqlite3::Open` 的导出符号，比读 500 行反汇编代码更有信息量。

4. **元数据文件**

   Electron: `package.json`、`Info.plist`
   原生 macOS: `Info.plist`、`embedded.provisionprofile`
   配置文件: `.json`、`.yaml`、`.toml`

   这些文件是"逆向的赠品"——它们本就是给系统读的，包含了版本号、权限声明、依赖列表等关键信息。

### 阶段二：静态分析

**目标**：在不动用调试器的情况下，从代码/二进制中提取结构和逻辑。

#### 2.1 针对混淆 JS 的"字符串锚点法"

这是本文要详细介绍的核心技术。混淆后的 JavaScript 文件往往是一行几十万字符的代码，直接阅读不可行。但有一个关键洞察：

> **字符串字面量在混淆后不变。**

无论变量名被缩短成 `a`、`b`、`e`，`"SKY_CUA_SERVICE_PATH"` 这个字符串依然完整可读。每一个字符串都是一个**锚点**——它能把你带到代码的精确位置。

具体流程：

```
1. 选择特征字符串（有语义的、独特的）
       ↓
2. 在 minified code 中定位所有匹配 offset
       ↓
3. 提取每个 offset 前后 200-500 字符的上下文窗口
       ↓
4. 从赋值和调用模式反推语义
       ↓
5. 同一个字符串出现在两个 offset → IPC 通道的发送端和接收端
       ↓
6. 将多个锚点的发现拼接成完整调用链
```

**举例**：假设在代码中搜索 `"SKY_CUA_SERVICE_PATH"`，得到两处匹配：

```
位置 A (上下文):
  ...const e = process.env; e["SKY_CUA_SERVICE_PATH"]?.trim() || "/tmp/cua"...

位置 B (上下文):
  ...ipcRenderer.invoke("codex:get-env", "SKY_CUA_SERVICE_PATH")...
```

从位置 A 推断：这是一个从环境变量读取的路径配置，有默认值 `/tmp/cua`。从位置 B 推断：这个值可以通过 IPC 从渲染进程查询。两处关联起来，就确认了这个环境变量在主进程和渲染进程之间的通信关系。

#### 2.2 控制流保留原则

观察这段混淆代码：

```javascript
// 混淆后：
function n(t){return t?t.trim():""}

// 你能看出来这是：
function getTrimmed(value: string | undefined): string {
  return value ? value.trim() : "";
}
```

核心洞察：**控制流结构在混淆后基本不变**。

- `if`/`else` → 依然是 if/else
- `return` → 依然是 return
- `?.` 可选链 → 依然是可选链，告诉你这个值可能为 null
- `??` → 依然是空值合并，告诉你默认值的存在
- `try/catch` → 依然是异常处理
- `async/await` → 依然是异步操作

混淆主要改变了**命名**（变量名、函数名缩短），但基本保留了**结构**（控制流、操作符、调用关系）。

这意味着逆向时优先关注"怎么做的"（结构），后推断"叫什么"（命名）。

#### 2.3 针对原生二进制的静态分析

对于 Mach-O/ELF 二进制，工具链不同：

```bash
# 反汇编
objdump -d binary        # 完整反汇编
otool -tV binary         # macOS 文本段反汇编

# 符号和重定位
nm -a binary | c++filt   # 所有符号
otool -I binary          # 间接符号表
otool -R binary          # 重定位表

# 依赖
otool -L binary          # 动态库依赖
otool -l binary          # Load commands
```

原生二进制的关键是**导入函数调用**。一个 binary 如果调用了 `CGEventCreateScrollWheelEvent`，不需要反汇编任何代码就能知道它支持模拟滚轮事件。导入表是二进制的"功能目录"。

Swift 二进制的特殊技巧：Swift 使用 name mangling，即使没有符号表也能从字符串中提取类型信息：

```
_TtC18Codex_Computer_Use33CodexAppServerThreadEventObserver
```

这是 Swift 的 mangled name，可以 demangle 为：
```
Codex_Computer_Use.CodexAppServerThreadEventObserver
```

——一个 Computer Use 模块中的线程事件观察者类。

### 阶段三：动态分析

静态分析的局限是：你看得到代码，但看不到数据。动态分析填补了这个空缺。

#### 3.1 方法级别

```bash
# 系统调用追踪（macOS）
dtruss -f -t open,read,write,stat target_app 2>&1 | grep -v "ENOENT"

# 网络流量
tcpdump -i lo0 -A port 443 or port 80

# 文件系统监控
fs_usage -w -f filesys target_pid
```

系统调用不会说谎。如果静态分析怀疑某个函数负责写配置文件，`dtruss` 中出现的 `open` + `write` 调用就是确认。

#### 3.2 调试器级别

```bash
# lldb 附加
lldb -n Codex
(lldb) breakpoint set -n "objc_msgSend"
(lldb) breakpoint set -F "-[NSWindow setLevel:]"

# dtrace 探针（macOS）
sudo dtrace -n 'pid$target::objc_msgSend:entry { printf("%s\n", copyinstr(arg1)); }' -p $PID
```

关键技巧：对于 Objective-C 应用，`objc_msgSend` 是所有方法调用的入口。在 `objc_msgSend` 上设置条件断点可以捕获特定类的特定方法调用——比在方法本身上设断点更灵活。

#### 3.3 动态分析在 JS/WebView 场景的局限性

对于 Electron 应用，渲染进程在 WebView 沙箱中运行。Chrome DevTools 可以附加，但生产环境的 JS 是 minified 的，断点只能打在难以阅读的代码上。这时**动态分析的定位能力**和**静态分析的结构理解**需要配合：

1. 用 DevTools Network 面板确认 API 端点（动态）
2. 用搜索找对应的请求构造代码（静态）
3. 在请求函数上设断点，观察参数（动态）
4. 回溯调用栈找到触发逻辑（动态 → 静态）

### 阶段四：跨文件关联

单文件分析只能看到局部。完整的架构理解需要**跨文件关联**。

**核心原则**：同一个标识符出现在两个地方 = 它们之间有调用/引用关系。

```
Channel name:                         Event type:
main.js 中:                            renderer.js 中:
ipcMain.on("codex:set-setting")      ipcRenderer.send("codex:set-setting")
     ↓                                      ↓
  接收端（主进程）                        发送端（渲染进程）
```

这种关联是双向验证的：
- 在 main.js 中找到 `ipcMain.on("codex:set-setting", handler)` → handler 函数体揭示了"收到消息后做什么"
- 在 renderer.js 中找到 `ipcRenderer.send("codex:set-setting", data)` → 调用上下文揭示了"什么时候发送消息"
- 两端合在一起 = 完整的 IPC 通信语义

**跨文件关联的扩展应用**：

1. **proto 文件 ↔ 网络请求** — protobuf schema 中的字段名可能在 JS 中以字符串出现
2. **CSS class ↔ JS 组件** — CSS 中的类名在 JS 中以字符串引用，揭示组件-样式映射
3. **i18n key ↔ UI 组件** — 国际化字符串的 key 出现在 JSX/模板中，揭示 UI 结构
4. **环境变量 ↔ 功能开关** — `process.env.SOME_FLAG` 出现在条件分支中，揭示 feature flag

### 阶段五：假设-验证循环

这是整个方法论的"方向盘"——没有它，逆向就是盲目的。

```
观察 → 假设 → 预测 → 验证 → 修正/确认
  ↑                                    ↓
  └────────────── 循环 ────────────────┘
```

**一个真实的循环例子**：

1. **观察**：在精灵表代码中看到 `const cols = 8`
2. **假设**：精灵表是 8 列布局
3. **预测**：如果假设正确，那么代码中应该有 `cellWidth * frameIndex` 来定位某一帧
4. **验证**：搜索 `"* "` （乘法运算符的上下文），找到 `ctx.drawImage(img, frame * cellWidth, row * cellHeight, ...)`
5. **确认**：假设被验证，8 列布局成立
6. **进一步假设**：如果是 8 列，那么 Walk 动画恰好填满一行需要 8 帧
7. **验证**：搜索 `"walk"` 附近的 `frameCount` 赋值，找到 `frameCount: 8`
8. **确认**：Walk 动画使用完整 8 帧一行

每一步都产生可验证的预测。如果预测落空（比如 frameCount 是 6 而不是 8），就修正假设，继续探索。

---

## 三、针对不同目标的技术矩阵

### 3.1 Electron 应用

```
主要入口：app.asar（Electron Archive）
  ├── ASAR 格式 → 自定义 Python 解析器解压
  │   结构: [4B header_size][4B reserved][JSON header][file blobs]
  │
  ├── 主进程: main.js（Node.js 上下文，完整系统权限）
  │   分析方法: 字符串锚点 + IPC 通道追踪
  │
  ├── Preload: preload.js（桥接层，contextBridge API）
  │   分析方法: 提取 exposeInMainWorld 调用 → 重建 electronBridge API
  │
  ├── 渲染进程: webview/（React SPA，沙箱环境）
  │   分析方法: i18n 数据 + CSS class + JSX 字符串片段
  │
  └── 原生模块: *.node（C++ Node Addon）
      分析方法: nm + strings + objdump
```

### 3.2 原生 Node Addon（.node 文件）

`.node` 文件本质是动态链接库（macOS 上是 `.dylib`，Linux 上是 `.so`）。分析三板斧：

```bash
# 1. 导出符号 → API 表面
nm -gU module.node | c++filt

# 2. 嵌入字符串 → 功能和错误消息
strings module.node | grep -iE 'error|sql|query|file|path'

# 3. 动态库依赖 → 能力边界
otool -L module.node  # macOS
```

### 3.3 WASM 模块

WASM 模块是可移植的编译产物，有机会比原生二进制更容易分析：

```bash
# wasm2wat：WASM 二进制 → 文本格式
wasm2wat module.wasm -o module.wat

# wasm-objdump：导出函数和导入
wasm-objdump -x module.wasm

# wasm-decompile：反编译为类 C 伪代码
wasm-decompile module.wasm
```

从 WASM 的 import 段可以看出它需要宿主提供哪些能力。例如 `env.abort`、`env.memory` 等，揭示运行时的依赖关系。

### 3.4 Swift 原生二进制

Swift 二进制即使没有调试符号，也能从以下来源恢复信息：

| 来源 | 恢复的信息 |
|------|-----------|
| Swift name mangling（`_TtC...`） | 类名、模块名、方法签名 |
| Protocol conformance records | 类型实现的协议 |
| Type metadata | 类型布局、泛型实例化 |
| `swift_once` 调用 | 单例初始化 |
| `swift_allocObject` 调用 | 堆分配的对象类型 |
| ObjC interop（`@objc`） | 暴露给 ObjC 的方法 |

---

## 四、核心工具集

### 必备工具

| 工具 | 用途 | 适用对象 |
|------|------|---------|
| `file` | 识别文件格式 | 所有二进制 |
| `strings` | 提取可打印字符串 | 所有二进制 |
| `nm` | 列出符号表 | Mach-O / ELF |
| `otool` / `objdump` | 反汇编、依赖分析 | Mach-O / ELF |
| `plutil` | 解析 plist | macOS bundle |
| `grep` / `rg` | 文本搜索 | 所有文本文件 |
| `jq` | JSON 处理 | JSON 文件 |
| `python3` | 自写分析脚本 | 自定义格式 |

### 专用工具

| 工具 | 用途 |
|------|------|
| `wasm2wat` / `wasm-decompile` | WASM 反编译 |
| `c++filt` | C++ name demangling |
| `swift demangle` | Swift name demangling |
| `dtruss` / `strace` | 系统调用追踪 |
| `lldb` / `gdb` | 调试器 |
| `class-dump` | ObjC 类结构导出 |
| `Hopper` / `IDA` / `Ghidra` | 专业反汇编器 |

### 自写脚本是不可替代的

上面的工具解决的都是通用问题。但每个逆向项目都会遇到**格式特异**的问题——ASAR 解压、自定义协议解析、特殊混淆模式。这些场景下，自己写的 20 行 Python 脚本比任何通用工具都有效。

---

## 五、案例：Codex App 精灵表动画系统逆向

以下用一个完整案例展示上述方法论的实际应用。

### 5.1 侦察阶段

从 ASAR 解压后的 `webview/assets/` 目录发现：

```
codex-spritesheet.webp     868 KB
bsod-spritesheet.webp      931 KB
dewey-spritesheet.webp     764 KB
fireball-spritesheet.webp 1035 KB
null-signal-spritesheet.webp 477 KB
rocky-spritesheet.webp     644 KB
seedy-spritesheet.webp     893 KB
stacky-spritesheet.webp    732 KB
```

**初步假设**：8 个 WebP 文件、命名包含 "spritesheet"、大小在 400KB-1MB，这些都是精灵表。

**预测**：如果这是精灵表，应该能在 JS 中找到对应的加载和使用代码。

### 5.2 静态分析：字符串锚点定位

搜索关键词 `"spritesheet"`：

```bash
python3 scripts/search-minified.py "spritesheet" main.js --context 300
```

在匹配的上下文中发现：

- `cellWidth` / `cellHeight` → 单元格尺寸配置
- `frameCount` → 每行动画帧数
- `fps` → 帧率
- `rowIndex` → 行索引 → 动画状态映射
- `loop` / `interruptible` / `priority` → 动画控制属性

搜索 `"drawImage"`（Canvas API）确认存在 Canvas 渲染路径。

搜索 `"@keyframes"`（CSS animation）确认存在 CSS 渲染路径。

**关键发现**：两种渲染模式并存——循环动画走 CSS（GPU 合成），需要精确帧控制的动画走 Canvas（逐帧绘制）。

### 5.3 跨文件关联：IPC 事件映射

在 `main.js` 中搜索 `"avatar-overlay"`（窗口类型）：

→ 找到 `BrowserWindow` 的透明浮动窗口配置
→ 找到 `codex_desktop:message-from-view` IPC 处理函数

在 `preload.js` 中搜索相同的 channel 名：

→ 找到渲染进程侧的消息发送代码
→ 确认双向通信路径

在 renderer JS 中搜索动画状态名（`"idle"` `"thinking"` `"happy"`）：

→ 找到 `agent:turn-started → Thinking` 等事件映射
→ 确认 Agent 工作状态会触发宠物动画

### 5.4 假设-验证循环

```
观察: 精灵表宽度 / cellWidth = 8
  ↓
假设: 8 列布局
  ↓
验证: 搜索 `"frame * cellWidth"` → 确认帧定位用乘法
  ↓
观察: Walk 行有 `frameCount: 8`
  ↓
假设: 完整步态周期填满一行
  ↓
验证: Idle 行 `frameCount: 4`、Jump 行 `frameCount: 6` — 帧数各不同
  ↓
结论: 每个动画状态的帧数独立配置，符合精灵表行业标准
```

### 5.5 最终产出

分析最终产出了约 550 行 TypeScript 代码，分为三个模块：

```
src/pet/
├── spritesheet-engine.ts   — 精灵表布局、CSS/Canvas 双渲染器、动画控制器
├── avatar-overlay.ts       — Electron BrowserWindow 浮动窗口、位置管理、IPC 通信
└── state-machine.ts        — 宠物生命周期状态机、事件联动、随机行为 AI
```

这些代码**不是原始源码**——原始 TypeScript 在 Vite 编译和 Terser 混淆后已不可恢复。它们是**等价的语义重建**：同样的接口、同样的行为、同样的架构层次，但命名和组织方式是我们从逆向分析中推断出来的。

---

## 六、总结：逆向工程者的思维模式

### 六个核心原则

1. **字符串是锚点**。混淆改变命名，不改变字符串字面量。每一个有意义的字符串都是进入代码的入口。

2. **控制流是保留的**。if/return/try/await 在混淆后结构不变。关注"怎么做"先于"叫什么"。

3. **双端验证**。同一个标识符在两处出现 → 它们之间有调用关系。这是重建调用图的基础。

4. **假设驱动，预测验证**。每一步都形成可被验证的预测，不盲猜。

5. **领域知识加速推断**。知道"精灵表标准是 8 列"，就能从尺寸反推布局。知道"IPC 有 on 和 send 两端"，就能从 channel 名重建通信路径。

6. **工具是杠杆，脚本是适配器**。通用工具解决 80% 的问题，自写脚本解决剩下 20% 的定制格式。

### 阶段总览

```
侦察:    file + strings + nm + 目录遍历 → 元信息地图
  ↓
静态:    字符串锚点 + 上下文窗口 + 控制流分析 → 代码逻辑
  ↓
动态:    dtruss + lldb + 网络监控 → 运行时行为
  ↓
关联:    标识符交叉匹配 → 模块间调用关系
  ↓
验证:    假设-预测-验证循环 → 修正理解
  ↓
重建:    TypeScript/C 伪代码 → 可读的架构文档
```

逆向工程的本质不是把 minified code 变回 pretty code。它是**在信息不完整的情况下，用结构化的方法逐步消除不确定性，直到能够以足够的精度描述目标系统的行为和架构。**
