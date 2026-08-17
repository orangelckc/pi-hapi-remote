/**
 * 自定义 ChatTransport：把 AI SDK useChat 的发送链路接到本机
 * HTTP Bridge 的 /v1/commands 端点。
 *
 * - sendMessages：取最后一条用户消息文本，按调用方通过 body.command
 *   指定的类型（prompt / steer / follow_up，默认 prompt）发送控制命令，
 *   返回立即结束的确认流——会话观察流由 RemoteConnection 的长轮询
 *   独立驱动，不经流式 chunk 协议（见 ui-messages.ts 设计说明）。
 * - reconnectToStream：返回 null；断线恢复由 RemoteConnection 负责。
 */
import type {
  ChatTransport,
  UIMessage,
  UIMessageChunk,
} from "ai";
import type { RemoteConnection } from "../app/connection.js";
import type { RemoteUIMessage } from "./ui-messages.js";

export type RemoteCommandKind = "prompt" | "steer" | "follow_up";

interface SendMessagesOptions {
  messages: RemoteUIMessage[];
  body?: unknown;
}

/** 从消息列表提取最后一条用户消息的纯文本。 */
function lastUserText(messages: RemoteUIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    return message.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

function ackStream(): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: "finish" });
      controller.close();
    },
  });
}

export class RemoteChatTransport implements ChatTransport<RemoteUIMessage> {
  constructor(
    private getConnection: () => RemoteConnection | null,
  ) {}

  async sendMessages(
    options: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0] &
      SendMessagesOptions,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const connection = this.getConnection();
    const text = lastUserText(options.messages).trim();
    const requested = (options.body as { command?: RemoteCommandKind } | undefined)
      ?.command;
    const kind: RemoteCommandKind =
      requested === "steer" || requested === "follow_up" ? requested : "prompt";

    if (!connection) {
      throw new Error("连接不可用");
    }
    if (!text) {
      throw new Error("消息内容为空");
    }
    await connection.sendCommand({ id: crypto.randomUUID(), type: kind, text });
    return ackStream();
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }
}
