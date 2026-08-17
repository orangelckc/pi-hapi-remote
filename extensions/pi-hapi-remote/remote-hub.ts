/**
 * Remote Hub（组合根）：编排 Session Bridge、Capability Authority、
 * Control Lease、Event Journal、Remote Bridge 与 Tunnel Adapter，
 * 向命令层与入口模块暴露 start/stop/reclaim/revoke/status 生命周期。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import qrcode from "qrcode";
import { LIMITS, type DeviceInfo, type RemoteState } from "../../shared/protocol.js";
import { audit } from "./audit.js";
import { CapabilityAuthority, generateShareId } from "./auth.js";
import { ControlLease, type ControllerInfo } from "./control-lease.js";
import { EventJournal } from "./event-buffer.js";
import { RemoteBridgeServer, type ApprovalDecision } from "./remote-server.js";
import { SessionBridge } from "./session-bridge.js";
import { TunnelmoleAdapter } from "./tunnel/tunnelmole.js";
import { updateTuiStatus } from "./tui-status.js";

export const DEFAULT_PWA_URL = "https://pi-hapi-remote.vercel.app/";

export interface ShareStartResult {
  viewerUrl: string;
  controllerUrl: string;
  publicUrl: string;
  shareId: string;
}

export interface ShareStatus {
  sharing: boolean;
  publicUrl?: string;
  viewerUrl?: string;
  controllerUrl?: string;
  viewerCount?: number;
  controller?: ControllerInfo;
}

function encodePayload(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
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
  private lease: ControlLease | null = null;
  private server: RemoteBridgeServer | null = null;
  private tunnel: TunnelmoleAdapter | null = null;
  private sharing = false;
  private publicUrl: string | null = null;
  private viewerUrl: string | null = null;
  private controllerUrl: string | null = null;
  private pwaBaseUrl: string;
  /** 最近一次 Session 上下文（stop 时仍需访问其 ui 清除状态条）。 */
  private lastCtx: ExtensionContext | null = null;

  constructor(pi: ExtensionAPI, pwaBaseUrl: string = process.env.PI_REMOTE_PWA_URL ?? DEFAULT_PWA_URL) {
    this.pi = pi;
    this.pwaBaseUrl = pwaBaseUrl.endsWith("/") ? pwaBaseUrl : pwaBaseUrl + "/";
    this.bridge = new SessionBridge(pi, this.journal);
  }

  get sessionBridge(): SessionBridge {
    return this.bridge;
  }

  get isSharing(): boolean {
    return this.sharing;
  }

  get remoteControlled(): boolean {
    return this.lease?.remoteHeld ?? false;
  }

  // ---- Session 生命周期 ----

  handleSessionStart(ctx: ExtensionContext): void {
    this.lastCtx = ctx;
    this.bridge.attach(ctx);
  }

  handleSessionShutdown(): void {
    void this.stop("session_shutdown", { audit: false });
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
    if (this.sharing) {
      throw new Error("分享已在进行中");
    }
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
    this.lease = new ControlLease({
      onControllerChange: (controller, reason, replaced) =>
        this.onControllerChange(controller, reason, replaced, ctx),
    });

    this.server = new RemoteBridgeServer({
      auth: this.auth,
      lease: this.lease,
      journal: this.journal,
      bridge: this.bridge,
      allowedOrigins: this.allowedOrigins(),
      requestApproval: (device, currentLabel) => this.requestApproval(ctx, device, currentLabel),
      onRemoteAbort: (deviceLabel) => {
        audit(this.pi, "remote_aborted", { deviceLabel });
      },
      onControllerGranted: (device, kind) => {
        audit(this.pi, kind === "claimed" ? "control_claimed" : "control_approved", {
          deviceLabel: device.deviceLabel,
        });
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
    this.viewerUrl = `${this.pwaBaseUrl}#/connect/${encodePayload(viewerPayload)}`;
    this.controllerUrl = `${this.pwaBaseUrl}#/connect/${encodePayload(controllerPayload)}`;
    this.sharing = true;

    audit(this.pi, "share_started", { detail: handle.publicUrl });
    this.refreshTui(ctx);

    return {
      viewerUrl: this.viewerUrl,
      controllerUrl: this.controllerUrl,
      publicUrl: handle.publicUrl,
      shareId,
    };
  }

  async stop(reason: string, options: { audit?: boolean } = {}): Promise<void> {
    if (!this.sharing && !this.server) return;
    const shouldAudit = options.audit !== false && this.sharing;

    this.sharing = false;

    // 先通知观察者，再逐层关闭。
    this.journal.append({ type: "share_ended", reason });
    this.journal.close();

    if (this.tunnel) {
      await this.tunnel.stop();
      this.tunnel = null;
    }
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
    this.lease?.end();
    this.lease = null;
    this.auth?.revokeAll();
    this.auth = null;
    this.publicUrl = null;
    this.viewerUrl = null;
    this.controllerUrl = null;
    this.bridge.detach();

    if (shouldAudit) {
      audit(this.pi, "share_stopped", { detail: reason });
    }
    // 刷新 TUI（清除状态条；使用最近一次会话上下文的 ui）。
    if (this.lastCtx) {
      this.refreshTui(this.lastCtx);
    }
  }

  /** 本机收回控制权。返回被收回的设备信息（无控制者时为 null）。 */
  reclaim(): ControllerInfo | null {
    const previous = this.lease?.reclaim() ?? null;
    if (previous) {
      this.auth?.revokeControllerToken();
    }
    return previous;
  }

  /** 撤销当前远端设备（保留分享，取消其写权限）。 */
  revoke(): ControllerInfo | null {
    const previous = this.lease?.revoke() ?? null;
    if (previous) {
      this.auth?.revokeControllerToken();
    }
    return previous;
  }

  status(): ShareStatus {
    if (!this.sharing) {
      return { sharing: false };
    }
    return {
      sharing: true,
      publicUrl: this.publicUrl ?? undefined,
      viewerUrl: this.viewerUrl ?? undefined,
      controllerUrl: this.controllerUrl ?? undefined,
      viewerCount: this.journal.waiterCount,
      controller: this.lease?.current ?? undefined,
    };
  }

  // ---- 内部 ----

  private allowedOrigins(): string[] {
    const origins = new Set<string>();
    try {
      origins.add(new URL(this.pwaBaseUrl).origin);
    } catch {
      // 配置的 PWA 地址无效时忽略。
    }
    for (const dev of ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"]) {
      origins.add(dev);
    }
    return [...origins];
  }

  private currentState(): RemoteState {
    const controller = this.lease?.current;
    return {
      isStreaming: this.bridge.streaming,
      controllerDeviceId: controller?.deviceId,
      controllerLabel: controller?.deviceLabel,
      localHasControl: controller === null || controller === undefined,
    };
  }

  private onControllerChange(
    controller: ControllerInfo | null,
    reason: string,
    replaced: ControllerInfo | undefined,
    ctx: ExtensionContext,
  ): void {
    if (replaced && controller) {
      audit(this.pi, "controller_replaced", {
        detail: `${replaced.deviceLabel} → ${controller.deviceLabel}`,
      });
    }
    switch (reason) {
      case "local_reclaimed":
        audit(this.pi, "local_reclaimed", { deviceLabel: replaced?.deviceLabel });
        break;
      case "revoked":
        audit(this.pi, "control_revoked", { deviceLabel: replaced?.deviceLabel });
        break;
      case "share_ended":
        break;
      default:
        break;
    }
    this.journal.append({ type: "control_state", state: this.currentState() });
    this.refreshTui(ctx);
  }

  /** 本机审批对话：显示设备信息；已有控制者时明确提示替换。 */
  private async requestApproval(
    ctx: ExtensionContext,
    device: DeviceInfo,
    currentControllerLabel: string | undefined,
  ): Promise<ApprovalDecision> {
    if (!ctx.hasUI) {
      return "denied";
    }
    const replacing = currentControllerLabel
      ? `\n\n注意：将替换当前控制者「${currentControllerLabel}」。`
      : "";
    const ok = await ctx.ui.confirm(
      "远端设备申请控制权",
      `设备：${device.deviceLabel}\n设备 ID：${device.deviceId.slice(0, 8)}…${replacing}\n\n是否批准？`,
      { timeout: LIMITS.controlRequestTimeoutMs },
    );
    if (ok) {
      audit(this.pi, "control_requested", { deviceLabel: device.deviceLabel, detail: "已批准" });
      return "approved";
    }
    audit(this.pi, "control_requested", { deviceLabel: device.deviceLabel, detail: "已拒绝" });
    return "denied";
  }

  private refreshTui(ctx: ExtensionContext): void {
    const status = this.status();
    updateTuiStatus(ctx.ui, {
      sharing: status.sharing,
      publicUrl: status.publicUrl,
      viewerCount: status.viewerCount,
      controllerLabel: status.controller?.deviceLabel,
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
