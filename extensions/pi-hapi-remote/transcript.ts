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

/** 从工具参数提取目标摘要（bash→command，其余依次取 path / pattern / query）。 */
export function targetOf(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  let value = "";
  if (typeof record.command === "string" && record.command.trim()) {
    value = record.command;
  } else {
    for (const key of ["path", "file_path", "filePath", "pattern", "query"]) {
      const v = record[key];
      if (typeof v === "string" && v.trim()) {
        value = v;
        break;
      }
    }
  }
  return truncateText(value.trim(), LIMITS.maxTargetLength).text;
}

/** 工具结果的 content 载荷（事件路径传 AgentToolResult，消息路径传消息本体）。 */
function resultContentOf(result: unknown): unknown {
  if (result && typeof result === "object" && "content" in result) {
    return (result as { content: unknown }).content;
  }
  return result;
}

/** 防御式提取工具结果 details.diff（编辑类工具由 Pi 填充）。 */
function diffOf(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const details = (result as { details?: unknown }).details;
  if (details && typeof details === "object") {
    const diff = (details as { diff?: unknown }).diff;
    if (typeof diff === "string") return diff;
  }
  return "";
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

// ---- 用户消息内部信封剥离 ----
// 移植自 pi-agent-extension 的 promptModes：信封（plan-mode / plan-approval /
// handoff-context / skill / pi-context）面向模型而非对话记录，转发前剥离，
// 仅保留技能名与文件引用作为展示摘要，避免本机路径与超长 SKILL.md 外泄。

interface EnvelopePattern {
  leading: RegExp;
  trailing: RegExp;
  kind?: "context" | "skill";
}

const ENVELOPE_PATTERNS: readonly EnvelopePattern[] = [
  {
    leading: /^<pi-context>([\s\S]*?)<\/pi-context>\s*/u,
    trailing: /\s*<pi-context>([\s\S]*?)<\/pi-context>$/u,
    kind: "context",
  },
  {
    leading: /^<plan-mode>[\s\S]*?<\/plan-mode>\s*/u,
    trailing: /\s*<plan-mode>[\s\S]*?<\/plan-mode>$/u,
  },
  {
    leading: /^<plan-approval>[\s\S]*?<\/plan-approval>\s*/u,
    trailing: /\s*<plan-approval>[\s\S]*?<\/plan-approval>$/u,
  },
  {
    leading: /^<handoff-context>[\s\S]*?<\/handoff-context>\s*/u,
    trailing: /\s*<handoff-context>[\s\S]*?<\/handoff-context>$/u,
  },
  {
    leading: /^<skill name="([^"\n]+)"(?: location="[^"]*")?>\n[\s\S]*?\n<\/skill>\s*/u,
    trailing: /\s*<skill name="([^"\n]+)"(?: location="[^"]*")?>\n[\s\S]*?\n<\/skill>$/u,
    kind: "skill",
  },
];

const GOAL_CONFIRMATION_PATTERN =
  /^\[GOAL CONFIRMATION focus=(?:goal|sisyphus)\]\n[^\n]*\n\nTopic the user provided:\n<goal_topic>\n([\s\S]*?)\n<\/goal_topic>(?:\n[\s\S]*)?$/u;

export interface ParsedUserPrompt {
  /** 剥离全部信封后的用户可见文本。 */
  text: string;
  /** 首个 skill 信封的技能名。 */
  skillName?: string;
  /** 首个 pi-context 块的原文（用于提取文件引用）。 */
  context?: string;
}

/** 剥离用户消息首尾的内部信封，保留展示摘要。 */
export function parseUserPromptEnvelopes(raw: string): ParsedUserPrompt {
  let visible = raw.match(GOAL_CONFIRMATION_PATTERN)?.[1] ?? raw;
  const parsed: ParsedUserPrompt = { text: visible };
  let previous = "";
  while (visible !== previous) {
    previous = visible;
    for (const pattern of ENVELOPE_PATTERNS) {
      const leading = visible.match(pattern.leading);
      const trailing = leading ? undefined : visible.match(pattern.trailing);
      const match = leading ?? trailing;
      if (!match) continue;
      if (pattern.kind === "skill") {
        parsed.skillName ??= match[1];
      } else if (pattern.kind === "context") {
        parsed.context ??= match[1];
      }
      visible = leading
        ? visible.slice(leading[0].length)
        : visible.slice(0, visible.length - trailing![0].length);
      break;
    }
  }
  parsed.text = visible;
  return parsed;
}

/** 从 pi-context 正文提取文件引用（- file: "path" → @basename）。 */
function contextFileRefs(context: string | undefined): string[] {
  if (!context) return [];
  const refs: string[] = [];
  for (const line of context.split("\n")) {
    if (!line.startsWith("- file: ")) continue;
    try {
      const value = JSON.parse(line.slice("- file: ".length)) as unknown;
      if (typeof value === "string" && value.trim()) {
        refs.push(`@${value.split(/[/\\]/).pop() || value}`);
      }
    } catch {
      refs.push("@file");
    }
  }
  return refs;
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
  /** 预分配的流式助手条目：尚未产生可见内容，不入库不发布。 */
  private pendingAssistant: {
    id: string;
    modelLabel?: string;
    timestamp: number;
  } | null = null;

  /** 全量重建（分享开始、tree 导航、compaction 后）。 */
  rebuild(branchEntries: SessionEntry[]): void {
    this.log.clear();
    this.pendingAssistant = null;
    for (const entry of branchEntries) {
      this.absorbEntry(entry);
    }
  }

  /** 当前条目快照（按插入顺序）。 */
  snapshot(): RemoteEntry[] {
    return this.log.entries();
  }

  // ---- 流式助手消息 ----

  /**
   * 流式助手消息开始：预分配条目 ID。
   * 条目在首次出现可见内容（正文 / 思考 / 错误）时才实体化发布，
   * 纯工具调用轮次因此不会残留空白气泡。
   */
  beginAssistantStream(model?: string): string {
    this.pendingAssistant = {
      id: `assistant:${++this.seq}`,
      modelLabel: model,
      timestamp: Date.now(),
    };
    return this.pendingAssistant.id;
  }

  /** 流式更新当前助手条目正文与思考过程；尚无可见内容时返回 null。 */
  updateAssistantStream(entryId: string, message: { content: unknown }): RemoteEntry | null {
    const text = assistantTextOf(message.content);
    const thinking = thinkingOf(message.content);
    const existing = this.log.get(entryId);
    if (existing && existing.kind === "assistant_message") {
      const updated: RemoteEntry = {
        ...existing,
        text,
        ...thinking,
      };
      this.put(updated);
      return updated;
    }
    const pending = this.pendingAssistant;
    if (!pending || pending.id !== entryId) return null;
    if (!text && !thinking.thinking && !thinking.thinkingRedacted) return null;
    const entry: RemoteEntry = {
      kind: "assistant_message",
      id: entryId,
      text,
      ...thinking,
      modelLabel: pending.modelLabel,
      timestamp: pending.timestamp,
    };
    this.put(entry);
    this.pendingAssistant = null;
    return entry;
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
    const pending = this.pendingAssistant;
    this.pendingAssistant = null;
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
    } else if (text || thinking.thinking || thinking.thinkingRedacted || error) {
      const entry: RemoteEntry = {
        kind: "assistant_message",
        id: entryId,
        text,
        ...thinking,
        error,
        modelLabel: message.model ?? pending?.modelLabel,
        timestamp: pending?.timestamp ?? Date.now(),
      };
      this.put(entry);
      results.push(entry);
    }
    // 全空轮次（纯 toolCall、无思考无正文无错误）：不产生条目，与快照重建语义一致。
    for (const call of toolCallsOf(message.content)) {
      const updated = this.ensureToolCall(call.id, call.name);
      if (updated) results.push(updated);
    }
    return results;
  }

  // ---- 工具生命周期 ----

  /** 工具开始执行：创建 running 状态的工具条目（若已存在则仅更新参数）。 */
  toolStarted(toolCallId: string, toolName: string, args: unknown): RemoteEntry | null {
    const target = targetOf(args);
    const existing = this.log.get(toolCallId);
    if (existing && existing.kind === "tool_call") {
      const updated: ToolCallEntry = {
        ...existing,
        argsPreview: argsPreviewOf(args),
        target: target || undefined,
      };
      this.put(updated);
      return updated;
    }
    const entry: ToolCallEntry = {
      kind: "tool_call",
      id: toolCallId,
      toolName,
      argsPreview: argsPreviewOf(args),
      target: target || undefined,
      status: "running",
      timestamp: Date.now(),
    };
    this.put(entry);
    return entry;
  }

  /** 工具执行完成：填充结果与 diff 并收敛状态（幂等）。
   * result 兼容两种形态：AgentToolResult（事件路径）与 ToolResultMessage（消息路径）。 */
  toolFinished(
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ): RemoteEntry | null {
    const { text, truncated } = toolResultTextOf(resultContentOf(result));
    const diffResult = truncateText(diffOf(result), LIMITS.maxDiffLength);
    const diff = diffResult.text || undefined;
    const diffTruncated = diff ? diffResult.truncated || undefined : undefined;
    const existing = this.log.get(toolCallId);
    if (existing && existing.kind === "tool_call") {
      const updated: ToolCallEntry = {
        ...existing,
        toolName,
        status: isError ? "error" : "complete",
        resultText: text,
        resultTruncated: truncated,
        diff,
        diffTruncated,
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
      diff,
      diffTruncated,
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

  private absorbUserMessage(message: {
    content: unknown;
    timestamp?: number;
  }): RemoteEntry[] {
    const raw = textContentOf(message.content);
    if (!raw) return [];
    // 剥离内部信封：仅转发可见文本与展示摘要（技能名 / 文件引用）。
    const parsed = parseUserPromptEnvelopes(raw);
    const contextFiles = contextFileRefs(parsed.context);
    if (!parsed.text && !parsed.skillName && contextFiles.length === 0) return [];
    const entry: RemoteEntry = {
      kind: "user_message",
      id: `user:${++this.seq}`,
      text: parsed.text,
      skillName: parsed.skillName,
      contextFiles: contextFiles.length > 0 ? contextFiles : undefined,
      timestamp: message.timestamp ?? Date.now(),
    };
    this.put(entry);
    return [entry];
  }

  private absorbToolResult(message: {
    toolCallId: string;
    toolName: string;
    content: unknown;
    details?: unknown;
    isError: boolean;
  }): RemoteEntry[] {
    // ToolResultMessage 本体即携带 content + details，与 AgentToolResult 形状兼容。
    const updated = this.toolFinished(
      message.toolCallId,
      message.toolName,
      message,
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
