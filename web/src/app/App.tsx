/**
 * 应用入口：解析 URL Fragment 连接载荷、恢复已存连接、
 * 组装 AI SDK useChat（自定义 ChatTransport + 权威 entries 派生）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { useChat } from "@ai-sdk/react";
import type { SharePayload } from "../protocol.js";
import { ChatView } from "../components/chat/ChatView.js";
import { Welcome } from "../components/overlays.js";
import { useRemote } from "./useRemote.js";
import type { RemoteConnection } from "./connection.js";
import {
  entriesToUIMessages,
  createMessageCache,
  type RemoteUIMessage,
} from "../chat/ui-messages.js";
import { RemoteChatTransport, type RemoteCommandKind } from "../chat/transport.js";

// 开发预览：懒加载 + DEV 常量守卫，生产构建整体裁剪。
const PreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./PreviewPage.js").then((m) => ({ default: m.PreviewPage })),
    )
  : null;

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 解析 #/connect/<payload>；Fragment 不会发送给静态托管服务端。 */
function parseConnectPayload(): SharePayload | null {
  const match = /^#\/connect\/([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  if (!match) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(match[1]!)) as SharePayload;
    if (
      payload &&
      payload.version === 1 &&
      typeof payload.endpoint === "string" &&
      typeof payload.shareId === "string" &&
      typeof payload.viewerToken === "string"
    ) {
      return payload;
    }
    return null;
  } catch {
    return null;
  }
}

/** 已发送但尚未被服务端 echo 回来的乐观用户消息。 */
interface PendingSend {
  id: string;
  text: string;
  at: number;
}

export function App(): JSX.Element {
  // 开发预览：/preview 用静态数据渲染完整界面，不发起连接。
  if (import.meta.env.DEV && window.location.pathname === "/preview") {
    return (
      <Suspense>{PreviewPage ? <PreviewPage /> : null}</Suspense>
    );
  }

  const remote = useRemote();
  const [booted, setBooted] = useState(false);

  // transport 通过 ref 读取当前连接，自身保持稳定实例。
  const connectionRef = useRef<RemoteConnection | null>(null);
  connectionRef.current = remote.connection;
  const transport = useMemo(
    () => new RemoteChatTransport(() => connectionRef.current),
    [],
  );

  const chat = useChat<RemoteUIMessage>({
    id: "pi-remote",
    transport,
    // 长轮询高频帧的 UI 更新节流。
    throttle: 50,
  });

  const cacheRef = useRef(createMessageCache());
  const pendingRef = useRef<PendingSend | null>(null);

  const boot = useCallback(async (): Promise<void> => {
    const payload = parseConnectPayload();
    if (payload) {
      // 清除地址栏中的敏感 Fragment，避免被复制或记录。
      history.replaceState(null, "", window.location.pathname);
      await remote.startFromPayload(payload);
      return;
    }
    const restored = await remote.startFromStorage();
    if (!restored) {
      setBooted(true);
    }
  }, [remote]);

  useEffect(() => {
    void boot();
    // 仅启动时执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const entries = remote.state?.entries;

  // 权威 entries → UIMessage 注入（entry 引用未变时复用消息对象，
  // 配合 EntryItem memo 避免流式期间全列表重渲染）。
  useEffect(() => {
    if (!entries) return;
    const derived = entriesToUIMessages(entries, cacheRef.current);

    const pending = pendingRef.current;
    if (pending) {
      const echoed = derived.some(
        (m) =>
          m.role === "user" &&
          m.metadata.entry.kind === "user_message" &&
          m.metadata.entry.text === pending.text &&
          m.metadata.entry.timestamp >= pending.at - 5_000,
      );
      if (echoed) {
        pendingRef.current = null;
      } else {
        // 乐观尾部：服务端 echo 到达前保留已发送消息。
        derived.push({
          id: pending.id,
          role: "user",
          metadata: {
            entry: {
              kind: "user_message",
              id: pending.id,
              text: pending.text,
              timestamp: pending.at,
            },
          },
          parts: [{ type: "text", text: pending.text, state: "done" }],
        });
      }
    }
    chat.setMessages(derived);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  const onSend = useCallback(
    (text: string, kind: RemoteCommandKind): void => {
      pendingRef.current = { id: crypto.randomUUID(), text, at: Date.now() };
      void chat.sendMessage({ text }, { body: { command: kind } });
    },
    [chat],
  );

  const onAbort = useCallback((): void => {
    void remote.connection?.sendCommand({
      id: crypto.randomUUID(),
      type: "abort",
    });
  }, [remote.connection]);

  const state = remote.state;

  if (!state) {
    if (!booted) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          正在连接…
        </div>
      );
    }
    return <Welcome />;
  }

  return (
    <ChatView
      state={state}
      amController={remote.amController}
      connection={remote.connection}
      messages={chat.messages}
      sending={chat.status !== "ready"}
      sendError={chat.error?.message ?? null}
      onClear={remote.clearCredentials}
      onSend={onSend}
      onAbort={onAbort}
    />
  );
}
