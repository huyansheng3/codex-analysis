# Codex App Security Research

OpenAI Codex 桌面应用的完整安全架构逆向分析。

**目标版本**：26.506.31421 (Build 2620) | **分析日期**：2026-05-14

## 项目概述

本项目通过逆向工程手段，对 OpenAI Codex macOS 桌面应用的完整架构进行了分析，包括 Electron 主进程、渲染进程、原生模块、插件系统和安全攻击面。

### 技术栈

| 组件 | 技术 |
|------|------|
| 框架 | Electron 41.2.0 |
| 构建 | Vite 8.0.3 + electron-forge |
| 语言 | TypeScript 5.9.3 + Swift (原生模块) + C++ (Node Addons) |
| 包管理 | pnpm monorepo |
| 渲染 | React SPA + .NET/WASM 运行时 |
| 原生桥接 | objc-js (JS ↔ Objective-C) + libffi |
| 数据库 | better-sqlite3 |
| 终端 | node-pty |
| 更新 | Sparkle (Ed25519 签名) |
| 错误追踪 | Sentry |
| 插件协议 | MCP (Model Context Protocol) |

## 文档索引

### 分析文档 (docs/)

[codex-app-architecture-report.md](codex-app-architecture-report.md) — 整体架构概览

| 文档 | 内容 |
|------|------|
| [codex-ipc-communication-layer.md](docs/codex-ipc-communication-layer.md) | 18 个 IPC 通道、electronBridge API、50+ 消息类型、Deep Link 路由 |
| [codex-main-process-architecture.md](docs/codex-main-process-architecture.md) | Bootstrap 启动流程、Session Partition、Feature Flag、Worker 线程 |
| [codex-native-modules-deep-dive.md](docs/codex-native-modules-deep-dive.md) | objc-js、better-sqlite3、node-pty、sparkle、Secure Enclave |
| [codex-plugin-system.md](docs/codex-plugin-system.md) | Marketplace 注册、4 个内置插件、MCP 集成、Skills 系统 |
| [codex-renderer-wasm-layer.md](docs/codex-renderer-wasm-layer.md) | React SPA、31 个 WASM 模块、精灵表、字体系统 |
| [codex-computer-use-implementation.md](docs/codex-computer-use-implementation.md) | 双 Swift 进程架构、9 个 MCP Tools、权限系统、遥测 |
| [codex-goal-mode-implementation.md](docs/codex-goal-mode-implementation.md) | Goal 状态机、UI 组件、Automations 集成 |
| [codex-goal-agent-layer.md](docs/codex-goal-agent-layer.md) | Remark-Directive 系统、Heartbeat XML、Thread-Follower RPC |
| [codex-agent-core-process-architecture.md](docs/codex-agent-core-process-architecture.md) | **Agent 核心进程架构** — 服务端 Agent Loop、工作区隔离、Tool 注册调度、vs VSCode 对比 |
| [codex-security-attack-surface.md](docs/codex-security-attack-surface.md) | 攻击面分析、4 条攻击链、15 条安全建议 |
| [codex-desktop-pet-implementation.md](docs/codex-desktop-pet-implementation.md) | **桌面宠物完整实现原理** — 五子系统协同、精灵表引擎、浮动窗口、状态机、热键窗口 |

### 反编译源代码 (src/)

| 目录 | 文件 | 来源 |
|------|------|------|
| `src/preload/` | `electron-bridge.ts` | preload.js 完整 API 重建 |
| | `sandbox-preload.ts` | MCP Sandbox 安全验证逻辑 |
| `src/ipc/` | `channels.ts` | 40+ IPC 通道 + Settings key |
| | `message-types.ts` | 50+ 消息类型 TypeScript union |
| `src/main/` | `bootstrap.ts` | 启动流程完整重建 |
| | `computer-use-path.ts` | Computer Use 路径查找逻辑 |
| `src/native/` | `objc-js-api.ts` | ObjC Runtime 桥接 API |
| `src/plugins/` | `manifest.ts` | marketplace.json + plugin.json 规范 |
| `src/computer-use/` | `mcp-tools.ts` | 9 个 MCP Tools + 完整按键表 |
| | `permission-system.ts` | TCC 权限 + 审批 + 黑名单 |
| `src/goal/` | `automation-template.md` | Agent System Prompt 模板（完整提取） |
| | `heartbeat.xml` | Automation Heartbeat XML 格式 |
| | `thread-follower.ts` | 15 个 Thread-Follower 请求类型 |
| `src/pet/` | `spritesheet-engine.ts` | 精灵表动画引擎 — 8 角色 × 16 动画状态、CSS/Canvas 渲染 |
| | `avatar-overlay.ts` | 浮动窗口管理 — 透明无边框、alwaysOnTop、鼠标穿透、边缘吸附 |
| | `state-machine.ts` | 宠物状态机 — 完整生命周期、Agent 事件联动、空闲/电池感知 |
| | `hotkey-window.ts` | 热键召唤窗口 — Cmd+Shift+Space、折叠动画、全局快捷键 |

### 逆向工具脚本 (scripts/)

| 脚本 | 用途 |
|------|------|
| `scripts/extract-asar.py` | 从 Electron ASAR 归档中解压文件 |
| `scripts/search-minified.py` | 在混淆/压缩 JS 中搜索关键词并提取上下文 |
| `scripts/analyze-node-module.sh` | .node 原生模块分析 (nm/strings/otool) |
| `scripts/extract-strings.py` | 从二进制中提取和过滤有意义的字符串 |

### [CLAUDE.md](CLAUDE.md) — 分析方法论与常用命令

整体架构概览 — 进程架构图、技术栈、数据流、依赖关系。

### [docs/codex-ipc-communication-layer.md](docs/codex-ipc-communication-layer.md)

IPC 通信层完整逆向 — 18 个 IPC 通道、`electronBridge` API TypeScript 伪代码、50+ 消息类型路由表、browser-sidebar 协议、MCP Sandbox Skybridge 协议、Deep Link 路由、Settings 持久化通道（含凭据存储路径）。

### [docs/codex-main-process-architecture.md](docs/codex-main-process-architecture.md)

主进程架构分析 — Bootstrap 启动流程、App Session 模块、WASM 绑定层、Session Partition 管理、8 种窗口类型、完整应用菜单、Feature Flag 系统、20+ 环境变量、Worker 线程模块。

### [docs/codex-native-modules-deep-dive.md](docs/codex-native-modules-deep-dive.md)

原生模块深度逆向 — objc-js 完整 ObjC Runtime 桥接接口、better-sqlite3 C++ 类结构、node-pty API、sparkle.node SPUUpdaterDelegate、browser-use-peer-authorization 代码签名验证链、Secure Enclave 密钥管理、bare-modifier-monitor 状态机。

### [docs/codex-plugin-system.md](docs/codex-plugin-system.md)

插件系统完整逆向 — Marketplace 注册机制、manifest 规范、4 个内置插件分析（browser-use / chrome / computer-use / latex-tectonic）、MCP 集成模式、Skills 系统。

### [docs/codex-renderer-wasm-layer.md](docs/codex-renderer-wasm-layer.md)

渲染进程与 WASM 运行时 — React SPA 入口、CSP 策略分析、代码分割结构、31 个 WASM 模块清单（.NET Runtime / OpenXML / Walnut）、8 个精灵表角色、字体系统。

### [docs/codex-computer-use-implementation.md](docs/codex-computer-use-implementation.md)

Computer Use 实现完整逆向 — 双 Swift 进程架构（SkyComputerUseService + SkyComputerUseClient）、9 个 MCP Tools 完整接口、系统权限（Accessibility + Screen Recording）、应用审批 SQLite、Apple Events IPC、10 个 Protobuf 遥测事件、Turn 生命周期。

### [docs/codex-agent-core-process-architecture.md](docs/codex-agent-core-process-architecture.md)

Agent 核心进程架构深度分析 — 服务端 Agent Loop vs 本地 Tool Executor 的架构决策、完整进程地图（Electron + Worker + MCP 子进程 + Swift 原生进程）、三层工作区隔离模型（服务端 Thread + Electron Session Partition + 本地 Tool Execution）、Agent Loop 核心逻辑推断（buildContext → LLM → tool_call → execute → tool_result 循环）、Steer vs Send 的差异、Plan 系统驱动执行、三层 Tool 注册体系、审批拦截点、与 VSCode Extension Host 模式的详细对比。

### [docs/codex-security-attack-surface.md](docs/codex-security-attack-surface.md)

安全攻击面分析 — IPC 注入风险、objc-js 攻击链、凭据明文存储、4 条完整攻击链（XSS→Key窃取 / DeepLink注入 / Plugin→RCE / Sparkle MITM）、Session 隔离分析、15 条分级安全建议。

## 方法论

```
/Applications/Codex.app
  │
  ├── app.asar ──→ Python ASAR 解析器 ──→ 1305 个文件解压
  │
  ├── app.asar.unpacked/node_modules/
  │   └── .node 文件 ──→ nm -gU ──→ 导出符号 → C++ 类结构重建
  │
  ├── plugins/openai-bundled/
  │   └── .json + 二进制 ──→ strings 提取 + plist 解析
  │
  └── Resources/native/
      └── Mach-O 二进制 ──→ strings + file + nm ──→ 功能推断
```

## 关键安全发现

1. **API Key 明文存储**：`openai-api-key` 通过 Electron Settings 明文存储在 `~/Library/Application Support/Codex/`
2. **objc-js 无限制系统访问**：任意 dlopen、NSClassFromString、objc_msgSend、libffi 调用
3. **Computer Use 双层权限**：Accessibility + Screen Recording 权限允许完全桌面控制
4. **Sparkle 更新签名**：Ed25519 公钥验证，但二进制篡改可绕过
5. **IPC 无调用者上下文验证**：任何 preload 脚本可发送任意 IPC 消息

## 许可

本项目仅用于安全研究和教育目的。
