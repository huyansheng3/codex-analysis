// ============================================================
// Codex Bootstrap 启动流程 — 从 bootstrap.js + main.js 逆向重建
// 文件: .vite/build/bootstrap.js (3,754 bytes)
// ============================================================

import { app, BrowserWindow, dialog } from "electron";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

// --- 构建类型 ---

type BuildFlavor = "prod" | "staging" | "dev" | "agent";

function resolveBuildFlavor(env: NodeJS.ProcessEnv): BuildFlavor {
  // 1. CODEX_BUILD_FLAVOR 环境变量
  if (env.CODEX_BUILD_FLAVOR) {
    return env.CODEX_BUILD_FLAVOR.trim() as BuildFlavor;
  }
  // 2. package.json codexBuildFlavor
  // 3. 默认 production
  return "prod";
}

function isInternal(buildFlavor: BuildFlavor): boolean {
  return buildFlavor === "staging" || buildFlavor === "agent";
}

// --- 应用名 ---

function getAppName(buildFlavor: BuildFlavor): string {
  switch (buildFlavor) {
    case "agent":   return "Codex Agent";
    case "dev":     return "Codex Dev";
    case "staging": return "Codex Staging";
    default:        return "Codex";
  }
}

// --- 用户数据路径 ---

function resolveUserDataPath({
  appDataPath,
  buildFlavor,
  env,
}: {
  appDataPath: string;
  buildFlavor: BuildFlavor;
  env: NodeJS.ProcessEnv;
}): string {
  const override = env.CODEX_ELECTRON_USER_DATA_PATH?.trim();
  if (override) return path.resolve(override);

  const basePath = path.join(appDataPath, getAppName(buildFlavor));

  if (buildFlavor === "agent") {
    const agentRunId = env.CODEX_ELECTRON_AGENT_RUN_ID?.trim() ?? null;
    if (agentRunId != null) {
      return path.join(basePath, "agent", agentRunId);
    }
  }
  return basePath;
}

// --- Intel-on-Apple-Silicon 检测 ---

function isRosetta(): boolean {
  try {
    const result = execFileSync("sysctl", ["-in", "sysctl.proc_translated"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.trim() === "1";
  } catch {
    return false;
  }
}

async function showIntelWarningIfNeeded({
  appName,
  environment,
}: {
  appName: string;
  environment: { arch: string; isPackaged: boolean; platform: string };
}): Promise<boolean> {
  if (!environment.isPackaged) return false;
  if (environment.platform !== "darwin") return false;
  if (environment.arch !== "x64") return false;
  if (!isRosetta()) return false;

  const result = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Quit", "Continue Anyway"],
    defaultId: 0,
    cancelId: 0,
    message: `${appName} is running the Intel build on an Apple Silicon Mac`,
    detail: "This build works through Rosetta, but the Apple Silicon " +
      "build launches faster and performs better. Quit now to install " +
      "the Apple Silicon build, or continue with the Intel build.",
  });

  return result.response === 0; // true = user chose Quit
}

// --- 启动错误恢复 ---

enum StartupDialogAction {
  InstallUpdate = "install-update",
  CheckForUpdates = "check-for-updates",
  Quit = "quit",
}

async function showStartupErrorDialog(
  error: Error,
  sparkleManager: SparkleManager
): Promise<void> {
  const updateReady = sparkleManager.getIsUpdateReady();
  const hasUpdater = sparkleManager.hasUpdater();

  const actions: StartupDialogAction[] = updateReady
    ? [StartupDialogAction.InstallUpdate, StartupDialogAction.Quit]
    : hasUpdater
      ? [StartupDialogAction.CheckForUpdates, StartupDialogAction.Quit]
      : [StartupDialogAction.Quit];

  const labels: Record<StartupDialogAction, string> = {
    [StartupDialogAction.InstallUpdate]: "Install Update",
    [StartupDialogAction.CheckForUpdates]: "Check for Updates",
    [StartupDialogAction.Quit]: "Quit",
  };

  const result = await dialog.showMessageBox({
    type: "error",
    buttons: actions.map((a) => labels[a]),
    defaultId: 0,
    cancelId: actions.length - 1,
    message: `${app.getName()} failed to start.`,
    detail: error instanceof Error
      ? error.message
      : "The main desktop app failed during startup.",
  });

  const action = actions[result.response] ?? StartupDialogAction.Quit;
  switch (action) {
    case StartupDialogAction.InstallUpdate:
      await sparkleManager.installUpdatesIfAvailable();
      break;
    case StartupDialogAction.CheckForUpdates:
      await sparkleManager.checkForUpdates();
      break;
    case StartupDialogAction.Quit:
      app.quit();
      break;
  }
}

// --- 主入口 ---

async function main(): Promise<void> {
  const isMacOS = process.platform === "darwin";
  const buildFlavor = resolveBuildFlavor(process.env);

  // 1. 设置应用名
  app.setName(getAppName(buildFlavor));

  // 2. 设置用户数据路径
  app.setPath(
    "userData",
    resolveUserDataPath({
      appDataPath: app.getPath("appData"),
      buildFlavor,
      env: process.env,
    })
  );

  // 3. Windows: 设置 AppUserModelId
  if (process.platform === "win32") {
    // app.setAppUserModelId(getWindowsAppId(buildFlavor))
  }

  // 4. 单实例锁
  const useSingleInstanceLock = !(!isMacOS || !app.isPackaged);
  if (useSingleInstanceLock && !app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }

  // 5. 注册 second-instance 处理器
  if (useSingleInstanceLock) {
    app.on("second-instance", (_event, argv) => {
      // queueSecondInstanceArgs(argv)
    });
  }

  // 6. whenReady
  await app.whenReady();

  // 7. Intel-on-Apple-Silicon 警告
  const shouldQuit = await showIntelWarningIfNeeded({
    appName: app.getName(),
    environment: {
      arch: process.arch,
      isPackaged: app.isPackaged,
      platform: process.platform,
    },
  });
  if (shouldQuit) {
    app.quit();
    return;
  }

  // 8. 初始化 Sparkle
  // await sparkleManager.initialize();

  // 9. 加载主进程主模块
  try {
    const { runMainAppStartup } = await import("./main");
    await runMainAppStartup();
  } catch (error) {
    // 清理窗口
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.destroy();
    }
    // await showStartupErrorDialog(error, sparkleManager);
  }
}

// --- 类型占位 ---

interface SparkleManager {
  getIsUpdateReady(): boolean;
  hasUpdater(): boolean;
  installUpdatesIfAvailable(): Promise<void>;
  checkForUpdates(): Promise<void>;
  initialize(): Promise<void>;
}

main();
