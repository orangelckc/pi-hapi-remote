/**
 * Transcript Projector（深模块）：把 Pi Session entries 与实时生命周期事件
 * 转换为可公开的远端表示（RemoteEntry）。
 *
 * 统一过滤：系统提示词、废弃分支、扩展私有数据（custom / custom_message）
 * 与不必要的本机路径元数据。Thinking 正文与助手错误信息自协议 v2 起完整转发。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  LIMITS,
  type RemoteEntry,
  type ToolCallEntry,
} from "../../shared/protocol.js";
import { EntryLog } from "../../shared/entry-log.js";

/** 文本截断：超长内容以省略号收尾。 */
export function truncateText(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (text.length <= maxLength) return { text, truncated: false };
  return { text: text.slice(0, maxLength) + "\n…(已截断)", truncated: true };
}

/** 从工具参数生成预览文本。 */
export function argsPreviewOf(args: unknown): string {
  if (args === undefined || args === null) return "";
  let text: string;
  if (typeof args === "string") {
    text = args;
  } else {
    try {
      text = JSON.stringify(args);
    } catch {
      text = String(args);
    }
  }
  return truncateText(text, LIMITS.maxArgsPreviewLength).text;
}

/** 提取消息文本内容（TextContent 拼接；图片以占位符表示）。 */
function textContentOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      } else if (b.type === "image") {
        parts.push("[图片]");
      }
    }
  }
  return parts.join("\n");
}

/** 提取助手消息正文（仅 TextContent）。 */
function assistantTextOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("");
}

/** 提取思考过程（Thinking 块拼接，截断至协议上限）；redacted 块单独标记。
 * 空值转为 undefined，可直接展开进 AssistantMessageEntry。 */
function thinkingOf(content: unknown): {
  thinking?: string;
  thinkingTruncated?: boolean;
  thinkingRedacted?: boolean;
} {
  if (!Array.isArray(content)) return {};
  const parts: string[] = [];
  let redacted = false;
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; thinking?: string; redacted?: boolean };
      if (b.type === "thinking") {
        if (b.redacted) {
          redacted = true;
        } else if (typeof b.thinking === "string") {
          parts.push(b.thinking);
        }
      }
    }
  }
  const { text, truncated } = truncateText(parts.join("\n"), LIMITS.maxThinkingLength);
  return {
    thinking: text || undefined,
    thinkingTruncated: truncated || undefined,
    thinkingRedacted: redacted || undefined,
  };
}

/** 助手错误信息（截断至协议上限）。 */
function errorMessageOf(message: { errorMessage?: string }): string | undefined {
  if (!message.errorMessage) return undefined;
  return truncateText(message.errorMessage, LIMITS.maxTextLength).text;
}

/** 提取助手消息中的工具调用块。 */
function toolCallsOf(content: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(content)) return [];
  const calls: Array<{ id: string; name: string }> = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; id?: string; name?: string };
      if (b.type === "toolCall" && typeof b.id === "string") {
        calls.push({ id: b.id, name: typeof b.name === "string" ? b.name : "tool" });
      }
    }
  }
  return calls;
}

/** 工具结果文本（截断至协议上限）。 */
function toolResultTextOf(content: unknown): { text: string; truncated: boolean } {
  return truncateText(textContentOf(content), LIMITS.maxToolResultLength);
}

/**
 * 实时会话投影。维护远端条目状态（唯一事实来源），
 * Session Bridge 在每个生命周期事件上调用对应方法并将返回值发布到 Event Journal。
 */
export class TranscriptProjector {
  private log = new EntryLog<RemoteEntry>();
  private seq = 0;

  /** 全量重建（分享开始、tree 导航、compaction 后）。 */
  rebuild(branchEntries: SessionEntry[]): void {
    this.log.clear();
    for (const entry of branchEntries) {
      this.absorbEntry(entry);
    }
  }

  /** 当前条目快照（按插入顺序）。 */
  snapshot(): RemoteEntry[] {
    return this.log.entries();
  }

  // ---- 流式助手消息 ----

  /** 流式助手消息开始：分配条目并发布（可能为空文本）。 */
  beginAssistantStream(model?: string): RemoteEntry {
    const entry: RemoteEntry = {
      kind: "assistant_message",
      id: `assistant:${++this.seq}`,
      text: "",
      modelLabel: model,
      timestamp: Date.now(),
    };
    this.put(entry);
    return entry;
  }

  /** 流式更新当前助手条目正文与思考过程。 */
  updateAssistantStream(entryId: string, message: { content: unknown }): RemoteEntry | null {
    const existing = this.log.get(entryId);
    if (!existing || existing.kind !== "assistant_message") return null;
    const updated: RemoteEntry = {
      ...existing,
      text: assistantTextOf(message.content),
      ...thinkingOf(message.content),
    };
    this.put(updated);
    return updated;
  }

  /** 流式结束：写入最终正文与思考过程；补齐尚未出现的工具调用条目。返回需要发布的条目。 */
  finalizeAssistantStream(
    entryId: string,
    message: { content: unknown; model?: string; errorMessage?: string },
  ): RemoteEntry[] {
    const results: RemoteEntry[] = [];
    const existing = this.log.get(entryId);
    const text = assistantTextOf(message.content);
    const thinking = thinkingOf(message.content);
    const error = errorMessageOf(message);
    if (existing && existing.kind === "assistant_message") {
      const updated: RemoteEntry = {
        ...existing,
        text,
        ...thinking,
        error,
        modelLabel: message.model ?? existing.modelLabel,
      };
      this.put(updated);
      results.push(updated);
    } else if (text || thinking.thinking || error) {
      const entry: RemoteEntry = {
        kind: "assistant_message",
        id: entryId,
        text,
        ...thinking,
        error,
        modelLabel: message.model,
        timestamp: Date.now(),
      };
      this.put(entry);
      results.push(entry);
    }
    for (const call of toolCallsOf(message.content)) {
      const updated = this.ensureToolCall(call.id, call.name);
      if (updated) results.push(updated);
    }
    return results;
  }

  // ---- 工具生命周期 ----

  /** 工具开始执行：创建 running 状态的工具条目（若已存在则仅更新参数）。 */
  toolStarted(toolCallId: string, toolName: string, args: unknown): RemoteEntry | null {
    const existing = this.log.get(toolCallId);
    if (existing && existing.kind === "tool_call") {
      const updated: ToolCallEntry = { ...existing, argsPreview: argsPreviewOf(args) };
      this.put(updated);
      return updated;
    }
    const entry: ToolCallEntry = {
      kind: "tool_call",
      id: toolCallId,
      toolName,
      argsPreview: argsPreviewOf(args),
      status: "running",
      timestamp: Date.now(),
    };
    this.put(entry);
    return entry;
  }

  /** 工具执行完成：填充结果并收敛状态（幂等）。 */
  toolFinished(
    toolCallId: string,
    toolName: string,
    content: unknown,
    isError: boolean,
  ): RemoteEntry | null {
    const { text, truncated } = toolResultTextOf(content);
    const existing = this.log.get(toolCallId);
    if (existing && existing.kind === "tool_call") {
      const updated: ToolCallEntry = {
        ...existing,
        toolName,
        status: isError ? "error" : "complete",
        resultText: text,
        resultTruncated: truncated,
        completedAt: Date.now(),
      };
      this.put(updated);
      return updated;
    }
    const entry: ToolCallEntry = {
      kind: "tool_call",
      id: toolCallId,
      toolName,
      argsPreview: "",
      status: isError ? "error" : "complete",
      resultText: text,
      resultTruncated: truncated,
      timestamp: Date.now(),
      completedAt: Date.now(),
    };
    this.put(entry);
    return entry;
  }

  // ---- 通用消息吸收（实时 message_end 与快照重建共用） ----

  /**
   * 处理已定稿的消息。返回需要发布的增量；
   * 不产生远端条目的消息（Thinking、扩展私有等）返回空数组。
   */
  absorbMessage(message: AgentMessage): RemoteEntry[] {
    switch (message.role) {
      case "user":
        return this.absorbUserMessage(message);
      case "assistant":
        return this.finalizeAssistantStream(`assistant:${++this.seq}`, message);
      case "toolResult":
        return this.absorbToolResult(message);
      case "bashExecution":
        return this.absorbBashExecution(message);
      case "branchSummary":
        return this.absorbNotice(`分支切换摘要：${message.summary}`);
      case "compactionSummary":
        return this.absorbNotice(
          `上下文已压缩（此前约 ${message.tokensBefore} tokens 已摘要）`,
        );
      default:
        // custom 等扩展私有消息不分享。
        return [];
    }
  }

  private absorbEntry(entry: SessionEntry): void {
    switch (entry.type) {
      case "message": {
        this.absorbMessage(entry.message as AgentMessage);
        return;
      }
      case "compaction": {
        this.absorbNotice(
          `上下文已压缩（此前约 ${entry.tokensBefore} tokens 已摘要）`,
        );
        return;
      }
      case "branch_summary": {
        this.absorbNotice(`分支切换摘要：${entry.summary}`);
        return;
      }
      default:
        // custom / custom_message / label / model_change 等不分享。
        return;
    }
  }

  private absorbUserMessage(message: { content: unknown; timestamp?: number }): RemoteEntry[] {
    const text = textContentOf(message.content);
    if (!text) return [];
    const entry: RemoteEntry = {
      kind: "user_message",
      id: `user:${++this.seq}`,
      text,
      timestamp: message.timestamp ?? Date.now(),
    };
    this.put(entry);
    return [entry];
  }

  private absorbToolResult(message: {
    toolCallId: string;
    toolName: string;
    content: unknown;
    isError: boolean;
  }): RemoteEntry[] {
    const updated = this.toolFinished(
      message.toolCallId,
      message.toolName,
      message.content,
      message.isError,
    );
    return updated ? [updated] : [];
  }

  private absorbBashExecution(message: { command: string; timestamp?: number }): RemoteEntry[] {
    const entry: RemoteEntry = {
      kind: "user_message",
      id: `bash:${++this.seq}`,
      text: `! ${message.command}`,
      timestamp: message.timestamp ?? Date.now(),
    };
    this.put(entry);
    return [entry];
  }

  private absorbNotice(text: string): RemoteEntry[] {
    const entry: RemoteEntry = {
      kind: "notice",
      id: `notice:${++this.seq}`,
      text,
      timestamp: Date.now(),
    };
    this.put(entry);
    return [entry];
  }

  private ensureToolCall(toolCallId: string, toolName: string): RemoteEntry | null {
    if (this.log.has(toolCallId)) return null;
    const entry: ToolCallEntry = {
      kind: "tool_call",
      id: toolCallId,
      toolName,
      argsPreview: "",
      status: "running",
      timestamp: Date.now(),
    };
    this.put(entry);
    return entry;
  }

  private put(entry: RemoteEntry): void {
    this.log.put(entry);
  }
}
