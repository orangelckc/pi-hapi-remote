/**
 * 审计：关键控制事件以不进入模型上下文的 Session 自定义条目
 * （pi.appendEntry）记录，并注册 TUI 渲染。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const AUDIT_ENTRY_TYPE = "remote-audit";

export interface RemoteAuditData {
  event:
    | "share_started"
    | "share_stopped"
    | "control_claimed"
    | "controller_replaced"
    | "control_revoked"
    | "local_reclaimed"
    | "remote_released"
    | "remote_aborted";
  /** 事件描述（面向用户的简短文本）。 */
  detail?: string;
  /** 相关设备标签。 */
  deviceLabel?: string;
  timestamp: number;
}

const EVENT_LABELS: Record<RemoteAuditData["event"], string> = {
  share_started: "分享开始",
  share_stopped: "分享停止",
  control_claimed: "QR 兑换控制权",
  controller_replaced: "控制者被替换",
  control_revoked: "撤销远端设备",
  local_reclaimed: "本机收回控制权",
  remote_released: "远端移交控制权",
  remote_aborted: "远端中止运行",
};

/** 注册审计条目的 TUI 渲染器（transcript 内单行显示，不进入模型上下文）。 */
export function registerAuditRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(AUDIT_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as RemoteAuditData | undefined;
    if (!data) return new Text("", 0, 0);
    const label = EVENT_LABELS[data.event] ?? data.event;
    const device = data.deviceLabel ? ` · ${data.deviceLabel}` : "";
    const detail = data.detail ? ` · ${data.detail}` : "";
    return new Text(
      theme.fg("dim", `⚡ 远程控制审计：${label}${device}${detail}`),
      0,
      0,
    );
  });
}

/** 记录审计事件。 */
export function audit(
  pi: ExtensionAPI,
  event: RemoteAuditData["event"],
  options: { detail?: string; deviceLabel?: string } = {},
): void {
  const data: RemoteAuditData = {
    event,
    detail: options.detail,
    deviceLabel: options.deviceLabel,
    timestamp: Date.now(),
  };
  pi.appendEntry(AUDIT_ENTRY_TYPE, data);
}
