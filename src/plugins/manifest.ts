// ============================================================
// Codex Plugin Manifest 规范 — 从 marketplace.json + plugin.json 逆向重建
// ============================================================

// --- Marketplace Manifest ---

interface MarketplaceManifest {
  /** marketplace 唯一标识符 */
  name: string;

  interface: {
    displayName: string;
  };

  /** 包含的插件列表 */
  plugins: PluginEntry[];
}

interface PluginEntry {
  /** 插件名（kebab-case） */
  name: string;
  source: {
    source: "local" | "remote";
    /** 相对路径到插件目录（local 时） */
    path?: string;
    /** 远程 URL（remote 时） */
    url?: string;
  };
  policy: {
    installation: "AVAILABLE" | "RESTRICTED" | "DISABLED";
    authentication: "ON_INSTALL" | "NONE" | "REQUIRED";
  };
  /** UI 分类 */
  category: "Engineering" | "Productivity" | "Research";
}

// --- Plugin Manifest (.codex-plugin/plugin.json) ---

interface PluginManifest {
  // === 基本信息 ===
  name: string;
  version: string;
  /**
   * 给 LLM 的完整功能描述
   * 包含别名（@alias）和触发条件
   */
  description: string;
  author: {
    name: string;
    email?: string;
    url?: string;
  };
  homepage?: string;
  repository?: string;
  license: string | "Proprietary";
  keywords: string[];

  // === 技能和 MCP ===
  /** skills 目录路径 */
  skills?: string;
  /** MCP 配置 JSON 文件路径 */
  mcpServers?: string;

  // === UI 界面 ===
  interface: {
    displayName: string;
    shortDescription: string;
    longDescription: string;
    developerName: string;
    category: string;
    capabilities: Array<"Interactive" | "Read" | "Write">;
    websiteURL: string;
    privacyPolicyURL: string;
    termsOfServiceURL: string;
    /** 推荐提示示例 */
    defaultPrompt: string[];
    /** Brand color */
    brandColor: string;
    /** 编辑器中的图标 */
    composerIcon?: string;
    /** 插件 Logo 图标路径 */
    logo: string;
    /** 截图（通常为空） */
    screenshots: string[];
  };
}

// --- MCP 配置 ---

interface McpConfig {
  mcpServers: Record<
    string,
    {
      /** MCP Server 可执行文件路径 */
      command: string;
      /** 启动参数 */
      args: string[];
      /** 工作目录 */
      cwd: string;
    }
  >;
}

// --- Skills ---

/**
 * Skills 是 Markdown 格式的指令文件
 * 路径: skills/{skillName}/SKILL.md
 */
interface SkillMetadata {
  name: string;
  description: string;
}

// --- 内置插件清单 ---

const BUILTIN_PLUGINS = {
  /** 应用内浏览器自动化 */
  browserUse: {
    name: "browser-use",
    version: "0.1.0-alpha2",
    category: "Engineering" as const,
    description:
      "Browser / browser-use plugin\n\n" +
      "Aliases: @browser, @browser-use, browser-use, Browser, in-app browser.\n\n" +
      "Use Browser, the Codex in-app browser, when the user asks to open, " +
      "inspect, navigate, test, click, type, or screenshot local web targets " +
      "such as localhost, 127.0.0.1, ::1, file:// URLs, or the current " +
      "in-app browser tab.",
    capabilities: ["Interactive", "Read", "Write"] as const,
    brandColor: "#013B7B",
  },

  /** Chrome 浏览器控制 */
  chrome: {
    name: "chrome",
    version: "0.1.7",
    category: "Productivity" as const,
    description:
      "Chrome automation for remote URLs, authenticated/profile-dependent " +
      "pages, existing Chrome tabs, cookies, extensions, and Codex Chrome " +
      "Extension setup.",
    capabilities: ["Interactive", "Read"] as const,
    brandColor: "#10A37F",
  },

  /** macOS 桌面自动化 */
  computerUse: {
    name: "computer-use",
    version: "1.0.780",
    category: "Productivity" as const,
    description:
      "Control desktop apps on macOS from Codex through Computer Use.",
    capabilities: ["Interactive", "Read", "Write"] as const,
    brandColor: "#0F172A",
    mcpServer: {
      command:
        "./Codex Computer Use.app/Contents/SharedSupport/" +
        "SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
      args: ["mcp"],
      cwd: ".",
    },
  },

  /** LaTeX 编译 */
  latexTectonic: {
    name: "latex-tectonic",
    version: "0.1.1",
    category: "Research" as const,
    description:
      "Bundled LaTeX compiler using the Tectonic engine.",
    capabilities: ["Read", "Write"] as const,
  },
} as const;

// --- 插件注册（从 main.js 反编译） ---

interface PluginRegistration {
  name: string;
  /** 是否自动安装（如果缺失） */
  autoInstall?: boolean;
  /** 自动安装的 opt-out key */
  autoInstallOptOutKey?: string;
  /** 是否仅内部构建可用 */
  internalOnly?: boolean;
  /** 是否需要强制重载 */
  forceReload?: boolean;
  /** 依赖的 Feature Flag */
  requiredFeature?: string;
  /** 构建约束 */
  buildConstraint?: string;
}

const REGISTERED_PLUGINS: PluginRegistration[] = [
  {
    name: "computer-use",
    autoInstall: true,
    autoInstallOptOutKey: "computer-use-auto-install-opted-out",
    internalOnly: true,
  },
  {
    name: "in-app-browser",
    forceReload: true,
    requiredFeature: "inAppBrowserUseAllowed",
  },
  {
    name: "external-browser",
    requiredFeature: "externalBrowserUseAllowed",
  },
  {
    name: "codex-cli",
    requiredFeature: "externalBrowserUseAllowed",
  },
];

// --- 插件路径和缓存 ---

const PLUGIN_PATHS = {
  /** 已安装插件目录 */
  installed: (codexHome: string, pluginName: string) =>
    `${codexHome}/plugins/${pluginName}/`,

  /** Marketplace bundle 缓存 */
  marketplaceCache: (codexHome: string, marketplaceName: string) =>
    `${codexHome}/.tmp/bundled-marketplaces/${marketplaceName}/`,

  /** 插件 manifest 文件 */
  manifest: (pluginDir: string) =>
    `${pluginDir}/.codex-plugin/plugin.json`,

  /** Skills 目录 */
  skills: (pluginDir: string) =>
    `${pluginDir}/skills/`,
};

export type {
  MarketplaceManifest,
  PluginEntry,
  PluginManifest,
  McpConfig,
  SkillMetadata,
  PluginRegistration,
};

export {
  BUILTIN_PLUGINS,
  REGISTERED_PLUGINS,
  PLUGIN_PATHS,
};
