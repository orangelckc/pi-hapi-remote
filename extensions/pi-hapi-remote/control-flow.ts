/**
 * Control Flow（深模块）：控制权流转的唯一编排点。
 *
 * Claim 兑换、远端移交、本机收回与撤销四种流转都在此完成
 * 「租约变更 ⇒ 令牌轮换/撤销 ⇒ 审计 ⇒ control_state 广播」的完整协同。
 * Remote Bridge 只按令牌发起流转；Control Lease 保持纯租约状态，
 * 作为本模块的内部件存在，外部不再直接接触。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DeviceInfo, RemoteState } from "../../shared/protocol.js";
import { audit } from "./audit.js";
import type { CapabilityAuthority } from "./auth.js";
import { ControlLease, type ControllerInfo, type LeaseChangeReason } from "./control-lease.js";
import type { EventJournal } from "./event-buffer.js";

export interface ControlFlowDeps {
  pi: ExtensionAPI;
  auth: CapabilityAuthority;
  journal: EventJournal;
  /** 聚合当前 Agent 与控制状态（广播 control_state 用）。 */
  currentState(): RemoteState;
  /** 租约归属变化后刷新 TUI。 */
  onLeaseChange(): void;
}

/** 流转失败（携带 HTTP 状态与协议错误码，由 Gateway 映射响应）。 */
export interface ControlFlowError {
  ok: false;
  status: number;
  code: string;
  message: string;
}

export class ControlFlow {
  private deps: ControlFlowDeps;
  /** 纯租约状态；对外只经本模块的流转方法触达。 */
  readonly lease: ControlLease;

  constructor(deps: ControlFlowDeps) {
    this.deps = deps;
    this.lease = new ControlLease({
      onControllerChange: (controller, reason, replaced) =>
        this.onControllerChange(controller, reason, replaced),
    });
  }

  get current(): ControllerInfo | null {
    return this.lease.current;
  }

  get remoteHeld(): boolean {
    return this.lease.remoteHeld;
  }

  /** 校验 Controller Token 并返回当前控制者设备。 */
  verifyController(token: string | undefined): DeviceInfo | null {
    if (!this.deps.auth.verifyControllerToken(token)) return null;
    return this.lease.current;
  }

  /** Claim 兑换：一次性令牌验证、授予控制权并轮换 Controller Token。 */
  claim(token: string | undefined, device: DeviceInfo): ControlFlowError | { ok: true; controllerToken: string } {
    if (!this.deps.auth.consumeClaimToken(token)) {
      return { ok: false, status: 401, code: "unauthorized", message: "令牌无效" };
    }
    const controllerToken = this.deps.auth.issueControllerToken();
    this.lease.grant(device, "claimed");
    return { ok: true, controllerToken };
  }

  /** 远端移交：Controller 鉴权、归属校验、释放租约并作废旧令牌。 */
  release(token: string | undefined): ControlFlowError | { ok: true } {
    const controller = this.verifyController(token);
    if (!controller) {
      return { ok: false, status: 401, code: "unauthorized", message: "令牌无效" };
    }
    if (!this.lease.releaseBy(controller.deviceId)) {
      return { ok: false, status: 409, code: "conflict", message: "该设备不是当前控制者" };
    }
    this.deps.auth.revokeControllerToken();
    return { ok: true };
  }

  /** 本机收回控制权。返回被收回的设备（无控制者时为 null）。 */
  reclaim(): ControllerInfo | null {
    const previous = this.lease.reclaim();
    if (previous) this.deps.auth.revokeControllerToken();
    return previous;
  }

  /** 撤销当前远端设备（保留分享，取消其写权限）。 */
  revoke(): ControllerInfo | null {
    const previous = this.lease.revoke();
    if (previous) this.deps.auth.revokeControllerToken();
    return previous;
  }

  /** 分享结束：清除租约（令牌撤销由 Capability Authority 统一处理）。 */
  end(): void {
    this.lease.end();
  }

  // ---- 内部：租约变化的统一后处理（审计 + 广播 + TUI） ----

  private onControllerChange(
    controller: ControllerInfo | null,
    reason: LeaseChangeReason,
    replaced: ControllerInfo | undefined,
  ): void {
    if (replaced && controller) {
      audit(this.deps.pi, "controller_replaced", {
        detail: `${replaced.deviceLabel} → ${controller.deviceLabel}`,
      });
    }
    switch (reason) {
      case "claimed":
        audit(this.deps.pi, "control_claimed", { deviceLabel: controller?.deviceLabel });
        break;
      case "local_reclaimed":
        audit(this.deps.pi, "local_reclaimed", { deviceLabel: replaced?.deviceLabel });
        break;
      case "remote_released":
        audit(this.deps.pi, "remote_released", { deviceLabel: replaced?.deviceLabel });
        break;
      case "revoked":
        audit(this.deps.pi, "control_revoked", { deviceLabel: replaced?.deviceLabel });
        break;
      case "replaced":
      case "share_ended":
        break;
    }
    this.deps.journal.append({ type: "control_state", state: this.deps.currentState() });
    this.deps.onLeaseChange();
  }
}
