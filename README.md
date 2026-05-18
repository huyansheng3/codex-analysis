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

### 架构总览

| 文档 | 内容 |
|------|------|
| [codex-app-architecture-report.md](codex-app-architecture-report.md) | 整体架构概览 — 进程架构图、技术栈、数据流、依赖关系 |
| [codex-agent-core-process-architecture.md](docs/codex-agent-core-process-architecture.md) | Agent 核心进程架构 — 服务端 Agent Loop、工作区隔离、Tool 注册调度 |

### 核心系统分析

| 文档 | 内容 |
|------|------|
| [codex-ipc-communication-layer.md](docs/codex-ipc-communication-layer.md) | 18 个 IPC 通道、electronBridge API、50+ 消息类型、Deep Link 路由 |
| [codex-main-process-architecture.md](docs/codex-main-process-architecture.md) | Bootstrap 启动流程、Session Partition、Feature Flag、Worker 线程 |
| [codex-native-modules-deep-dive.md](docs/codex-native-modules-deep-dive.md) | objc-js、better-sqlite3、node-pty、sparkle、Secure Enclave |
| [codex-renderer-wasm-layer.md](docs/codex-renderer-wasm-layer.md) | React SPA、31 个 WASM 模块、精灵表、字体系统 |
| [codex-plugin-system.md](docs/codex-plugin-system.md) | Marketplace 注册、4 个内置插件、MCP 集成、Skills 系统 |

### 功能模块分析

| 文档 | 内容 |
|------|------|
| [codex-computer-use-implementation.md](docs/codex-computer-use-implementation.md) | 双 Swift 进程架构、9 个 MCP Tools、权限系统、遥测 |
| [codex-goal-mode-implementation.md](docs/codex-goal-mode-implementation.md) | Goal 状态机、UI 组件、Automations 集成 |
| [codex-goal-agent-layer.md](docs/codex-goal-agent-layer.md) | Remark-Directive 系统、Heartbeat XML、Thread-Follower RPC |
| [codex-remote-control-system.md](docs/codex-remote-control-system.md) | Device Key enrollment、SSH 连接发现、WebSocket 远程控制 |
| [codex-hotkey-window-system.md](docs/codex-hotkey-window-system.md) | 浮动窗口系统、转场动画、快捷键注册、PrimaryWindowMode |
| [codex-dictation-system.md](docs/codex-dictation-system.md) | bare-modifier-monitor、PTT 语音输入、Hold/Toggle 双模式 |
| [codex-browser-sidebar-system.md](docs/codex-browser-sidebar-system.md) | Shadow DOM React 运行时、截图管道、评论叠加层、Browser-Use 集成 |
| [codex-plan-multi-agent-system.md](docs/codex-plan-multi-agent-system.md) | GFM Task List 渲染、三级沙箱、子 Agent 生命周期 |
| [codex-desktop-pet-implementation.md](docs/codex-desktop-pet-implementation.md) | 桌面宠物 — 精灵表引擎、浮动窗口、状态机、热键召唤 |

### 安全分析

| 文档 | 内容 |
|------|------|
| [codex-security-attack-surface.md](docs/codex-security-attack-surface.md) | 攻击面分析、4 条攻击链、15 条安全建议 |

### 方法论

| 文档 | 内容 |
|------|------|
| [reverse-engineering-methodology.md](docs/reverse-engineering-methodology.md) | 通用逆向方法论：五阶段流程、不同目标技术矩阵、工具集 |
| [no-sourcemap-js-reconstruction.md](docs/no-sourcemap-js-reconstruction.md) | **无 sourcemap 的 JS 六步重建法** — 字符串锚点→上下文提取→变量反推→控制流保留→跨文件关联→类型推断 |

## 反编译源代码 (src/)

| 目录 | 文件 | 来源 |
|------|------|------|
| `src/preload/` | `electron-bridge.ts`, `sandbox-preload.ts` | preload API + MCP 沙箱验证 |
| `src/ipc/` | `channels.ts`, `message-types.ts` | 40+ IPC 通道 + 50+ 消息类型 |
| `src/main/` | `bootstrap.ts`, `computer-use-path.ts` | 启动流程 + CU 路径查找 |
| `src/native/` | `objc-js-api.ts` | ObjC Runtime 桥接 API |
| `src/plugins/` | `manifest.ts` | marketplace.json + plugin.json 规范 |
| `src/computer-use/` | `mcp-tools.ts`, `permission-system.ts` | 9 MCP Tools + 权限审批黑名单 |
| `src/goal/` | `automation-template.md`, `heartbeat.xml`, `thread-follower.ts` | Agent 指令模板 + 15 请求类型 |
| `src/remote-control/` | `enrollment.ts`, `ssh-connections.ts` | Device Key 7 步握手 + SSH 发现 |
| `src/pet/` | `spritesheet-engine.ts`, `avatar-overlay.ts`, `state-machine.ts`, `hotkey-window.ts` | 桌面宠物引擎 + 浮动窗口 + 状态机 |

## 逆向工具脚本 (scripts/)

| 脚本 | 用途 |
|------|------|
| `scripts/extract-asar.py` | 从 Electron ASAR 归档中解压文件 |
| `scripts/search-minified.py` | 在混淆/压缩 JS 中搜索关键词并提取上下文 |
| `scripts/analyze-node-module.sh` | .node 原生模块分析 (nm/strings/otool) |
| `scripts/extract-strings.py` | 从二进制中提取和过滤有意义的字符串 |

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

详见 [CLAUDE.md](CLAUDE.md) 了解完整的反编译方法论和常用命令。

## 关键安全发现

1. **API Key 明文存储**：`openai-api-key` 通过 Electron Settings 明文存储在 `~/Library/Application Support/Codex/`
2. **objc-js 无限制系统访问**：任意 dlopen、NSClassFromString、objc_msgSend、libffi 调用
3. **Computer Use 双层权限**：Accessibility + Screen Recording 权限允许完全桌面控制
4. **Sparkle 更新签名**：Ed25519 公钥验证，但二进制篡改可绕过
5. **IPC 无调用者上下文验证**：任何 preload 脚本可发送任意 IPC 消息
6. **Remote Control Device Key**：Secure Enclave ECDSA P-256 硬件身份绑定

## 许可

本项目仅用于安全研究和教育目的。
