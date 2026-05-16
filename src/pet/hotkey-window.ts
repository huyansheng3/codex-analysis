// ============================================================
// Codex Hotkey Window — 全局快捷键浮动窗口
// 从 main.js 偏移 ~8200 + hotkey-window IPC 消息类型 逆向重建
// ============================================================

import { BrowserWindow, screen, globalShortcut, ipcMain } from "electron";

// --- 窗口配置 ---

interface HotkeyWindowConfig {
  /** 窗口宽 */
  width: number;
  /** 窗口高 */
  height: number;
  /** 是否启用快捷键 */
  enabled: boolean;
  /** 快捷键组合 */
  accelerator: string;
  /** 动画过渡时长 (ms) */
  transitionDuration: number;
}

const DEFAULT_HOTKEY_WINDOW_CONFIG: HotkeyWindowConfig = {
  width: 440,
  height: 560,
  enabled: true,
  accelerator: "Cmd+Shift+Space",
  transitionDuration: 200,
};

// --- 窗口位置计算 ---

/**
 * Hotkey Window 出现位置：屏幕中央偏上
 *
 * 行为（从 main.js 反编译）：
 * 1. 按下快捷键 → 窗口出现在鼠标所在屏幕的中央
 * 2. 如果窗口已打开 → 关闭
 * 3. 窗口失去焦点 → 自动关闭
 * 4. ESC → 关闭
 */
function calculateHotkeyWindowPosition(
  display: Electron.Display,
  config: HotkeyWindowConfig,
): { x: number; y: number } {
  const bounds = display.workArea;
  return {
    x: Math.round(bounds.x + (bounds.width - config.width) / 2),
    y: Math.round(bounds.y + (bounds.height - config.height) / 3), // 偏上 1/3 处
  };
}

// --- Hotkey Window 管理器 ---

/**
 * Codex 的 Hotkey Window（热键窗口）
 *
 * 这是桌面宠物的"呼叫"窗口。用户按 Cmd+Shift+Space 时：
 * 1. 创建一个小的浮动输入窗口
 * 2. 窗口出现在屏幕中央偏上
 * 3. 用户输入问题或命令
 * 4. 提交后 → 窗口关闭 → 内容在 Main Window 打开
 *
 * 从 main.js 中识别的窗口行为：
 * - type: "hotkey-window-enabled-changed" → 启用/禁用
 * - type: "hotkey-window-transition-done" → 动画完成
 * - type: "hotkey-window-collapse-to-home" → 折叠到主窗口
 * - type: "hotkey-window-transition" → 过渡动画
 * - type: "hotkey-window-home-pointer-interaction" → 主页指针交互
 */
class HotkeyWindowManager {
  private window: BrowserWindow | null = null;
  private config: HotkeyWindowConfig;
  private isTransitioning = false;
  private isOpen = false;
  private display: Electron.Display;

  constructor(config?: Partial<HotkeyWindowConfig>) {
    this.config = { ...DEFAULT_HOTKEY_WINDOW_CONFIG, ...config };
    this.display = screen.getPrimaryDisplay();
  }

  // --- 创建/销毁 ---

  async create(): Promise<void> {
    const pos = calculateHotkeyWindowPosition(this.display, this.config);

    this.window = new BrowserWindow({
      width: this.config.width,
      height: this.config.height,
      x: pos.x,
      y: pos.y,

      // 无边框
      frame: false,
      transparent: true,
      hasShadow: true,

      // 浮动
      alwaysOnTop: true,
      skipTaskbar: true,

      // 点击外部关闭
      type: "panel",

      // 背景透明
      backgroundColor: "#00000000",

      // 动画 start: 从透明 fade in
      show: false,

      webPreferences: {
        preload: "preload.js",
        sandbox: true,
        contextIsolation: true,
      },
    });

    this.window.on("blur", () => this.close());
    this.window.on("ready-to-show", () => {
      this.window?.show();
      this.fadeIn();
    });

    await this.window.loadURL("app://hotkey-window/index.html");
  }

  // --- 开关控制 ---

  async toggle(): Promise<void> {
    if (this.isTransitioning) return;

    if (this.isOpen) {
      await this.close();
    } else {
      if (!this.window || this.window.isDestroyed()) {
        await this.create();
      } else {
        this.updatePosition();
        this.window.show();
        this.fadeIn();
      }
      this.isOpen = true;
    }
  }

  async close(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) return;
    if (this.isTransitioning) return;

    this.isTransitioning = true;
    await this.fadeOut();
    this.window.hide();
    this.isOpen = false;
    this.isTransitioning = false;
  }

  // --- 动画 ---

  /**
   * Fade in + slide down 入场动画
   * 推测使用 CSS @keyframes + Electron 窗口动画
   *
   * 动画参数（从 main.js CSS 提取）：
   * - opacity: 0 → 1 (200ms ease-out)
   * - transform: translateY(-10px) → translateY(0) (200ms ease-out)
   */
  private fadeIn(): void {
    if (!this.window || this.window.isDestroyed()) return;

    this.isTransitioning = true;
    const startOpacity = 0;
    const targetOpacity = 1;
    const duration = this.config.transitionDuration;
    const startTime = Date.now();

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);

      this.window?.setOpacity(startOpacity + (targetOpacity - startOpacity) * eased);

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        this.isTransitioning = false;
        this.emitTransitionDone();
      }
    };

    requestAnimationFrame(animate);
  }

  private fadeOut(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.window || this.window.isDestroyed()) {
        resolve();
        return;
      }

      const startOpacity = this.window.getOpacity();
      const duration = this.config.transitionDuration;
      const startTime = Date.now();

      const animate = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        this.window?.setOpacity(startOpacity * (1 - eased));

        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          resolve();
        }
      };

      requestAnimationFrame(animate);
    });
  }

  /**
   * 折叠回主窗口的动画
   *
   * 当用户从 Hotkey Window 提交问题时，
   * 窗口缩小并"飞"向主 Codex 窗口的位置
   */
  collapseToMainWindow(mainWindowBounds: { x: number; y: number; width: number; height: number }): Promise<void> {
    return new Promise((resolve) => {
      if (!this.window || this.window.isDestroyed()) {
        resolve();
        return;
      }

      const startBounds = this.window.getBounds();
      const targetCenter = {
        x: mainWindowBounds.x + mainWindowBounds.width / 2,
        y: mainWindowBounds.y + mainWindowBounds.height / 2,
      };

      const duration = 300; // 飞行动画时长
      const startTime = Date.now();

      const animate = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // ease-in-out
        const eased = progress < 0.5
          ? 2 * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 2) / 2;

        const x = startBounds.x + (targetCenter.x - startBounds.x) * eased;
        const y = startBounds.y + (targetCenter.y - startBounds.y) * eased;
        const w = startBounds.width * (1 - eased * 0.8);
        const h = startBounds.height * (1 - eased * 0.8);
        const opacity = 1 - eased;

        this.window?.setBounds({ x: Math.round(x - w / 2), y: Math.round(y - h / 2), width: Math.round(w), height: Math.round(h) });
        this.window?.setOpacity(opacity);

        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          this.window?.hide();
          this.isOpen = false;
          resolve();
        }
      };

      requestAnimationFrame(animate);
    });
  }

  // --- 位置更新 ---

  private updatePosition(): void {
    const cursorPoint = screen.getCursorScreenPoint();
    this.display = screen.getDisplayNearestPoint(cursorPoint);
    const pos = calculateHotkeyWindowPosition(this.display, this.config);
    this.window?.setPosition(pos.x, pos.y);
  }

  // --- 事件发射 ---

  private emitTransitionDone(): void {
    this.window?.webContents.send("hotkey-window-transition-done");
    // 同时通过 IPC 通知主渲染进程
    // ipcMain.emit('codex_desktop:message-for-view', { type: 'hotkey-window-transition-done' })
  }

  // --- 主窗口 ← → 热键窗口交互 ---

  /**
   * 从热键窗口提交用户输入后：
   * 1. 内容发送到主进程
   * 2. 热键窗口折叠
   * 3. 主窗口打开并显示新对话
   */
  async submitAndCollapse(input: string): Promise<void> {
    // 通过 IPC 发送用户输入到主窗口
    // ipcMain → renderer: open-current-main-window
    // ipcMain → renderer: submit-user-input

    const mainWindow = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.id !== this.window?.id,
    );

    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      await this.collapseToMainWindow(mainWindow.getBounds());
    } else {
      await this.close();
    }
  }

  // --- 销毁 ---

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
  }
}

// --- 窗口焦点事件 ---

/**
 * mac-menu-bar-enabled-changed 处理
 *
 * Codex 在 macOS 菜单栏有一个图标，点击可：
 * 1. 显示主窗口
 * 2. 切换热键窗口
 * 3. 查看状态
 */
interface MenuBarIconConfig {
  enabled: boolean;
  showDockIcon: boolean;
}

const DEFAULT_MENU_BAR_CONFIG: MenuBarIconConfig = {
  enabled: true,
  showDockIcon: true,
};

/**
 * 注册菜单栏图标切换事件
 */
function setupMenuBarIconHandlers(config: MenuBarIconConfig): void {
  ipcMain.on("codex_desktop:message-from-view", (_event, message) => {
    if (message.type === "mac-menu-bar-enabled-changed") {
      // 切换菜单栏图标可见性
      // if (app.dock) app.dock.setMenu(menu)
    }
  });
}

// --- 全局快捷键与热键窗口联动 ---

/**
 * 完整的快捷键 → 热键窗口流程（从 main.js 反编译）：
 *
 * 1. 用户按下 Cmd+Shift+Space
 * 2. globalShortcut 触发 handler
 * 3. HotkeyWindowManager.toggle()
 *    - 如果未打开：创建/显示窗口
 *    - 如果已打开：关闭窗口
 * 4. 窗口内用户输入文本，按 Enter
 * 5. submitAndCollapse() → 内容发送到主窗口
 *
 * 额外的快捷键（从 main.js 提取）：
 * - Cmd+Shift+O: 打开主窗口
 * - Cmd+Shift+P: 切换宠物显示
 * - Cmd+Shift+I: 开发工具 (仅 dev 构建)
 * - Cmd+Shift+.: 调出上下文菜单
 */

export {
  HotkeyWindowManager,
  setupMenuBarIconHandlers,
  calculateHotkeyWindowPosition,
  DEFAULT_HOTKEY_WINDOW_CONFIG,
  DEFAULT_MENU_BAR_CONFIG,
};

export type {
  HotkeyWindowConfig,
  MenuBarIconConfig,
};
