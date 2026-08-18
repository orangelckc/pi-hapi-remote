/**
 * VS Code / RPC 客户端状态桥接。
 *
 * RPC 模式只支持字符串 Widget，因此这里使用带版本前缀的 base64url JSON。
 * 该 Widget 仅作为机器协议使用，客户端识别后不得按普通 Widget 渲染。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const REMOTE_RPC_WIDGET_KEY = "pi-hapi-remote:state";
export const REMOTE_RPC_STATE_PREFIX = "pi-hapi-remote-state:v1:";

export type RemoteRpcPhase = "idle" | "starting" | "sharing" | "stopping";

export interface RemoteRpcState {
  version: 1;
  available: true;
  phase: RemoteRpcPhase;
  sharing: boolean;
  publicUrl?: string;
  viewerUrl?: string;
  controllerUrl?: string;
  claimAvailable?: boolean;
  viewerCount?: number;
  controller?: {
    deviceId: string;
    deviceLabel: string;
  };
  localHasControl: boolean;
  error?: string;
}

function encodeState(state: RemoteRpcState): string {
  return `${REMOTE_RPC_STATE_PREFIX}${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`;
}

export function publishRemoteRpcState(
  ctx: ExtensionContext | null,
  state: RemoteRpcState,
): void {
  if (!ctx || ctx.mode !== "rpc") return;
  ctx.ui.setWidget(REMOTE_RPC_WIDGET_KEY, [encodeState(state)]);
}
