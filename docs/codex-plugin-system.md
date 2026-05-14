# Codex 插件系统完整逆向

> 来源：`/Applications/Codex.app/Contents/Resources/plugins/` 目录及 ASAR 内 skills/ 目录
> 版本：26.506.31421 (Build 2620)

---

## 1. 插件系统架构

```
Codex Plugin System
│
├── Marketplace Registry (marketplace.json)
│   └── openai-bundled/
│       ├── browser-use/     (v0.1.0-alpha2)
│       ├── chrome/          (v0.1.7)
│       ├── computer-use/    (v1.0.780)
│       └── latex-tectonic/  (v0.1.1)
│
├── User-installed Plugins
│   └── $CODEX_HOME/plugins/{pluginName}/
│       └── .codex-plugin/plugin.json
│
└── Skills
    └── $CODEX_HOME/skills/
        └── {skillName}/SKILL.md
```

---

## 2. Marketplace 注册机制

**文件**：`plugins/openai-bundled/.agents/plugins/marketplace.json`

```typescript
interface MarketplaceManifest {
  name: string;                    // marketplace 唯一标识符
  interface: {
    displayName: string;           // UI 显示名
  };
  plugins: PluginEntry[];          // 包含的插件列表
}

interface PluginEntry {
  name: string;                    // 插件名
  source: {
    source: "local";               // 来源类型（"local" = 内置）
    path: string;                  // 相对路径到插件目录
  };
  policy: {
    installation: "AVAILABLE";     // 安装策略
    authentication: "ON_INSTALL";  // 认证要求
  };
  category: "Engineering" | "Productivity" | "Research";
}
```

### 2.1 注册插件清单

```json
{
  "name": "openai-bundled",
  "interface": { "displayName": "OpenAI Bundled" },
  "plugins": [
    {
      "name": "browser-use",
      "source": { "source": "local", "path": "./plugins/browser-use" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Engineering"
    },
    {
      "name": "chrome",
      "source": { "source": "local", "path": "./plugins/chrome" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    },
    {
      "name": "computer-use",
      "source": { "source": "local", "path": "./plugins/computer-use" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    },
    {
      "name": "latex-tectonic",
      "source": { "source": "local", "path": "./plugins/latex-tectonic" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Research"
    }
  ]
}
```

---

## 3. Plugin Manifest 规范

**路径**：`{plugin}/.codex-plugin/plugin.json`

```typescript
interface PluginManifest {
  // === 基本信息 ===
  name: string;                    // 唯一标识符（kebab-case）
  version: string;                 // semver
  description: string;             // 给 LLM 的功能描述（含别名和触发条件）
  author: {
    name: string;
    email?: string;
    url?: string;
  };
  homepage?: string;
  repository?: string;
  license: string | "Proprietary";
  keywords: string[];              // 搜索关键词

  // === 技能和 MCP ===
  skills?: string;                 // 技能目录路径
  mcpServers?: string;            // MCP 配置文件路径

  // === 界面 ===
  interface: {
    displayName: string;           // 用户可见名称
    shortDescription: string;      // 简短描述
    longDescription: string;       // 完整描述
    developerName: string;
    category: string;              // 分类
    capabilities: Array<"Interactive" | "Read" | "Write">;
    websiteURL: string;
    privacyPolicyURL: string;
    termsOfServiceURL: string;
    defaultPrompt: string[];       // 推荐提示示例
    brandColor: string;            // #RRGGBB
    composerIcon?: string;         // 编辑器图标路径
    logo: string;                  // Logo 图标路径
    screenshots: string[];         // 截图（通常为空）
  };
}
```

---

## 4. 内置插件详解

### 4.1 browser-use（应用内浏览器）

**版本**：0.1.0-alpha2 | **类别**：Engineering

**功能**：让 Codex 控制在应用内打开的浏览器页面（localhost、file:// 等）

```yaml
别名: @browser, @browser-use, Browser  # 用户可在对话中通过 @ 提及
触发条件: 用户要求打开/检查/导航/点击/输入/截图本地 web 目标
目标: localhost, 127.0.0.1, ::1, file:// URL, 当前应用内浏览器 tab
```

**实现架构**：

```
User Request "@browser test my app"
  │
  ├── Codex Agent 读取 SKILL.md 获取启动指令
  │
  ├── Node REPL (MCP: node_repl)
  │   ├── setupAtlasRuntime({ globals: globalThis })
  │   └── browser = await agent.browsers.get("iab")  // iab = In-App Browser
  │
  └── browser API:
      ├── browser.tabs.list()
      ├── browser.tabs.get(tabId)
      ├── browser.navigate(url)
      ├── browser.click(selector)
      ├── browser.type(text)
      ├── browser.screenshot()
      └── browser.nameSession("🔎 task name")
```

**关键文件**：
- `plugins/browser-use/scripts/browser-client.mjs` — 浏览器客户端入口
- `plugins/browser-use/skills/browser/SKILL.md` — Agent 技能文档
- `plugins/browser-use/skills/browser/agents/openai.yaml` — OpenAI Agent 配置
- `plugins/browser-use/assets/browser.png` — 插件 Logo

**依赖**：`classic-level` (LevelDB native binding)

**安全考虑**：
- 仅限本地 URL（localhost、127.0.0.1、::1、file://）
- 需要 Node REPL 环境
- 可访问本地文件系统（file://）⚠️

### 4.2 chrome（Chrome 浏览器控制）

**版本**：0.1.7 | **类别**：Productivity

**功能**：让 Codex 通过用户的 Chrome 浏览器访问需要登录、Cookie、扩展的页面。

```yaml
触发条件: 需要现有浏览器状态（登录会话、扩展、标签）
能力: Interactive, Read（无 Write）
```

**实现架构**：

```
Codex ↔ Chrome Extension (Native Messaging)
  │
  ├── Chrome Native Host Manifest:
  │   通过 installManifest.mjs 安装
  │
  ├── 脚本工具:
  │   ├── chrome-is-running.js — 检测 Chrome 是否正在运行
  │   ├── open-chrome-window.js — 打开 Chrome 窗口
  │   ├── installed-browsers.js — 检测已安装的浏览器
  │   ├── check-extension-installed.js — 检测扩展是否已安装
  │   ├── check-native-host-manifest.js — 检测 Native Host 是否已注册
  │   └── extension-id.json — Chrome 扩展 ID 配置
  │
  └── browser-client.mjs — 统一的浏览器客户端接口
```

**安全考虑**：
- 可访问用户已登录的任意网站（银行、社交等）⚠️
- 首次访问新网站时需要用户批准
- Chrome 扩展 + Native Messaging 权限模型
- 数据可能用于训练（取决于用户 OpenAI 账户设置）

### 4.3 computer-use（macOS 桌面自动化）

**版本**：1.0.780 | **类别**：Productivity

**功能**：让 Codex 通过 Accessibility API 控制 macOS 桌面上的任意应用。

**架构**：

```
┌───────────────────────────────────────────────────────────────┐
│  Electron Main Process                                         │
│  ├── Plugin Manager                                            │
│  └── spawn: SkyComputerUseClient (MCP Server)                  │
│         │                                                      │
├───────────────────────────────────────────────────────────────┤
│  SkyComputerUseClient.app (Swift, com.openai.sky.CUAService)   │
│  ├── MCP Protocol (stdin/stdout JSON-RPC)                     │
│  ├── AXUIElement API (macOS Accessibility)                     │
│  ├── CGEvent API (键盘/鼠标模拟)                                │
│  └── Screen Capture (CGDisplay)                                │
│                                                               │
│  Bundled Packages:                                             │
│  ├── Package_ComputerUse.bundle — 核心自动化引擎               │
│  ├── Package_SlimCore.bundle — 轻量核心运行时                  │
│  ├── Package_ComputerUseClient.bundle — 客户端                 │
│  └── SwiftProtobuf.bundle — Protocol Buffers 序列化             │
│                                                               │
│  App Instructions (预置应用支持):                               │
│  ├── Notion.md, Spotify.md, AppleMusic.md                     │
│  ├── Numbers.md, Clock.md, iPhone Mirroring.md                │
│  └── 自动更新 Feed: oaisidekickupdates.blob.core.windows.net   │
└───────────────────────────────────────────────────────────────┘
```

**MCP 配置**（.mcp.json）：

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
      "args": ["mcp"],
      "cwd": "."
    }
  }
}
```

**能力范围**：
- 键盘/鼠标模拟（CGEventPost）
- 应用启动和控制（NSWorkspace）
- 屏幕截图（CGWindowListCreateImage）
- UI 元素检查（AXUIElementCopyAttributeValue）
- 窗口管理（ Accessibility window attributes）

**安全考虑**：
- 需要 Accessibility 权限（用户须在系统偏好设置中授予）
- ⚠️ 可控制任何应用（浏览器、邮件、终端、Xcode 等）
- ⚠️ 屏幕截图可能包含敏感信息
- ⚠️ 截图数据可能用于训练（需用户同意）
- 应用审批列表管理访问控制
- Bundle ID: `com.openai.sky.CUAService`

### 4.4 latex-tectonic（LaTeX 编译）

**版本**：0.1.1 | **类别**：Research

**功能**：让 Codex 编译和渲染 LaTeX 文档。

```
latex-tectonic/
├── .codex-plugin/plugin.json
├── skills/latex-tectonic/SKILL.md
├── bin/tectonic                           # Tectonic LaTeX 引擎 (arm64 binary)
├── scripts/tectonic-path.mjs              # 路径解析
├── assets/tex.svg                         # LaTeX 图标
└── THIRD_PARTY_NOTICES.md
```

**Tectonic 引擎**：Rust 编写的现代 LaTeX 编译器，支持自动下载宏包。

**安全考虑**：
- LaTeX 编译器可执行任意 shell 命令（`\write18`）⚠️
- 宏包自动下载（网络访问）
- 文件系统读写（.tex, .pdf, .aux 等）

---

## 5. MCP 集成模式

Codex 插件通过 Model Context Protocol (MCP) 与 LLM Agent 通信：

```typescript
// 插件声明 MCP Server（在 .mcp.json 中）
interface McpConfig {
  mcpServers: Record<string, {
    command: string;        // 可执行文件路径
    args: string[];         // 启动参数
    cwd: string;            // 工作目录
  }>;
}

// MCP Server 进程作为子进程运行，通过 stdin/stdout JSON-RPC 通信
// 主进程 (Electron) → spawn → MCP Server → stdout/stderr 日志
//                                    → stdin JSON-RPC
//                                    → 工具调用执行

// 工具在 Codex Agent 中注册为:
// mcp__{plugin-name}__{tool-name}
// 例如: mcp__computer-use__screenshot
//       mcp__computer-use__click
//       mcp__computer-use__type
```

---

## 6. Skills 系统

**路径**：`$CODEX_HOME/skills/{skillName}/SKILL.md`

Skills 是 Markdown 格式的指令文件，为 LLM 提供特定任务的知识和工作流：

```markdown
---
name: skill-name
description: "简短描述"
---

# Skill Title

使用说明、约束条件、最佳实践、故障排除等...

## Bootstrap
设置步骤（LLM 在执行任务前需要完成的初始化）

## Troubleshooting
常见问题和解决方案

## Runtime Behavior
运行时行为约定
```

**内置 Skills**：
1. `browser/SKILL.md` (browser-use 插件) — 浏览器自动化指令
2. `computer-use/SKILL.md` (computer-use 插件) — 桌面控制指令
3. `latex-tectonic/SKILL.md` (latex-tectonic 插件) — LaTeX 编译指令

---

## 7. 插件生命周期

```typescript
// 插件安装流程（从 main.js 反编译）
interface PluginInstallFlow {
  // 1. 从 marketplace 获取插件元数据
  // 2. 下载/bundle 复制插件到 plugins/{name}/
  // 3. 读取 .codex-plugin/plugin.json
  // 4. 如果有 mcpServers，注册 MCP Server
  // 5. 如果有 skills，注册 Skills
  // 6. 如果 plugin policy 要求认证，触发认证流程
  // 7. 设置为 AVAILABLE 状态
}

// 内置插件的特殊处理
const BUILTIN_PLUGINS: PluginRegistration[] = [
  {
    name: "computer-use",
    autoInstall: true,
    autoInstallOptOutKey: "computer-use-auto-install-opted-out",
    internalOnly: true,  // 仅内部构建
  },
  {
    name: "in-app-browser",
    forceReload: true,
    requiredFeature: "inAppBrowserUseAllowed",
  },
  {
    name: "external-browser",
    requiredFeature: "externalBrowserUseAllowed",
    buildConstraint: "Yn",  // 特定构建类型
  },
  {
    name: "codex-cli",
    requiredFeature: "externalBrowserUseAllowed",
    buildConstraint: "Zn",  // 特定构建类型
  },
];

// 插件缓存
// plugins/cache/{marketplaceName}/ — 下载的 marketplace bundle 缓存
```

---

## 8. 安全分析

### 8.1 信任模型

| 组件 | 信任级别 | 风险 |
|------|----------|------|
| 内置插件（openai-bundled） | 完全信任 | 由 OpenAI 签名和分发 |
| MCP Server 进程 | 完全信任 | 独立进程，通过 JSON-RPC 通信 |
| Skills (SKILL.md) | 指导性 | 仅为 LLM 指令，不直接执行代码 |
| 用户安装的插件 | 用户授权 | 需用户手动安装，来源可能不可信 |

### 8.2 Computer Use 的风险

1. **权限放大**：MCP Server 拥有 Accessibility 权限，可控制任意应用
2. **屏幕捕获**：可能泄露密码、API Key、个人信息
3. **输入模拟**：可执行任意键盘/鼠标操作
4. **数据外泄**：屏幕截图可能发送到远程服务器

### 8.3 Browser Use 的风险

1. **本地文件访问**：file:// 协议可读取本地文件
2. **服务扫描**：localhost 探测可能发现其他服务
3. **XSS**：如果本地应用存在 XSS，可能被利用

### 8.4 LaTeX 的风险

1. **命令执行**：`\write18{shell command}` 可执行任意命令
2. **文件读取**：`\input{/etc/passwd}` 可能读取系统文件
