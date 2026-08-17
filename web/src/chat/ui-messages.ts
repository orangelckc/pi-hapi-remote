/**
 * RemoteEntry → AI SDK UIMessage 派生层。
 *
 * 设计说明：本产品的服务端（本机 Pi 扩展）是会话状态的唯一权威源，
 * 客户端通过长轮询获得快照 + 增量事件（含 entry_updated 对已有条目的
 * 原地更新与断线 resync 时的整体替换）。AI SDK 的流式 UIMessageChunk
 * 协议只能追加新消息、无法表达"替换历史"，因此这里不把长轮询桥接为
 * chunk 流，而是将权威 entries 派生为 UIMessage 视图模型后经
 * useChat().setMessages 注入——渲染层因此获得完整的 AI SDK parts
 * 体系（text / reasoning / dynamic-tool / data-*），发送链路则由
 * useChat + 自定义 ChatTransport 驱动（见 transport.ts）。
 */
import type { UIMessage } from "ai";
import type { RemoteEntry } from "../protocol.js";

/** 消息级元数据：保留原始条目引用与展示信息。 */
export interface RemoteMessageMetadata {
  entry: RemoteEntry;
}

/** 扩展的 data parts：助手错误信息与会话级提示。 */
export type RemoteDataParts = {
  error: { message: string };
  notice: { text: string };
};

/** metadata 交叉为必填：派生层保证每条消息都携带原始 entry。 */
export type RemoteUIMessage = UIMessage<
  RemoteMessageMetadata,
  RemoteDataParts
> & { metadata: RemoteMessageMetadata };

/** 工具调用在 dynamic-tool part 中的输入/输出载荷。 */
export interface ToolPreviewInput {
  preview: string;
}
export interface ToolResultOutput {
  text: string;
  truncated: boolean;
}

/** 派生缓存：entry 引用未变化时复用消息对象，保证列表 memo 生效。 */
export type MessageCache = Map<string, RemoteUIMessage>;

export function createMessageCache(): MessageCache {
  return new Map();
}

export function entriesToUIMessages(
  entries: RemoteEntry[],
  cache: MessageCache,
): RemoteUIMessage[] {
  const seen = new Set<string>();
  const messages: RemoteUIMessage[] = [];
  for (const entry of entries) {
    seen.add(entry.id);
    const cached = cache.get(entry.id);
    // 同一 entry 对象（引用相等）且缓存的消息 role 一致 → 直接复用。
    if (cached && cached.metadata?.entry === entry) {
      messages.push(cached);
      continue;
    }
    const message = deriveMessage(entry);
    cache.set(entry.id, message);
    messages.push(message);
  }
  // 清理已不存在的条目（resync 后整体替换场景）。
  for (const id of cache.keys()) {
    if (!seen.has(id)) cache.delete(id);
  }
  return messages;
}

function deriveMessage(entry: RemoteEntry): RemoteUIMessage {
  switch (entry.kind) {
    case "user_message":
      return {
        id: entry.id,
        role: "user",
        metadata: { entry },
        parts: [{ type: "text", text: entry.text, state: "done" }],
      };
    case "assistant_message": {
      const parts: RemoteUIMessage["parts"] = [];
      if (entry.thinking !== undefined || entry.thinkingRedacted === true) {
        parts.push({
          type: "reasoning",
          // 正文未出现视为思考流式中。redacted 标记从 metadata.entry 读取。
          state: entry.text ? "done" : "streaming",
          text: entry.thinking ?? "",
        });
      }
      if (entry.error !== undefined) {
        parts.push({
          type: "data-error",
          id: `${entry.id}-error`,
          data: { message: entry.error },
        });
      }
      if (entry.text || parts.length === 0) {
        parts.push({
          type: "text",
          text: entry.text,
          state: entry.text ? "done" : "streaming",
        });
      }
      return { id: entry.id, role: "assistant", metadata: { entry }, parts };
    }
    case "tool_call": {
      const part = {
        type: "dynamic-tool" as const,
        toolCallId: entry.id,
        toolName: entry.toolName,
        input: { preview: entry.argsPreview } satisfies ToolPreviewInput,
        ...(entry.status === "running"
          ? { state: "input-available" as const }
          : entry.status === "complete"
            ? {
                state: "output-available" as const,
                output: {
                  text: entry.resultText ?? "",
                  truncated: entry.resultTruncated === true,
                } satisfies ToolResultOutput,
              }
            : {
                state: "output-error" as const,
                errorText: entry.resultText ?? "工具执行出错",
              }),
      };
      return {
        id: entry.id,
        role: "assistant",
        metadata: { entry },
        parts: [part],
      };
    }
    case "notice":
      return {
        id: entry.id,
        role: "assistant",
        metadata: { entry },
        parts: [
          { type: "data-notice", id: `${entry.id}-notice`, data: { text: entry.text } },
        ],
      };
  }
}
