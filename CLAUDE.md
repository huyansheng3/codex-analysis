# Codex App 逆向工程

本仓库包含对 OpenAI Codex macOS 桌面应用的完整安全架构逆向分析。

## 项目结构

```
codex-ana/
├── README.md                              ← 项目概览和文档索引
├── codex-app-architecture-report.md       ← 整体架构分析
├── docs/                                  ← 深度分析文档 (7 篇)
│   ├── codex-ipc-communication-layer.md
│   ├── codex-main-process-architecture.md
│   ├── codex-native-modules-deep-dive.md
│   ├── codex-plugin-system.md
│   ├── codex-renderer-wasm-layer.md
│   ├── codex-security-attack-surface.md
│   ├── codex-computer-use-implementation.md
│   ├── codex-goal-mode-implementation.md
│   └── codex-goal-agent-layer.md
├── src/                                   ← 反编译重建的源代码 (13 文件)
│   ├── preload/         electron-bridge.ts, sandbox-preload.ts
│   ├── ipc/             channels.ts, message-types.ts
│   ├── main/            bootstrap.ts, computer-use-path.ts
│   ├── native/          objc-js-api.ts
│   ├── plugins/         manifest.ts
│   ├── computer-use/    mcp-tools.ts, permission-system.ts
│   └── goal/            automation-template.md, heartbeat.xml, thread-follower.ts
└── CLAUDE.md                              ← 本文件
```

## 分析方法论

### ASAR 解压

Electron 应用的代码打包在 `app.asar` 中。解压方法：

```bash
# 找到 asar 文件
find /Applications/Codex.app -name "*.asar" -not -path "*/node_modules/*"

# 如果没有 asar CLI，用 Python 手动解析
# ASAR 格式: 16字节前缀 + JSON header + 文件数据
# JSON header 的 offset 通过 brace-matching 定位
```

### Minified JS 反编译流程

核心方法不是自动反编译，而是**字符串锚点 + 上下文分析 + 语义重建**：

1. **字符串锚点定位**：搜索特征字符串（如 `"SKY_CUA_SERVICE_PATH"`）在 minified code 中的 offset
2. **上下文提取**：Python 脚本提取 offset 前后 200-500 字符
3. **变量名反推**：从赋值模式推断语义（如 `e[ft]?.trim()` → `env["SKY_CUA_SERVICE_PATH"]?.trim()`）
4. **控制流保留**：if/return/for/?./??/|| 的语义在 minified 后不变
5. **跨文件关联**：同一个字符串在两处出现 → IPC 通道的发送端和接收端
6. **类型推断**：从默认值（`process.env`）、运算符（`?.`）、调用方式反推 TypeScript 类型

### 原生 .node 模块分析

```bash
# 导出符号 → 重建 C++ 类结构
nm -gU /path/to/module.node

# 嵌入字符串 → 功能推断
strings /path/to/binary | grep -i keyword

# 动态库依赖
otool -L /path/to/binary
```

### Swift 二进制分析

对于 Computer Use 的 Swift 二进制（无符号表），使用 `strings` 提取：
- 类名和方法名（Swift mangling: `_TtC18Codex_Computer_Use33CodexAppServerThreadEventObserver`）
- 硬编码字符串（Bundle IDs、URLs、错误消息）
- 从字符串中重建 ObjC/Swift 接口定义

### i18n 数据利用

React 渲染进程的 i18n 数据（35MB comment-preload.js）包含完整的 UI 界面标签。通过提取 i18n key 可以重建：
- UI 组件结构
- 功能状态枚举（如 Goal 的 active/paused/budgetLimited/complete）
- 用户交互流程

## 关键发现

### 目标 App 信息
- App: /Applications/Codex.app
- 版本: 26.506.31421 (Build 2620)
- asar: /Applications/Codex.app/Contents/Resources/app.asar (137MB)
- 解压后 1305 个文件，约 175MB

### 技术栈
- Electron 41.2.0 + Vite 8.0.3 + TypeScript 5.9.3
- React SPA 渲染进程
- .NET/WASM 运行时（31 个 WASM 模块，用于 Office 文档渲染）
- Swift 原生进程（Computer Use 的双进程架构）
- C++ Node Addons（better-sqlite3, node-pty, objc-js）

### 安全关注点
- API Key 明文存储于 Electron Settings
- objc-js 提供无限制的系统访问（任意 dlopen/objc_msgSend/libffi）
- Computer Use 的双层权限（Accessibility + Screen Recording）
- IPC 通信无调用者上下文验证

## 逆向工具脚本 (scripts/)

```bash
# 从 ASAR 中解压文件
python3 scripts/extract-asar.py app.asar ./unpacked
python3 scripts/extract-asar.py --list app.asar   # 仅列出文件

# 在 minified JS 中搜索关键词 (带上下文)
python3 scripts/search-minified.py "SKY_CUA_SERVICE_PATH" app.js
python3 scripts/search-minified.py "keyword" file.js --context 400 --all

# 分析 .node 原生模块
./scripts/analyze-node-module.sh module.node ./analysis-output

# 从二进制提取并过滤字符串
python3 scripts/extract-strings.py binary --preset objc,swift
python3 scripts/extract-strings.py binary --filter key,token,password
python3 scripts/extract-strings.py binary --pattern 'TtC\d+Codex'  # Swift mangling

# 读取 Mach-O 信息
file binary
plutil -p Info.plist
```
