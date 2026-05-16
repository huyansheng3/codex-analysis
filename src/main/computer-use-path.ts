// ============================================================
// Computer Use 路径查找 — 从 main.js 反编译重建
// 原始 minified code 偏移: ~14300-19300
// ============================================================

import * as path from "node:path";
import * as fs from "node:fs";

// --- 常量 ---

const SKY_CUA_SERVICE_PATH = "SKY_CUA_SERVICE_PATH";
const SKY_CUA_WINDOWS_HELPER_PATH = "SKY_CUA_WINDOWS_HELPER_PATH";
const SERVICE_APP_NAME = "Codex Computer Use.app";
const NODE_MODULE_SEGMENTS = ["node_modules", "@oai", "sky", "package.json"];

// --- 环境注入 ---

function buildComputerUseEnv({
  serviceAppPath,
  windowsHelperPath,
}: {
  serviceAppPath?: string;
  windowsHelperPath?: string;
} = {}): Record<string, string> {
  return {
    ...(serviceAppPath == null
      ? {}
      : { [SKY_CUA_SERVICE_PATH]: serviceAppPath }),
    ...(windowsHelperPath == null
      ? {}
      : { [SKY_CUA_WINDOWS_HELPER_PATH]: windowsHelperPath }),
  };
}

// --- Service App 路径查找 (macOS) ---

function resolveServiceAppPath({
  env = process.env,
  installedPluginServiceAppPath,
  pathExists = fs.existsSync,
}: {
  env?: NodeJS.ProcessEnv;
  installedPluginServiceAppPath?: string;
  pathExists?: (p: string) => boolean;
} = {}): string | null {
  // 1. 环境变量最高优先级
  const envPath = env[SKY_CUA_SERVICE_PATH]?.trim();
  if (envPath) return envPath;

  // 2. 已安装插件中的路径
  const pluginPath = installedPluginServiceAppPath?.trim();
  if (pluginPath && pathExists(pluginPath)) return pluginPath;

  return null;
}

// --- Windows Helper 路径查找 ---

function resolveWindowsHelperPath({
  env = process.env,
  installedPluginPath,
  pathExists = fs.existsSync,
}: {
  env?: NodeJS.ProcessEnv;
  installedPluginPath?: string;
  pathExists?: (p: string) => boolean;
} = {}): string | null {
  // 1. 环境变量
  const envPath = env[SKY_CUA_WINDOWS_HELPER_PATH]?.trim();
  if (envPath) return envPath;

  // 2. 已安装插件中的 bin/computer-use-helper.exe
  const pluginRoot = installedPluginPath?.trim();
  if (!pluginRoot) return null;

  const winHelperPath = path.join(pluginRoot, "bin", "computer-use-helper.exe");
  return pathExists(winHelperPath) ? winHelperPath : null;
}

// --- 完整的 Computer Use 路径解析 ---

function resolveComputerUsePaths({
  env = process.env,
  installedPluginRoot,
  pathExists = fs.existsSync,
}: {
  env?: NodeJS.ProcessEnv;
  installedPluginRoot?: string;
  pathExists?: (p: string) => boolean;
} = {}): {
  nodeModuleDirs: string[];
  serviceAppPath: string | null;
  windowsHelperPath: string | null;
} {
  const pluginRoot = installedPluginRoot?.trim() || null;

  const serviceAppPath = resolveServiceAppPath({
    env,
    installedPluginServiceAppPath:
      pluginRoot == null
        ? null
        : path.join(pluginRoot, SERVICE_APP_NAME),
    pathExists,
  });

  return {
    nodeModuleDirs:
      pluginRoot != null &&
      pathExists(path.join(pluginRoot, ...NODE_MODULE_SEGMENTS))
        ? [path.join(pluginRoot, "node_modules")]
        : [],
    serviceAppPath,
    windowsHelperPath: resolveWindowsHelperPath({
      env,
      installedPluginPath: pluginRoot,
      pathExists,
    }),
  };
}

// --- 从 Marketplaces 中查找 ---

interface Marketplace {
  name: string;
  path?: string;
  plugins: Plugin[];
}

interface Plugin {
  name: string;
  installed?: boolean;
  enabled?: boolean;
  source?: {
    type: string;
    path?: string;
  };
}

function getMarketplaces({
  marketplaceName,
  marketplaces,
}: {
  marketplaceName: string;
  marketplaces: Marketplace[];
}): Marketplace[] {
  const names = [marketplaceName /* , DEFAULT_MARKETPLACE_NAME */];
  const uniqueNames = names.filter((n, i, arr) => arr.indexOf(n) === i);
  return uniqueNames.flatMap((name) =>
    marketplaces.filter((m) => m.name === name)
  );
}

function findPluginInMarketplaces({
  marketplaceName,
  marketplaces,
  pluginName,
}: {
  marketplaceName: string;
  marketplaces: Marketplace[];
  pluginName: string;
}): { marketplace: Marketplace; plugin: Plugin } | null {
  for (const mp of getMarketplaces({ marketplaceName, marketplaces })) {
    const plugin = mp.plugins.find(
      (p) => p.name === pluginName
    );
    if (mp.path != null && plugin != null) {
      return {
        marketplace: { ...mp, path: mp.path },
        plugin,
      };
    }
  }
  return null;
}

/**
 * 主入口：解析 Computer Use 的所有路径
 *
 * 查找优先级:
 * 1. 环境变量 SKY_CUA_SERVICE_PATH / SKY_CUA_WINDOWS_HELPER_PATH
 * 2. 已安装的 computer-use 插件目录
 * 3. 内置 bundled plugin 路径（遍历 marketplaces）
 */
function resolveComputerUsePath({
  env = process.env,
  marketplaceName,
  marketplaces,
  pathExists = fs.existsSync,
}: {
  env?: NodeJS.ProcessEnv;
  marketplaceName: string;
  marketplaces: Marketplace[];
  pathExists?: (p: string) => boolean;
}): ReturnType<typeof resolveComputerUsePaths> {
  // 先查 marketplaces 中 computer-use 插件
  for (const mp of getMarketplaces({ marketplaceName, marketplaces })) {
    const plugin = mp.plugins.find(
      (p) =>
        p.name === "computer-use" &&
        p.installed &&
        p.enabled &&
        p.source?.type === "local"
    );
    if (plugin?.source?.type === "local" && plugin.source.path) {
      return resolveComputerUsePaths({
        env,
        installedPluginRoot: plugin.source.path,
        pathExists,
      });
    }
  }
  return resolveComputerUsePaths({ env, pathExists });
}

export {
  resolveComputerUsePath,
  resolveComputerUsePaths,
  resolveServiceAppPath,
  resolveWindowsHelperPath,
  buildComputerUseEnv,
  SKY_CUA_SERVICE_PATH,
  SKY_CUA_WINDOWS_HELPER_PATH,
  SERVICE_APP_NAME,
};
