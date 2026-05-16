// ============================================================
// Codex 桌面宠物 —— 状态机与完整生命周期
// 从 main.js + webview/assets + IPC message types 逆向重建
// ============================================================

import {
  PetCharacter,
  AnimationState,
  CanvasSpriteRenderer,
  SpritesheetPreloader,
  AnimationController,
  updatePetPhysics,
  getRandomIdleBehavior,
  EVENT_TO_ANIMATION,
} from "./spritesheet-engine";
import type { PetPhysics, PreloadProgress } from "./spritesheet-engine";

// --- 宠物生命周期阶段 ---

enum PetLifecyclePhase {
  /** 未初始化 */
  Uninitialized = "uninitialized",
  /** 资源加载中（精灵表预加载） */
  Loading = "loading",
  /** 第一次出现（出场动画） */
  FirstAppearance = "first-appearance",
  /** 正常运行 */
  Active = "active",
  /** 睡眠（用户离开/长时间不交互） */
  Sleeping = "sleeping",
  /** 隐藏（用户手动关闭） */
  Hidden = "hidden",
  /** 出错 */
  Error = "error",
}

// --- 宠物全局状态 ---

interface PetGlobalState {
  lifecycle: PetLifecyclePhase;
  character: PetCharacter;
  animationState: AnimationState;
  physics: PetPhysics;
  /** 用户是否正在查看 Codex 窗口 */
  userIsActive: boolean;
  /** 距离上次用户交互的时间（ms） */
  timeSinceLastInteraction: number;
  /** Agent 是否正在工作 */
  agentIsWorking: boolean;
  /** Agent 工作模式 */
  agentMode: "chat" | "goal" | "automation" | null;
  /** 未读通知数 */
  unreadNotificationCount: number;
  /** 总交互次数（用于统计） */
  totalInteractions: number;
  /** 当前会话开始时间 */
  sessionStartTime: number;
}

// --- 用户交互类型 ---

enum UserInteractionType {
  Click = "click",
  DoubleClick = "double-click",
  Drag = "drag",
  RightClick = "right-click",
  Hover = "hover",
}

// --- 核心状态机 ---

class PetStateMachine {
  private state: PetGlobalState;
  private renderer: CanvasSpriteRenderer | null = null;
  private controller: AnimationController | null = null;
  private preloader: SpritesheetPreloader;
  private interactionTimer: ReturnType<typeof setTimeout> | null = null;
  private physicsTimer: ReturnType<typeof setInterval> | null = null;
  private behaviorTimer: ReturnType<typeof setInterval> | null = null;

  // --- 配置常量（从 main.js 反编译提取） ---

  /** 无交互后进入睡眠的时间 */
  private readonly SLEEP_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟
  /** 睡眠后定期检查 */
  private readonly SLEEP_CHECK_INTERVAL_MS = 30 * 1000; // 30 秒
  /** 随机行为的间隔范围 */
  private readonly BEHAVIOR_INTERVAL_MIN_MS = 10000;
  private readonly BEHAVIOR_INTERVAL_MAX_MS = 45000;

  constructor(character: PetCharacter = PetCharacter.Codex) {
    this.preloader = new SpritesheetPreloader();
    this.state = this.createInitialState(character);
  }

  private createInitialState(character: PetCharacter): PetGlobalState {
    return {
      lifecycle: PetLifecyclePhase.Uninitialized,
      character,
      animationState: AnimationState.Idle,
      physics: {
        position: { x: 0, y: 0 },
        velocity: { x: 0, y: 0 },
        facing: 1,
        isDragging: false,
        gravity: true,
      },
      userIsActive: false,
      timeSinceLastInteraction: 0,
      agentIsWorking: false,
      agentMode: null,
      unreadNotificationCount: 0,
      totalInteractions: 0,
      sessionStartTime: Date.now(),
    };
  }

  // --- 生命周期 ---

  /**
   * 初始化宠物：预加载精灵表，执行出场动画
   */
  async initialize(
    onProgress?: (p: PreloadProgress) => void,
  ): Promise<void> {
    this.transitionLifecycle(PetLifecyclePhase.Loading);

    try {
      await this.preloader.preloadAll(onProgress);
    } catch (err) {
      this.transitionLifecycle(PetLifecyclePhase.Error);
      throw err;
    }

    // 创建渲染器
    this.renderer = new CanvasSpriteRenderer(this.state.character);
    await this.renderer.load();

    this.controller = new AnimationController(this.renderer);
    this.transitionLifecycle(PetLifecyclePhase.FirstAppearance);

    // 出场动画
    this.controller.request(AnimationState.Jump);
    setTimeout(() => {
      this.transitionLifecycle(PetLifecyclePhase.Active);
      this.startBehaviorLoop();
      this.startPhysicsLoop();
    }, 1500);
  }

  // --- 生命周期转换 ---

  private transitionLifecycle(phase: PetLifecyclePhase): void {
    const prev = this.state.lifecycle;

    switch (phase) {
      case PetLifecyclePhase.Active:
        this.resetInteractionTimer();
        break;

      case PetLifecyclePhase.Sleeping:
        if (this.controller) {
          this.controller.request(AnimationState.Sleep);
        }
        this.stopBehaviorLoop();
        break;

      case PetLifecyclePhase.Hidden:
        this.stopPhysicsLoop();
        this.stopBehaviorLoop();
        break;
    }

    this.state.lifecycle = phase;

    // 发出生命周期事件（通过 IPC 通知其他窗口）
    this.emitLifecycleEvent(prev, phase);
  }

  // --- 交互计时器 ---

  private resetInteractionTimer(): void {
    if (this.interactionTimer != null) clearTimeout(this.interactionTimer);
    this.state.timeSinceLastInteraction = 0;

    this.interactionTimer = setTimeout(() => {
      if (this.state.lifecycle === PetLifecyclePhase.Active) {
        this.transitionLifecycle(PetLifecyclePhase.Sleeping);
      }
    }, this.SLEEP_TIMEOUT_MS);
  }

  // --- 行为循环 ---

  private startBehaviorLoop(): void {
    this.scheduleNextBehavior();
  }

  private stopBehaviorLoop(): void {
    if (this.behaviorTimer != null) {
      clearInterval(this.behaviorTimer);
      this.behaviorTimer = null;
    }
  }

  private scheduleNextBehavior(): void {
    const interval =
      this.BEHAVIOR_INTERVAL_MIN_MS +
      Math.random() * (this.BEHAVIOR_INTERVAL_MAX_MS - this.BEHAVIOR_INTERVAL_MIN_MS);

    this.behaviorTimer = setTimeout(() => {
      if (this.state.lifecycle === PetLifecyclePhase.Active) {
        this.executeRandomBehavior();
      }
      this.scheduleNextBehavior();
    }, interval);
  }

  private executeRandomBehavior(): void {
    if (!this.controller) return;

    const behavior = getRandomIdleBehavior();
    this.controller.request(behavior);

    if (behavior === AnimationState.Walk) {
      // 随机行走方向
      const direction = Math.random() > 0.5 ? 1 : -1;
      const distance = 50 + Math.random() * 200;
      this.state.physics.velocity.x = direction * distance;
      this.state.physics.facing = direction as 1 | -1;
      this.state.animationState = AnimationState.Walk;

      // 1.5 秒后回到 Idle
      setTimeout(() => {
        if (this.state.animationState === AnimationState.Walk) {
          this.controller?.request(AnimationState.Idle);
          this.state.animationState = AnimationState.Idle;
          this.state.physics.velocity.x = 0;
        }
      }, 1500);
    }

    this.state.animationState = behavior;
  }

  // --- 物理循环 ---

  private startPhysicsLoop(): void {
    const FIXED_DT = 1 / 60; // 60fps 固定步长
    const screenBounds = { w: 1920, h: 1080 }; // 从 screen API 动态获取

    this.physicsTimer = setInterval(() => {
      if (this.state.lifecycle === PetLifecyclePhase.Hidden) return;

      this.state.physics = updatePetPhysics(
        this.state.physics,
        FIXED_DT,
        screenBounds,
        { w: 128, h: 128 },
      );
    }, 1000 / 60);
  }

  private stopPhysicsLoop(): void {
    if (this.physicsTimer != null) {
      clearInterval(this.physicsTimer);
      this.physicsTimer = null;
    }
  }

  // --- 用户交互处理 ---

  /**
   * 处理用户对宠物的交互
   * 映射到合适的动画状态
   */
  handleUserInteraction(type: UserInteractionType, _data?: unknown): void {
    this.resetInteractionTimer();
    this.state.timeSinceLastInteraction = 0;
    this.state.totalInteractions++;

    // 如果正在睡眠，唤醒
    if (this.state.lifecycle === PetLifecyclePhase.Sleeping) {
      this.transitionLifecycle(PetLifecyclePhase.Active);
    }

    if (!this.controller) return;

    switch (type) {
      case UserInteractionType.Click:
        this.controller.request(AnimationState.Interact);
        this.state.animationState = AnimationState.Interact;
        // 点击打开主窗口
        setTimeout(() => {
          if (this.state.animationState === AnimationState.Interact) {
            this.controller?.request(AnimationState.Idle);
            this.state.animationState = AnimationState.Idle;
          }
        }, 1200);
        break;

      case UserInteractionType.DoubleClick:
        this.controller.request(AnimationState.Happy);
        this.state.animationState = AnimationState.Happy;
        break;

      case UserInteractionType.Drag:
        this.controller.request(AnimationState.Dragging);
        this.state.animationState = AnimationState.Dragging;
        this.state.physics.isDragging = true;
        break;

      case UserInteractionType.RightClick:
        // 右键菜单 → 切换角色等
        this.controller.request(AnimationState.Interact);
        break;

      case UserInteractionType.Hover:
        // 悬停不改变动画，但可显示 tooltip
        break;
    }
  }

  /**
   * 拖拽释放
   */
  handleDragRelease(): void {
    this.state.physics.isDragging = false;
    this.state.physics.gravity = true;
    if (this.controller) {
      this.controller.request(AnimationState.Idle);
      this.state.animationState = AnimationState.Idle;
    }
  }

  // --- Agent 事件处理 ---

  /**
   * 监听 Agent 状态变化，联动宠物动画
   *
   * 从主进程的 Worker 消息和 Server 响应中获取
   * 通过 IPC channel: codex_desktop:message-for-view (type: "worker-app-event")
   */
  handleAgentEvent(eventType: string, _data?: unknown): void {
    if (!this.controller) return;

    // 使用预定义的事件到动画的映射
    const animation = EVENT_TO_ANIMATION[eventType];
    if (animation) {
      this.controller.request(animation);
      this.state.animationState = animation;
    }

    // 更新 Agent 状态
    switch (eventType) {
      case "agent:turn-started":
        this.state.agentIsWorking = true;
        break;
      case "agent:turn-completed":
      case "agent:turn-error":
        this.state.agentIsWorking = false;
        break;
    }
  }

  // --- 通知处理 ---

  /**
   * 收到桌面通知时宠物做出反应
   */
  handleNotification(notification: { title: string; body: string }): void {
    if (!this.controller) return;

    this.state.unreadNotificationCount++;
    this.controller.request(AnimationState.Surprised);

    // 1.5 秒后恢复
    setTimeout(() => {
      if (this.state.animationState === AnimationState.Surprised) {
        this.controller?.request(AnimationState.Idle);
      }
    }, 1500);
  }

  // --- 切换角色 ---

  async switchCharacter(newCharacter: PetCharacter): Promise<void> {
    if (newCharacter === this.state.character) return;

    this.state.character = newCharacter;
    this.renderer?.stop();

    // 重新创建渲染器
    this.renderer = new CanvasSpriteRenderer(newCharacter);
    await this.renderer.load();
    this.renderer.startLoop();

    this.controller = new AnimationController(this.renderer);
    this.controller.request(AnimationState.Jump);
  }

  // --- 获取状态快照 ---

  getStateSnapshot(): Readonly<PetGlobalState> {
    return { ...this.state };
  }

  // --- 事件发射 ---

  private emitLifecycleEvent(from: PetLifecyclePhase, to: PetLifecyclePhase): void {
    // 通过 IPC 通知其他窗口宠物生命周期变化
    // ipcMain → renderer: 'avatar-overlay-open-state-changed'
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("pet-lifecycle-changed", {
          detail: { from, to, character: this.state.character },
        }),
      );
    }
  }

  // --- 销毁 ---

  destroy(): void {
    this.stopPhysicsLoop();
    this.stopBehaviorLoop();
    this.renderer?.stop();
    this.controller?.destroy();
    if (this.interactionTimer != null) clearTimeout(this.interactionTimer);
  }
}

// --- 睡眠检测（macOS 用户空闲检测） ---

/**
 * macOS 用户空闲检测
 * 通过 IOKit/CoreGraphics 检测用户是否离开
 *
 * 从 main.js + objc-js 使用推测:
 *   CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGAnyInputEventType)
 */
function getUserIdleSeconds(): number {
  // 通过 objc-js 调用 CGEventSourceSecondsSinceLastEventType
  // 返回上次 HID 输入事件以来的秒数
  // 在没有 objc-js 的环境中，模拟返回
  return 0;
}

/**
 * 用户空闲检测器
 * 定期检查用户是否空闲，触发宠物睡眠/唤醒
 */
class UserIdleDetector {
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private idleThresholdMs = 5 * 60 * 1000; // 5 分钟
  private onIdleStart: (() => void) | null = null;
  private onIdleEnd: (() => void) | null = null;
  private wasIdle = false;

  start(onIdleStart: () => void, onIdleEnd: () => void): void {
    this.onIdleStart = onIdleStart;
    this.onIdleEnd = onIdleEnd;

    this.checkTimer = setInterval(() => {
      const idleSeconds = getUserIdleSeconds();
      const isIdle = idleSeconds * 1000 >= this.idleThresholdMs;

      if (isIdle && !this.wasIdle) {
        this.onIdleStart?.();
      } else if (!isIdle && this.wasIdle) {
        this.onIdleEnd?.();
      }
      this.wasIdle = isIdle;
    }, 10000); // 每 10 秒检查一次
  }

  stop(): void {
    if (this.checkTimer != null) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }
}

// --- 全屏应用检测 ---

/**
 * 检测当前是否有全屏应用（macOS Spaces）
 *
 * Codex 在全屏应用场景下:
 * - 隐藏宠物（避免干扰全屏体验）
 * - 保持热键窗口可用
 */
function isFullScreenAppActive(): boolean {
  // 通过 NSWorkspace.sharedWorkspace.frontmostApplication
  // 检查其 presentationOptions 是否包含全屏
  return false;
}

// --- 电池状态感知 ---

/**
 * macOS 电池状态检测
 * 低电量时减少宠物动画以节省功耗
 */
interface BatteryState {
  isOnBattery: boolean;
  percentage: number;
  isLowPowerMode: boolean;
}

function getBatteryState(): BatteryState {
  // 通过 IOKit 获取电池状态
  // IOServiceGetMatchingService + IORegistryEntryCreateCFProperties
  return {
    isOnBattery: false,
    percentage: 100,
    isLowPowerMode: false,
  };
}

/**
 * 低功耗模式下:
 * - 降低动画帧率（从 60fps 降到 15fps）
 * - 减少随机行为的频率
 * - 禁用 CSS 阴影/特效
 */
function shouldReduceAnimation(battery: BatteryState): boolean {
  return battery.isLowPowerMode || (battery.isOnBattery && battery.percentage < 20);
}

// --- 宠物角色管理 ---

/**
 * 角色选择器 — 用户可在设置中切换宠物
 */
interface CharacterInfo {
  id: PetCharacter;
  displayName: string;
  description: string;
  /** 该角色是否是 Codex 付费用户的专属角色 */
  requiresPro: boolean;
  /** 该角色是否是内部员工专属 */
  internalOnly: boolean;
}

const CHARACTER_CATALOG: CharacterInfo[] = [
  {
    id: PetCharacter.Codex,
    displayName: "Codex",
    description: "The original Codex companion. Friendly and helpful.",
    requiresPro: false,
    internalOnly: false,
  },
  {
    id: PetCharacter.Bsod,
    displayName: "BSOD",
    description: "A blue screen of death character. For the nostalgics.",
    requiresPro: false,
    internalOnly: false,
  },
  {
    id: PetCharacter.Dewey,
    displayName: "Dewey",
    description: "A bookish companion. Loves reading your code.",
    requiresPro: false,
    internalOnly: false,
  },
  {
    id: PetCharacter.Fireball,
    displayName: "Fireball",
    description: "Energetic and fast. For those who code at speed.",
    requiresPro: true,
    internalOnly: false,
  },
  {
    id: PetCharacter.NullSignal,
    displayName: "Null Signal",
    description: "Mysterious and quiet. Appears when you least expect.",
    requiresPro: false,
    internalOnly: true,
  },
  {
    id: PetCharacter.Rocky,
    displayName: "Rocky",
    description: "Steady and reliable. The debugging companion.",
    requiresPro: false,
    internalOnly: false,
  },
  {
    id: PetCharacter.Seedy,
    displayName: "Seedy",
    description: "A plant-based companion. Grows with your codebase.",
    requiresPro: false,
    internalOnly: false,
  },
  {
    id: PetCharacter.Stacky,
    displayName: "Stacky",
    description: "Stack Overflow in pet form. Knows all the answers.",
    requiresPro: true,
    internalOnly: false,
  },
];

export {
  PetStateMachine,
  UserIdleDetector,
  PetLifecyclePhase,
  UserInteractionType,
  CHARACTER_CATALOG,
  isFullScreenAppActive,
  getBatteryState,
  shouldReduceAnimation,
};

export type {
  PetGlobalState,
  CharacterInfo,
  BatteryState,
};
