/**
 * Remote Chat View（深模块）：PWA 聊天界面对远端会话的唯一视图接口。
 *
 * 组装连接生命周期（useRemote）、AI SDK 发送链路（useChat + 自定义
 * ChatTransport）、权威 entries → UIMessage 派生与乐观消息桥接。
 * UI 层（ChatView 及其子组件）只接触本接口，不感知 connection /
 * transport / 派生缓存等内部结构；PreviewPage 以静态适配器满足同一接口。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import type { ConnectionState, RemoteConnection } from "./connection.js";
import type { RemoteSession } from "./useRemote.js";
import {
  entriesToUIMessages,
  createMessageCache,
  type RemoteUIMessage,
} from "../chat/ui-messages.js";
import { RemoteChatTransport, type RemoteCommandKind } from "../chat/transport.js";

export type ControlRequestOutcome = "approved" | "denied" | "timeout";

/** 聊天界面对远端会话的完整视图接口。 */
export interface RemoteChatView {
  state: ConnectionState;
  messages: RemoteUIMessage[];
  amController: boolean;
  sending: boolean;
  sendError: string | null;
  /** 经 useChat → ChatTransport 发送命令。 */
  send(text: string, kind: RemoteCommandKind): void;
  /** 中止 Agent 运行（独立命令通道）。 */
  abort(): void;
  /** 只读设备申请控制权（等待本机审批）。 */
  requestControl(): Promise<ControlRequestOutcome>;
  /** 控制者移交控制权给本机。 */
  releaseControl(): Promise<void>;
  /** 清除凭证并返回首页。 */
  reset(): Promise<void>;
}

/** 已发送但尚未被服务端 echo 回来的乐观用户消息。 */
interface PendingSend {
  id: string;
  text: string;
  at: number;
}

/** 接收共享的连接会话（App 持有同一实例执行 boot）。 */
export function useRemoteChat(remote: RemoteSession): RemoteChatView | null {
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

  const send = useCallback(
    (text: string, kind: RemoteCommandKind): void => {
      const id = crypto.randomUUID();
      const at = Date.now();
      pendingRef.current = { id, text, at };
      // metadata 必传：useChat 会立即追加乐观用户消息并渲染，
      // 缺失时 EntryItem 读取 message.metadata.entry 抛错导致整树卸载（黑屏）。
      void chat.sendMessage(
        {
          text,
          metadata: { entry: { kind: "user_message", id, text, timestamp: at } },
        },
        { body: { command: kind } },
      );
    },
    [chat],
  );

  const abort = useCallback((): void => {
    void connectionRef.current?.sendCommand({
      id: crypto.randomUUID(),
      type: "abort",
    });
  }, []);

  const requestControl = useCallback((): Promise<ControlRequestOutcome> => {
    const connection = connectionRef.current;
    if (!connection) return Promise.resolve<ControlRequestOutcome>("denied");
    return connection.requestControl();
  }, []);

  const releaseControl = useCallback((): Promise<void> => {
    const connection = connectionRef.current;
    if (!connection) return Promise.reject(new Error("连接不可用"));
    return connection.releaseControl();
  }, []);

  const state = remote.state;
  if (!state) return null;

  return {
    state,
    messages: chat.messages,
    amController: remote.amController,
    sending: chat.status !== "ready",
    sendError: chat.error?.message ?? null,
    send,
    abort,
    requestControl,
    releaseControl,
    reset: remote.clearCredentials,
  };
}
