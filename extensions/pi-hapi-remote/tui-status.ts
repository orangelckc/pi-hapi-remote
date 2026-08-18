/**
 * TUI 控制状态条：
 * - 远端控制期间：编辑器上方醒目状态条 + 收回快捷键提示；阻止本机普通输入。
 * - 仅观察者：页脚显示分享状态摘要。
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "remote-share";
const WIDGET_KEY = "remote-control";

export interface RemoteStatusView {
  /** 分享是否进行中。 */
  sharing: boolean;
  /** 公网地址。 */
  publicUrl?: string;
  /** 当前连接的观察者数量（长轮询连接数）。 */
  viewerCount?: number;
  /** 当前远端控制者标签；null 表示本机持有控制权。 */
  controllerLabel?: string;
}

function renderWidgetLines(view: RemoteStatusView): string[] {
  if (!view.sharing || !view.controllerLabel) return [];
  return [
    `┌ ⚡ 远程控制中：${view.controllerLabel} ─────────────┐`,
    "│ 本机输入已暂停 · Ctrl+Shift+R 或 /remote reclaim 收回 │",
    "└──────────────────────────────────────────┘",
  ];
}

function renderStatusText(view: RemoteStatusView): string | undefined {
  if (!view.sharing) return undefined;
  const controller = view.controllerLabel
    ? `控制者：${view.controllerLabel}`
    : "本机控制";
  const viewers = view.viewerCount !== undefined ? ` · ${view.viewerCount} 个观察者` : "";
  return `远程分享开启${viewers} · ${controller}`;
}

export interface RemoteStatusOptions {
  /** 仅真实终端 TUI 显示远程控制提示卡；RPC 客户端使用自己的可视化界面。 */
  showControlWidget?: boolean;
}

/** 统一刷新状态显示。 */
export function updateTuiStatus(
  ui: ExtensionUIContext | undefined,
  view: RemoteStatusView,
  options: RemoteStatusOptions = {},
): void {
  if (!ui) return;
  const status = renderStatusText(view);
  if (status) {
    ui.setStatus(STATUS_KEY, status);
  } else {
    ui.setStatus(STATUS_KEY, undefined);
  }
  const lines = options.showControlWidget ? renderWidgetLines(view) : [];
  if (lines.length > 0) {
    ui.setWidget(WIDGET_KEY, lines);
  } else {
    // RPC 模式也主动清理，避免热重载后残留旧版本发送的提示卡。
    ui.setWidget(WIDGET_KEY, undefined);
  }
}
