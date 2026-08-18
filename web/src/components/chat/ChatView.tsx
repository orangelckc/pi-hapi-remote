/**
 * 聊天主视图：顶部状态栏、状态横幅、消息列表与输入区。
 * 只依赖 RemoteChatView 视图接口（生产由 useRemoteChat 提供，
 * 预览由静态适配器提供）。
 */
import { AlertTriangle, Eye, RadioTower } from "lucide-react";
import type { RemoteChatView } from "../../app/useRemoteChat.js";
import { cn } from "../../lib/utils.js";
import { EndedOverlay, InvalidOverlay } from "../overlays.js";
import { ChatHeader } from "./ChatHeader.js";
import { MessageList } from "./MessageList.js";
import { Composer } from "./Composer.js";

function Banner({
  tone,
  children,
}: {
  tone: "warn" | "danger" | "info";
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center gap-1.5 px-4 py-1.5 text-center text-xs",
        tone === "warn" && "bg-warn/10 text-warn",
        tone === "danger" && "bg-danger/10 text-danger",
        tone === "info" && "bg-primary/8 text-primary",
      )}
    >
      {children}
    </div>
  );
}

export function ChatView({ view }: { view: RemoteChatView }): JSX.Element {
  const { state, amController } = view;

  if (state.phase === "ended") {
    return <EndedOverlay onClear={() => void view.reset()} />;
  }
  if (state.phase === "invalid") {
    return <InvalidOverlay onClear={() => void view.reset()} />;
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col">
      <ChatHeader view={view} />

      {state.phase === "reconnecting" && (
        <Banner tone="warn">
          <RadioTower className="size-3.5 shrink-0" />
          连接中断，画面保留但不可发送命令；恢复后自动同步。
        </Banner>
      )}
      {state.phase === "error" && (
        <Banner tone="danger">
          <AlertTriangle className="size-3.5 shrink-0" />
          连接出错：{state.errorMessage ?? "未知错误"}
        </Banner>
      )}
      {!amController && state.controllerDeviceId === undefined && (
        <Banner tone="info">
          <Eye className="size-3.5 shrink-0" />
          只读模式 · 你正在观察本机当前会话
        </Banner>
      )}
      {!amController && state.controllerDeviceId !== undefined && (
        <Banner tone="info">
          <Eye className="size-3.5 shrink-0" />「{state.controllerLabel ?? "其他设备"}
          」正在控制 · 你以只读观察
        </Banner>
      )}

      <MessageList messages={view.messages} isStreaming={state.isStreaming} />

      <Composer view={view} />
    </div>
  );
}
