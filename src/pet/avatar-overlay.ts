// ============================================================
// Codex Avatar Overlay / 浮动窗口系统 — 从 main.js + preload.js 逆向重建
// 桌面宠物的窗口管理、位置控制、交互事件
// ============================================================

import { BrowserWindow, screen, globalShortcut, ipcMain, app } from "electron";
import type { PetCharacter, PetPhysics } from "./spritesheet-engine";

// --- 窗口类型常量 ---

/**
 * Codex 支持的 8 种窗口类型（从 main.js 反编译）
 */
const WindowTypes = {
  MAIN: "electron-main-window",
  COMMENT_SIDEBAR: "comment-sidebar",
  AVATAR_OVERLAY: "avatar-overlay",
  HOTKEY_WINDOW: "hotkey-window",
  SETTINGS: "settings-window",
  ONBOARDING: "onboarding-window",
  PERMISSIONS: "permissions-window",
  COMPUTER_USE: "computer-use-window",
} as const;

// --- Avatar Overlay 窗口配置 ---

interface AvatarOverlayConfig {
  /** 当前选择的宠物角色 */
  character: PetCharacter;
  /** 宠物缩放比例（1.0 = 原始大小） */
  scale: number;
  /** 是否始终置顶 */
  alwaysOnTop: boolean;
  /** 是否在所有桌面工作区可见 */
  visibleOnAllWorkspaces: boolean;
  /** 是否允许用户拖拽移动 */
  draggable: boolean;
  /** 是否忽略鼠标事件（click-through） */
  ignoreMouseEvents: boolean;
  /** 透明度（0-1），用于睡眠时的淡出 */
  opacity: number;
  /** 是否隐藏（睡眠/关闭状态） */
  hidden: boolean;
  /** 固定位置（null = 自由浮动） */
  anchoredPosition: { x: number; y: number } | null;
}

/**
 * 从 main.js 偏移 6500 附近反编译的 Avatar Overlay 默认配置
 */
function getDefaultAvatarOverlayConfig(): AvatarOverlayConfig {
  return {
    character: "codex" as PetCharacter,
    scale: 1.0,
    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    draggable: true,
    ignoreMouseEvents: true, // 默认穿透鼠标，点击时切换
    opacity: 1.0,
    hidden: false,
    anchoredPosition: null,
  };
}

// --- Avatar Overlay BrowserWindow ---

/**
 * Codex 的桌面宠物窗口管理器
 *
 * 关键行为（从 main.js 反编译）：
 * 1. 创建一个透明的、无边框的 BrowserWindow
 * 2. 使用 setAlwaysOnTop(true, "screen-saver") 确保在所有窗口之上
 * 3. 使用 setVisibleOnAllWorkspaces(true) 在所有桌面空间可见
 * 4. 使用 setIgnoreMouseEvents(true, { forward: true }) 鼠标穿透
 * 5. 宠物窗口在用户点击时获取焦点，可交互
 * 6. 窗口位置由主进程管理，支持吸附屏幕边缘
 * 7. 全局快捷键可显示/隐藏宠物（Cmd+Shift+P 推测）
 */
class AvatarOverlayWindow {
  private window: BrowserWindow | null = null;
  private config: AvatarOverlayConfig;
  private physics: PetPhysics;
  private petSize = { w: 128, h: 128 };
  private animationTimer: ReturnType<typeof setInterval> | null = null;
  private edgeSnapThreshold = 30; // px，吸附阈值

  constructor(config?: Partial<AvatarOverlayConfig>) {
    this.config = { ...getDefaultAvatarOverlayConfig(), ...config };
    this.physics = this.initPhysics();
  }

  private initPhysics(): PetPhysics {
    const display = screen.getPrimaryDisplay();
    const bounds = display.workArea;
    return {
      position: {
        // 默认位置：右下角
        x: bounds.x + bounds.width - this.petSize.w - 20,
        y: bounds.y + bounds.height - this.petSize.h - 20,
      },
      velocity: { x: 0, y: 0 },
      facing: 1,
      isDragging: false,
      gravity: true,
    };
  }

  // --- 窗口创建 ---

  async create(): Promise<void> {
    const display = screen.getPrimaryDisplay();

    this.window = new BrowserWindow({
      width: this.petSize.w,
      height: this.petSize.h,
      x: Math.round(this.physics.position.x),
      y: Math.round(this.physics.position.y),

      // 无边框 + 透明
      frame: false,
      transparent: true,
      hasShadow: false,

      // 浮动特性
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      skipTaskbar: true,

      // 不获取焦点
      focusable: false,

      // 鼠标穿透（默认）
      // 注意：需要在渲染进程加载完成后设置

      // 无标题栏
      titleBarStyle: "hidden",

      // WebPreferences
      webPreferences: {
        preload: "preload.js",
        sandbox: true,
        contextIsolation: true,
        offscreen: false,
      },

      // 不在 Mission Control 中显示
      type: "panel",
    });

    // 设置窗口层级（macOS: kCGFloatingWindowLevel = 5）
    // 通过 objc-js: NSWindow.setLevel(5)
    this.window.setAlwaysOnTop(true, "screen-saver");

    // 所有工作区可见
    this.window.setVisibleOnAllWorkspaces(true);

    // 鼠标穿透（默认）
    this.window.setIgnoreMouseEvents(true, { forward: true });

    // 加载宠物渲染页面
    await this.window.loadURL(
      `app://avatar-overlay/index.html?character=${this.config.character}&scale=${this.config.scale}`
    );

    // 设置窗口内容保护（防止截屏？实际是 allow）
    // this.window.setContentProtection(true);

    // 监听屏幕变化，重新吸附位置
    screen.on("display-metrics-changed", () => this.snapToEdge());

    // 监听窗口移动（用户拖拽后）
    this.window.on("moved", () => {
      const bounds = this.window!.getBounds();
      this.physics.position.x = bounds.x;
      this.physics.position.y = bounds.y;
    });
  }

  // --- 位置和移动 ---

  /**
   * 把宠物吸附到最近的屏幕边缘
   */
  snapToEdge(): void {
    if (!this.window || this.physics.isDragging) return;

    const display = screen.getDisplayNearestPoint({
      x: this.physics.position.x + this.petSize.w / 2,
      y: this.physics.position.y + this.petSize.h / 2,
    });
    const bounds = display.workArea;

    const distToLeft = this.physics.position.x - bounds.x;
    const distToRight = bounds.x + bounds.width - (this.physics.position.x + this.petSize.w);
    const distToTop = this.physics.position.y - bounds.y;
    const distToBottom = bounds.y + bounds.height - (this.physics.position.y + this.petSize.h);

    const minDist = Math.min(distToLeft, distToRight, distToTop, distToBottom);

    if (minDist > this.edgeSnapThreshold) return;

    if (minDist === distToLeft) {
      this.physics.position.x = bounds.x;
    } else if (minDist === distToRight) {
      this.physics.position.x = bounds.x + bounds.width - this.petSize.w;
    } else if (minDist === distToBottom) {
      this.physics.position.y = bounds.y + bounds.height - this.petSize.h;
    }

    this.setPosition(this.physics.position.x, this.physics.position.y);
  }

  setPosition(x: number, y: number): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.setPosition(Math.round(x), Math.round(y));
    }
  }

  moveBy(dx: number, dy: number): void {
    this.physics.position.x += dx;
    this.physics.position.y += dy;
    this.setPosition(this.physics.position.x, this.physics.position.y);
  }

  // --- 显示控制 ---

  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.showInactive(); // 不抢焦点
      this.config.hidden = false;
    }
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.hide();
      this.config.hidden = true;
    }
  }

  toggleVisibility(): void {
    if (this.config.hidden) {
      this.show();
    } else {
      this.hide();
    }
  }

  setOpacity(opacity: number): void {
    this.config.opacity = Math.max(0, Math.min(1, opacity));
    if (this.window && !this.window.isDestroyed()) {
      this.window.setOpacity(this.config.opacity);
    }
  }

  fadeOut(durationMs = 500): void {
    if (!this.window) return;
    const steps = 20;
    const interval = durationMs / steps;
    const delta = 1 / steps;

    let step = 0;
    const timer = setInterval(() => {
      step++;
      this.setOpacity(1 - step * delta);
      if (step >= steps) {
        clearInterval(timer);
        this.hide();
      }
    }, interval);
  }

  // --- 交互事件 ---

  /**
   * 用户开始拖拽宠物
   */
  onDragStart(): void {
    this.physics.isDragging = true;
    this.physics.gravity = false;
    if (this.window && !this.window.isDestroyed()) {
      this.window.setIgnoreMouseEvents(false);
      this.window.focus();
    }
    // 通过 IPC 通知渲染进程切换到 dragging 动画
    this.window?.webContents.send("avatar-overlay:state-change", { state: "dragging" });
  }

  /**
   * 用户释放宠物
   */
  onDragEnd(): void {
    this.physics.isDragging = false;
    this.physics.gravity = true;
    if (this.window && !this.window.isDestroyed()) {
      this.window.setIgnoreMouseEvents(true, { forward: true });
    }
    this.snapToEdge();
    this.window?.webContents.send("avatar-overlay:state-change", { state: "idle" });
  }

  onClick(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("avatar-overlay:state-change", { state: "interact" });
    }
  }

  // --- 周期性随机行为 ---

  /**
   * 启动宠物的自主行为循环
   * 宠物会周期性地随机走动、改变位置
   */
  startAutonomousBehavior(): void {
    const behaviors = [
      () => {
        // 随机小步移动
        const dx = (Math.random() - 0.5) * 100;
        this.moveBy(dx, 0);
        this.physics.facing = dx > 0 ? 1 : -1;
      },
      () => {
        // 跳到屏幕另一边
        const display = screen.getPrimaryDisplay();
        this.physics.position.x = display.workArea.x + Math.random() * (display.workArea.width - this.petSize.w);
        this.setPosition(this.physics.position.x, this.physics.position.y);
      },
      () => {
        // 什么都不做（单纯 idle）
      },
    ];

    this.animationTimer = setInterval(() => {
      if (this.physics.isDragging || this.config.hidden) return;
      const behavior = behaviors[Math.floor(Math.random() * behaviors.length)];
      behavior();
    }, 15000 + Math.random() * 30000); // 15-45s 之间随机触发
  }

  stopAutonomousBehavior(): void {
    if (this.animationTimer != null) {
      clearInterval(this.animationTimer);
      this.animationTimer = null;
    }
  }

  // --- 销毁 ---

  destroy(): void {
    this.stopAutonomousBehavior();
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
  }
}

// --- 全局快捷键注册 ---

/**
 * Codex 的全局快捷键（从 main.js 偏移 ~7800 处反编译）
 */
interface GlobalHotkey {
  accelerator: string;
  action: string;
}

const DEFAULT_HOTKEYS: GlobalHotkey[] = [
  { accelerator: "Cmd+Shift+P", action: "toggle-avatar-overlay" },
  { accelerator: "Cmd+Shift+Space", action: "hotkey-window" },
  { accelerator: "Cmd+Shift+O", action: "open-main-window" },
];

function registerGlobalHotkeys(
  handlers: Record<string, () => void>,
): void {
  for (const hotkey of DEFAULT_HOTKEYS) {
    const handler = handlers[hotkey.action];
    if (handler) {
      globalShortcut.register(hotkey.accelerator, handler);
    }
  }

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });
}

// --- 窗口间通信 ---

/**
 * 主进程中的 avatar-overlay IPC 消息处理
 *
 * 消息流:
 *   渲染进程 (React SPA) → 主进程 → Avatar Overlay 窗口
 *   或反向：Avatar Overlay → 主进程 → 渲染进程
 */

interface AvatarOverlayMessage {
  type:
    | "avatar-overlay-open-state-changed"
    | "avatar-overlay-layout-changed"
    | "avatar-overlay-character-changed"
    | "avatar-overlay-scale-changed";
  [key: string]: unknown;
}

function setupAvatarIPCHandlers(overlay: AvatarOverlayWindow): void {
  // 渲染进程请求改变 overlay 状态
  ipcMain.on("codex_desktop:message-from-view", (_event, message: AvatarOverlayMessage) => {
    switch (message.type) {
      case "avatar-overlay-open-state-changed":
        if (message.open) {
          overlay.show();
        } else {
          overlay.hide();
        }
        break;

      case "avatar-overlay-layout-changed":
        if (typeof message.x === "number" && typeof message.y === "number") {
          overlay.setPosition(message.x, message.y);
        }
        break;

      case "avatar-overlay-character-changed":
        // 切换宠物角色，需要重新加载 overlay 页面
        // overlay.reloadWithCharacter(message.character)
        break;

      case "avatar-overlay-scale-changed":
        // overlay.setScale(message.scale)
        break;
    }
  });
}

// --- 头像叠加层在 React 侧的状态管理 ---

/**
 * React 组件中 avatar-overlay 的状态
 * 通过 SharedObject 在主进程和渲染进程间同步
 */
interface AvatarOverlayState {
  isOpen: boolean;
  character: PetCharacter;
  scale: number;
  position: { x: number; y: number };
  /** 上一次用户交互时间戳 */
  lastInteractionAt: number;
  /** 当前动画状态 */
  animationState: string;
  /** 是否正在被拖拽 */
  isDragging: boolean;
}

export {
  AvatarOverlayWindow,
  WindowTypes,
  registerGlobalHotkeys,
  setupAvatarIPCHandlers,
  getDefaultAvatarOverlayConfig,
  DEFAULT_HOTKEYS,
};

export type {
  AvatarOverlayConfig,
  AvatarOverlayMessage,
  AvatarOverlayState,
  GlobalHotkey,
};
