/**
 * Control Lease（深模块）：单远端写入者规则、批准状态、控制者替换、
 * 本机收回与 Share 生命周期失效。多个观察者可并存，但只有当前租约
 * 持有者可以发送控制命令。
 */
import type { DeviceInfo } from "../../shared/protocol.js";

export interface ControllerInfo extends DeviceInfo {
  /** 取得控制权的时间（Unix ms）。 */
  since: number;
}

export type LeaseChangeReason =
  | "claimed"
  | "request_approved"
  | "replaced"
  | "local_reclaimed"
  | "remote_released"
  | "revoked"
  | "share_ended";

export interface ControlLeaseEvents {
  /** 控制权归属变化（含失去控制者回到本机）。replaced 表示被新控制者替换的旧控制者。 */
  onControllerChange(
    controller: ControllerInfo | null,
    reason: LeaseChangeReason,
    replaced?: ControllerInfo,
  ): void;
}

/**
 * 控制租约。本机默认持有控制权；远端通过 Claim 兑换或本机批准获得；
 * 本机可随时收回；Share 结束时全部失效。
 */
export class ControlLease {
  private controller: ControllerInfo | null = null;
  private listeners: ControlLeaseEvents;

  constructor(listeners: ControlLeaseEvents) {
    this.listeners = listeners;
  }

  /** 当前远端控制者；null 表示本机持有控制权。 */
  get current(): ControllerInfo | null {
    return this.controller;
  }

  /** 指定设备是否为当前控制者。 */
  isController(deviceId: string): boolean {
    return this.controller?.deviceId === deviceId;
  }

  /** 是否有远端控制者（本机输入应被阻止）。 */
  get remoteHeld(): boolean {
    return this.controller !== null;
  }

  /**
   * 授予设备控制权。若已有其他控制者，将被替换。
   * 仅由 Capability Authority 验证通过后的路径调用。
   */
  grant(device: DeviceInfo, reason: LeaseChangeReason): ControllerInfo {
    const replaced = this.controller && this.controller.deviceId !== device.deviceId
      ? this.controller
      : undefined;
    this.controller = { ...device, since: Date.now() };
    this.listeners.onControllerChange(this.controller, reason, replaced);
    return this.controller;
  }

  /** 本机收回控制权；无远端控制者时无操作。 */
  reclaim(): ControllerInfo | null {
    return this.release("local_reclaimed");
  }

  /** 当前控制者主动移交控制权给本机；非控制者调用返回 false。 */
  releaseBy(deviceId: string): boolean {
    if (!this.controller || this.controller.deviceId !== deviceId) {
      return false;
    }
    this.release("remote_released");
    return true;
  }

  /** 撤销当前远端设备（保留分享，取消其写权限）。 */
  revoke(): ControllerInfo | null {
    return this.release("revoked");
  }

  /** 分享结束：清除全部状态。 */
  end(): void {
    this.release("share_ended");
  }

  private release(reason: LeaseChangeReason): ControllerInfo | null {
    if (!this.controller) return null;
    const previous = this.controller;
    this.controller = null;
    this.listeners.onControllerChange(null, reason, previous);
    return previous;
  }
}
