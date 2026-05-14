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

### [codex-app-architecture-report.md](codex-app-architecture-report.md)

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
