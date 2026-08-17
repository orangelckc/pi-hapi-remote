/**
 * /remote 命令集：start / status / reclaim / revoke / stop。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RemoteHub } from "./remote-hub.js";

const DATA_EXPOSURE_NOTICE =
  "当前活动分支中的用户消息、助手正文、工具参数和工具输出将对分享链接持有者可见。\n\n" +
  "Thinking、系统提示词、废弃分支和扩展私有数据不会公开。\n\n" +
  "注意：工具输出可能包含密钥、环境变量或文件内容，请自行判断是否适合分享。";

function splitArgs(args: string): { subcommand: string; rest: string } {
  const trimmed = args.trim();
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) {
    return { subcommand: trimmed, rest: "" };
  }
  return {
    subcommand: trimmed.slice(0, spaceIndex),
    rest: trimmed.slice(spaceIndex + 1).trim(),
  };
}

export function registerRemoteCommands(pi: ExtensionAPI, hub: RemoteHub): void {
  pi.registerCommand("remote", {
    description: "远端控制：start/status/reclaim/revoke/stop",
    handler: async (args, ctx) => {
      const { subcommand } = splitArgs(args);
      switch (subcommand) {
        case "start":
          await handleStart(hub, ctx);
          return;
        case "status":
          handleStatus(hub, ctx);
          return;
        case "reclaim":
          handleReclaim(hub, ctx);
          return;
        case "revoke":
          handleRevoke(hub, ctx);
          return;
        case "stop":
          await handleStop(hub, ctx);
          return;
        default:
          ctx.ui.notify(
            "用法：/remote start | status | reclaim | revoke | stop",
            "info",
          );
          return;
      }
    },
  });
}

async function handleStart(hub: RemoteHub, ctx: ExtensionContext): Promise<void> {
  if (hub.isSharing) {
    ctx.ui.notify("分享已在进行中，使用 /remote status 查看。", "warning");
    return;
  }
  const confirmed = ctx.hasUI
    ? await ctx.ui.confirm("开启远程分享？", DATA_EXPOSURE_NOTICE)
    : false;
  if (!confirmed) {
    ctx.ui.notify("已取消。", "info");
    return;
  }
  try {
    const result = await hub.start(ctx);
    ctx.ui.notify(
      `分享已开启：${result.publicUrl}\n正在展示二维码…`,
      "info",
    );
    await hub.showQrOverlay(ctx);
  } catch (error) {
    await hub.stop("start_failed", { audit: false });
    ctx.ui.notify(`开启失败：${(error as Error).message}`, "error");
  }
}

function handleStatus(hub: RemoteHub, ctx: ExtensionContext): void {
  const status = hub.status();
  if (!status.sharing) {
    ctx.ui.notify("当前没有进行中的分享。使用 /remote start 开启。", "info");
    return;
  }
  const controller = status.controller
    ? `远端控制者：${status.controller.deviceLabel}`
    : "本机持有控制权";
  const viewers = status.viewerCount !== undefined ? `观察者连接：${status.viewerCount}\n` : "";
  ctx.ui.notify(
    `分享进行中\n${viewers}${controller}\n公网入口：${status.publicUrl}\n` +
      `Viewer 链接：${status.viewerUrl}\n控制二维码链接（一次性）：${status.controllerUrl}`,
    "info",
  );
}

function handleReclaim(hub: RemoteHub, ctx: ExtensionContext): void {
  const previous = hub.reclaim();
  if (previous) {
    ctx.ui.notify(`已收回「${previous.deviceLabel}」的控制权。`, "info");
  } else {
    ctx.ui.notify("当前没有远端控制者。", "info");
  }
}

function handleRevoke(hub: RemoteHub, ctx: ExtensionContext): void {
  const previous = hub.revoke();
  if (previous) {
    ctx.ui.notify(`已撤销「${previous.deviceLabel}」的写权限。`, "info");
  } else {
    ctx.ui.notify("当前没有远端控制者。", "info");
  }
}

async function handleStop(hub: RemoteHub, ctx: ExtensionContext): Promise<void> {
  if (!hub.isSharing) {
    ctx.ui.notify("当前没有进行中的分享。", "info");
    return;
  }
  await hub.stop("manual_stop");
  ctx.ui.notify("分享已停止，隧道与全部授权已关闭。", "info");
}
