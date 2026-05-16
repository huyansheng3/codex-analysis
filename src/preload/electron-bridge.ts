// ============================================================
// Codex electronBridge API — 从 preload.js 逆向重建
// 文件: .vite/build/preload.js (2,374 bytes)
// ============================================================

import type { IpcRendererEvent } from "electron";

// --- 基础类型 ---

/**
 * 渲染进程的窗口类型标识
 * 在 preload.js 中硬编码为 "electron"
 */
type WindowType = "electron";

/**
 * 消息从 View 发送到主进程的通用结构
 * 通过 codex_desktop:message-from-view 通道
 */
interface ViewMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Sentry 初始化选项
 * 包含 Codex App Session ID
 */
interface SentryInitOptions {
  dsn: string;
  environment: string;
  release: string;
  codexAppSessionId: string;
  [key: string]: unknown;
}

/**
 * 原生上下文菜单选项
 */
interface ContextMenuOptions {
  // 具体的菜单项配置
  [key: string]: unknown;
}

// --- 完整的 Electron Bridge API ---

interface ElectronBridge {
  // === 身份 ===
  /** 窗口类型，固定为 "electron" */
  readonly windowType: WindowType;

  // === 消息通信 ===

  /**
   * 从渲染进程发送消息到主进程
   * IPC: ipcRenderer.invoke('codex_desktop:message-from-view', message)
   */
  sendMessageFromView(message: ViewMessage): Promise<void>;

  /**
   * 向 Worker 线程发送消息
   * IPC: ipcRenderer.invoke(`codex_desktop:worker:${workerName}:from-view`, message)
   */
  sendWorkerMessageFromView(workerName: string, message: unknown): Promise<void>;

  /**
   * 订阅来自 Worker 线程的消息
   * IPC: ipcRenderer.on(`codex_desktop:worker:${workerName}:for-view`, handler)
   * @returns 取消订阅函数
   */
  subscribeToWorkerMessages(
    workerName: string,
    callback: (message: unknown) => void
  ): () => void;

  // === 文件系统 ===

  /**
   * 将 file:// URL 转换为本地文件路径
   * 使用 electron.webUtils.getPathForFile()
   */
  getPathForFile(fileUrl: string): string | null;

  // === 共享状态 ===

  /**
   * 获取 SharedObject 中某个 key 的快照值
   * IPC: ipcRenderer.sendSync('codex_desktop:get-shared-object-snapshot')
   */
  getSharedObjectSnapshotValue(key: string): unknown;

  // === 菜单 ===

  /**
   * 显示原生上下文菜单（右键菜单）
   * IPC: ipcRenderer.invoke('codex_desktop:show-context-menu', options)
   */
  showContextMenu(options: ContextMenuOptions): Promise<void>;

  /**
   * 在指定坐标显示应用菜单栏的下拉菜单
   * IPC: ipcRenderer.invoke('codex_desktop:show-application-menu', {menuId, x, y})
   */
  showApplicationMenu(menuId: string, x: number, y: number): Promise<void>;

  // === 主题 ===

  /**
   * 获取系统当前的主题变体
   * IPC: ipcRenderer.sendSync('codex_desktop:get-system-theme-variant')
   */
  getSystemThemeVariant(): "light" | "dark";

  /**
   * 订阅系统主题变化通知
   * IPC: ipcRenderer.on('codex_desktop:system-theme-variant-updated', handler)
   * @returns 取消订阅函数
   */
  subscribeToSystemThemeVariant(callback: () => void): () => void;

  // === Sentry ===

  /** 获取 Sentry 初始化配置 */
  getSentryInitOptions(): SentryInitOptions;

  /** 获取 App Session ID */
  getAppSessionId(): string;

  /** 触发 Sentry 测试错误（调试用） */
  triggerSentryTestError(): Promise<void>;

  // === 构建信息 ===

  /** 获取当前构建类型 */
  getBuildFlavor(): string;

  // === Fast Mode ===

  /** 获取 Fast Mode rollout 指标 */
  getFastModeRolloutMetrics(data: unknown): Promise<unknown>;
}

// --- 全局声明 ---

declare global {
  interface Window {
    /** Codex 渲染进程 bridge API */
    electronBridge: ElectronBridge;
    /** 窗口类型标识 */
    codexWindowType: WindowType;
  }
}

export type {
  ElectronBridge,
  ViewMessage,
  SentryInitOptions,
  ContextMenuOptions,
};
