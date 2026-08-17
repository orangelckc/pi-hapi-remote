/**
 * pi-hapi-remote 扩展入口。
 *
 * 附着当前 Pi Session，提供 /remote 命令集、本机输入拦截、
 * 收回快捷键与完整的分享生命周期管理。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAuditRenderer } from "./audit.js";
import { registerRemoteCommands } from "./commands.js";
import { RemoteHub } from "./remote-hub.js";

export default function (pi: ExtensionAPI) {
  const hub = new RemoteHub(pi);

  registerAuditRenderer(pi);
  registerRemoteCommands(pi, hub);

  // 快捷键：立即收回远端控制权。
  pi.registerShortcut("ctrl+shift+r", {
    description: "收回远程控制权",
    handler: async (ctx) => {
      if (!hub.isSharing) return;
      const previous = hub.reclaim();
      if (previous) {
        ctx.ui.notify(`已收回「${previous.deviceLabel}」的控制权。`, "info");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    hub.handleSessionStart(ctx);
  });

  pi.on("session_shutdown", async () => {
    // Session 切换、重载或 Pi 退出：同步失效本地服务、隧道与全部令牌。
    await hub.handleSessionShutdown();
  });

  // Agent / 消息 / 工具事件转发（仅在分享期间发布）。
  pi.on("agent_start", async () => {
    hub.sessionBridge.onAgentStart();
  });
  pi.on("agent_settled", async () => {
    hub.sessionBridge.onAgentSettled();
  });
  pi.on("message_start", async (event) => {
    hub.sessionBridge.onMessageStart(event.message);
  });
  pi.on("message_update", async (event) => {
    hub.sessionBridge.onMessageUpdate(event.message);
  });
  pi.on("message_end", async (event) => {
    hub.sessionBridge.onMessageEnd(event.message);
  });
  pi.on("tool_execution_start", async (event) => {
    hub.sessionBridge.onToolExecutionStart(event.toolCallId, event.toolName, event.args);
  });
  pi.on("tool_execution_end", async (event) => {
    const content = event.result && typeof event.result === "object" && "content" in event.result
      ? (event.result as { content: unknown }).content
      : event.result;
    hub.sessionBridge.onToolExecutionEnd(
      event.toolCallId,
      event.toolName,
      content,
      event.isError,
    );
  });

  // 活动分支结构变化：要求观察者重同步。
  pi.on("session_tree", async () => {
    hub.handleTreeNavigation();
  });
  pi.on("session_compact", async () => {
    hub.handleCompaction();
  });

  // 本机输入拦截：远端持有写租约期间阻止普通本机输入，避免双写。
  // 扩展命令（/remote reclaim 等）在此事件之前处理，不受影响；
  // 远端注入的消息 source === "extension"，必须放行。
  pi.on("input", async (event, ctx) => {
    if (!hub.remoteControlled) return;
    if (event.source === "extension") return { action: "continue" };
    ctx.ui.notify(
      "远端控制中，本机输入已暂停。使用 /remote reclaim 或 Ctrl+Shift+R 收回控制权。",
      "warning",
    );
    return { action: "handled" };
  });
}
