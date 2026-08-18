/**
 * Remote Hub（组合根）：编排 Session Bridge、Capability Authority、
 * Control Lease、Event Journal、Remote Bridge 与 Tunnel Adapter，
 * 向命令层与入口模块暴露 start/stop/reclaim/revoke/status 生命周期。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode";
import type { RemoteState } from "../../shared/protocol.js";
import { audit } from "./audit.js";
import { CapabilityAuthority, generateShareId } from "./auth.js";
import type { ControllerInfo } from "./control-lease.js";
import { ControlFlow } from "./control-flow.js";
import { EventJournal } from "./event-buffer.js";
import { RemoteBridgeServer } from "./remote-server.js";
import { SessionBridge } from "./session-bridge.js";
import {
  publishRemoteRpcState,
  type RemoteRpcPhase,
} from "./rpc-status.js";
import { StaticFrontend } from "./static-frontend.js";
import { TunnelmoleAdapter } from "./tunnel/tunnelmole.js";
import { updateTuiStatus } from "./tui-status.js";

export interface ShareStartResult {
  viewerUrl: string;
  controllerUrl: string;
  publicUrl: string;
  shareId: string;
}

export interface ShareStatus {
  phase: RemoteRpcPhase;
  sharing: boolean;
  publicUrl?: string;
  viewerUrl?: string;
  controllerUrl?: string;
  claimAvailable?: boolean;
  viewerCount?: number;
  controller?: ControllerInfo;
  error?: string;
}

function encodePayload(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** 前端静态产物目录（可被 PI_REMOTE_WEB_DIST 覆盖）。 */
function resolveWebDist(): string | null {
  const override = process.env.PI_REMOTE_WEB_DIST;
  if (override) return path.resolve(override);

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // 发布产物：dist/index.mjs 与 dist/web/。
    path.resolve(moduleDir, "web"),
    // 源码开发：extensions/pi-hapi-remote/ → web/dist/。
    path.resolve(moduleDir, "../../web/dist"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** 停止序列的总体预算：任一环节挂起也不允许状态机卡在 stopping。 */
const STOP_STEP_TIMEOUT_MS = 5_000;

async function withTimeout(label: string, task: Promise<void>): Promise<void> {
  await Promise.race([
    task,
    new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label}超时（${STOP_STEP_TIMEOUT_MS / 1000}s）`)),
        STOP_STEP_TIMEOUT_MS,
      ).unref?.(),
    ),
  ]);
}

/** 按任意键关闭的展示组件。 */
class AnyKeyOverlay implements Component {
  private readonly body: Text;
  private readonly onDone: () => void;

  constructor(body: Text, onDone: () => void) {
    this.body = body;
    this.onDone = onDone;
  }

  render(width: number): string[] {
    return this.body.render(width);
  }
  invalidate(): void {
    this.body.invalidate();
  }
  handleInput(): void {
    this.onDone();
  }
}

export class RemoteHub {
  private pi: ExtensionAPI;
  private bridge: SessionBridge;
  private journal = new EventJournal();
  private auth: CapabilityAuthority | null = null;
  private control: ControlFlow | null = null;
  private server: RemoteBridgeServer | null = null;
  private tunnel: TunnelmoleAdapter | null = null;
  private sharing = false;
  private publicUrl: string | null = null;
  private viewerUrl: string | null = null;
  private controllerUrl: string | null = null;
  private phase: RemoteRpcPhase = "idle";
  private lastError: string | undefined;
  private viewerCountRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** 最近一次 Session 上下文（stop 时仍需访问其 ui 清除状态条）。 */
  private lastCtx: ExtensionContext | null = null;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.bridge = new SessionBridge(pi, this.journal);
  }

  get sessionBridge(): SessionBridge {
    return this.bridge;
  }

  get isSharing(): boolean {
    return this.sharing;
  }

  get remoteControlled(): boolean {
    return this.control?.remoteHeld ?? false;
  }

  // ---- Session 生命周期 ----

  handleSessionStart(ctx: ExtensionContext): void {
    this.lastCtx = ctx;
    this.bridge.attach(ctx);
    this.publishState();
  }

  handleSessionShutdown(): Promise<void> {
    return this.stop("session_shutdown", { audit: false });
  }

  /** 活动分支结构变化（tree 导航）。 */
  handleTreeNavigation(): void {
    if (this.sharing) {
      this.bridge.resyncFromSession();
    }
  }

  /** 压缩后活动上下文变化。 */
  handleCompaction(): void {
    if (this.sharing) {
      this.bridge.resyncFromSession();
    }
  }

  // ---- 分享生命周期 ----

  async start(ctx: ExtensionContext): Promise<ShareStartResult> {
    if (this.sharing || this.phase === "starting") {
      throw new Error("分享已在进行中");
    }
    this.lastCtx = ctx;
    this.phase = "starting";
    this.lastError = undefined;
    this.publishState();
    this.journal.reset();
    if (!this.bridge.attached) {
      this.bridge.attach(ctx);
    }
    const sessionInfo = this.bridge.beginShare();
    if (!sessionInfo) {
      throw new Error("无法附着当前 Session");
    }

    const shareId = generateShareId();
    this.auth = new CapabilityAuthority(shareId);
    const { viewerToken, claimToken } = this.auth.issueTokens();
    this.control = new ControlFlow({
      pi: this.pi,
      auth: this.auth,
      journal: this.journal,
      currentState: () => this.currentState(),
      onLeaseChange: () => this.refreshViews(ctx),
    });

    this.server = new RemoteBridgeServer({
      auth: this.auth,
      control: this.control,
      journal: this.journal,
      bridge: this.bridge,
      allowedOrigins: this.allowedOrigins(),
      staticFrontend: new StaticFrontend(resolveWebDist()),
      onViewerCountChange: () => this.scheduleStatusRefresh(),
      onRemoteAbort: (deviceLabel) => {
        audit(this.pi, "remote_aborted", { deviceLabel });
      },
    });

    const port = await this.server.start();

    this.tunnel = new TunnelmoleAdapter();
    const abortController = new AbortController();
    const handle = await this.tunnel.start({
      localPort: port,
      signal: abortController.signal,
    });
    this.publicUrl = handle.publicUrl;
    // 分享页与 API 同源（隧道地址）：页面 Origin 在隧道启动后动态加入白名单。
    this.server.allowOrigin(new URL(handle.publicUrl).origin);

    const viewerPayload = {
      version: 1,
      endpoint: handle.publicUrl,
      shareId,
      viewerToken,
    };
    const controllerPayload = {
      version: 1,
      endpoint: handle.publicUrl,
      shareId,
      viewerToken,
      claimToken,
    };
    this.viewerUrl = `${handle.publicUrl}/#/connect/${encodePayload(viewerPayload)}`;
    this.controllerUrl = `${handle.publicUrl}/#/connect/${encodePayload(controllerPayload)}`;
    this.sharing = true;
    this.phase = "sharing";

    if (!this.server.hasStaticFrontend) {
      ctx.ui.notify(
        "未找到 web/dist：远端将无法打开页面。请先运行 pnpm build:web，或用 PI_REMOTE_WEB_DIST 指定产物目录。",
        "info",
      );
    }

    audit(this.pi, "share_started", { detail: handle.publicUrl });
    this.refreshViews(ctx);

    return {
      viewerUrl: this.viewerUrl,
      controllerUrl: this.controllerUrl,
      publicUrl: handle.publicUrl,
      shareId,
    };
  }

  async stop(reason: string, options: { audit?: boolean; error?: string } = {}): Promise<void> {
    if (!this.sharing && !this.server && this.phase === "idle") return;
    const shouldAudit = options.audit !== false && this.sharing;

    this.phase = "stopping";
    this.lastError = options.error;
    this.publishState();
    this.sharing = false;

    // 任一环节抛错或挂起都不允许把状态机永久卡在 stopping：
    // finally 中无条件回收全部资源并回到 idle。
    try {
      // 先通知观察者，再逐层关闭。
      this.journal.append({ type: "share_ended", reason });
      this.journal.close();

      if (this.tunnel) {
        await withTimeout("关闭隧道", this.tunnel.stop());
      }
      if (this.server) {
        await withTimeout("关闭本地服务", this.server.stop());
      }
    } catch (error) {
      // 资源回收在 finally 中继续；记录关闭失败原因供状态面板展示。
      const detail = error instanceof Error ? error.message : String(error);
      this.lastError = this.lastError ?? `停止分享时出错：${detail}`;
    } finally {
      this.tunnel = null;
      this.server = null;
      this.control?.end();
      this.control = null;
      this.auth?.revokeAll();
      this.auth = null;
      this.publicUrl = null;
      this.viewerUrl = null;
      this.controllerUrl = null;
      this.bridge.detach();
      this.phase = "idle";

      if (shouldAudit) {
        try {
          audit(this.pi, "share_stopped", { detail: reason });
        } catch {
          // 审计失败不影响状态回收。
        }
      }
      // 刷新 TUI（清除状态条；使用最近一次会话上下文的 ui）。
      if (this.lastCtx) {
        try {
          this.refreshViews(this.lastCtx);
        } catch {
          // 刷新失败不影响状态回收。
        }
      }
    }
  }

  /** 本机收回控制权。返回被收回的设备信息（无控制者时为 null）。 */
  reclaim(): ControllerInfo | null {
    return this.control?.reclaim() ?? null;
  }

  /** 撤销当前远端设备（保留分享，取消其写权限）。 */
  revoke(): ControllerInfo | null {
    return this.control?.revoke() ?? null;
  }

  status(): ShareStatus {
    if (!this.sharing) {
      return {
        phase: this.phase,
        sharing: false,
        error: this.lastError,
      };
    }
    return {
      phase: this.phase,
      sharing: true,
      publicUrl: this.publicUrl ?? undefined,
      viewerUrl: this.viewerUrl ?? undefined,
      controllerUrl: this.controllerUrl ?? undefined,
      claimAvailable: this.auth?.claimAvailable ?? false,
      viewerCount: this.server?.viewerCount ?? 0,
      controller: this.control?.current ?? undefined,
    };
  }

  // ---- 内部 ----

  private allowedOrigins(): string[] {
    // 分享页由本服务同源伺服（隧道地址，隧道启动后动态加入）；
    // 这里只列本地开发地址（vite dev / preview 跨域直连 API）。
    return [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:4173",
      "http://127.0.0.1:4173",
    ];
  }

  private currentState(): RemoteState {
    const controller = this.control?.current;
    return {
      isStreaming: this.bridge.streaming,
      controllerDeviceId: controller?.deviceId,
      controllerLabel: controller?.deviceLabel,
      localHasControl: controller === null || controller === undefined,
    };
  }

  private refreshViews(ctx: ExtensionContext): void {
    const status = this.status();
    updateTuiStatus(
      ctx.ui,
      {
        sharing: status.sharing,
        publicUrl: status.publicUrl,
        viewerCount: status.viewerCount,
        controllerLabel: status.controller?.deviceLabel,
      },
      { showControlWidget: ctx.mode === "tui" },
    );
    this.publishState();
  }

  /** 长轮询在超时与重连之间会短暂归零，延迟刷新可避免状态闪烁。 */
  private scheduleStatusRefresh(): void {
    if (!this.sharing) return;
    if (this.viewerCountRefreshTimer) clearTimeout(this.viewerCountRefreshTimer);
    this.viewerCountRefreshTimer = setTimeout(() => {
      this.viewerCountRefreshTimer = undefined;
      this.publishState();
    }, 250);
  }

  /** 供 RPC 侧边栏主动恢复状态。 */
  syncRpcState(): void {
    this.publishState();
  }

  private publishState(): void {
    const status = this.status();
    publishRemoteRpcState(this.lastCtx, {
      version: 1,
      available: true,
      phase: status.phase,
      sharing: status.sharing,
      publicUrl: status.publicUrl,
      viewerUrl: status.viewerUrl,
      controllerUrl: status.controllerUrl,
      claimAvailable: status.claimAvailable,
      viewerCount: status.viewerCount,
      controller: status.controller
        ? {
            deviceId: status.controller.deviceId,
            deviceLabel: status.controller.deviceLabel,
          }
        : undefined,
      localHasControl: !status.controller,
      error: status.error,
    });
  }

  /** 展示二维码与链接（TUI 全屏覆盖层）。 */
  async showQrOverlay(ctx: ExtensionContext): Promise<void> {
    if (!this.controllerUrl || !this.viewerUrl) return;
    if (ctx.mode !== "tui") {
      ctx.ui.notify(`Viewer: ${this.viewerUrl}`, "info");
      return;
    }
    let qrText = "";
    try {
      qrText = await qrcode.toString(this.controllerUrl, {
        type: "terminal",
        small: true,
      });
    } catch {
      qrText = "";
    }
    const content = [
      qrText,
      `扫二维码授权控制（一次性）：`,
      this.controllerUrl,
      "",
      `只读观察链接：`,
      this.viewerUrl,
      "",
      "按任意键关闭",
    ].join("\n");
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const text = new Text(theme.fg("accent", content), 1, 1);
      return new AnyKeyOverlay(text, () => done(undefined));
    });
  }
}
