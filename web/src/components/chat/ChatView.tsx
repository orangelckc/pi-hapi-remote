/**
 * 聊天主视图：顶部状态栏、状态横幅、消息列表与输入区。
 * 消息来源为 useChat（AI SDK），由权威 entries 派生注入。
 */
import { AlertTriangle, Eye, RadioTower } from "lucide-react";
import type { ConnectionState, RemoteConnection } from "../../app/connection.js";
import type { RemoteUIMessage } from "../../chat/ui-messages.js";
import type { RemoteCommandKind } from "../../chat/transport.js";
import { cn } from "../../lib/utils.js";
import { EndedOverlay, InvalidOverlay } from "../overlays.js";
import { ChatHeader } from "./ChatHeader.js";
import { MessageList } from "./MessageList.js";
import { Composer } from "./Composer.js";

interface ChatViewProps {
  state: ConnectionState;
  amController: boolean;
  connection: RemoteConnection | null;
  messages: RemoteUIMessage[];
  sending: boolean;
  sendError: string | null;
  onClear(): Promise<void>;
  onSend(text: string, kind: RemoteCommandKind): void;
  onAbort(): void;
}

function Banner({
  tone,
  icon,
  children,
}: {
  tone: "warn" | "danger" | "info";
  icon?: boolean;
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

export function ChatView({
  state,
  amController,
  connection,
  messages,
  sending,
  sendError,
  onClear,
  onSend,
  onAbort,
}: ChatViewProps): JSX.Element {
  if (state.phase === "ended") {
    return <EndedOverlay onClear={() => void onClear()} />;
  }
  if (state.phase === "invalid") {
    return <InvalidOverlay onClear={() => void onClear()} />;
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col">
      <ChatHeader state={state} amController={amController} />

      {state.phase === "reconnecting" && (
        <Banner tone="warn" icon>
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

      <MessageList messages={messages} isStreaming={state.isStreaming} />

      <Composer
        state={state}
        amController={amController}
        connection={connection}
        sending={sending}
        sendError={sendError}
        onSend={onSend}
        onAbort={onAbort}
      />
    </div>
  );
}
