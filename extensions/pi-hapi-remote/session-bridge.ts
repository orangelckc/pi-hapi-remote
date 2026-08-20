/**
 * Session Bridge（深模块）：封装 Pi 生命周期事件附着、活动分支快照、
 * 事件归一化、命令注入与 Session 身份校验。
 * 外部模块只接触稳定的 Snapshot / Remote Event / Remote Command 接口。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { basename } from "node:path";
import type {
  RemoteCommand,
  RemoteEntry,
  RemoteState,
  SessionSnapshot,
} from "../../shared/protocol.js";
import { LIMITS, PROTOCOL_VERSION } from "../../shared/protocol.js";
import { EventJournal } from "./event-buffer.js";
import { TranscriptProjector } from "./transcript.js";

export interface SessionInfo {
  id: string;
  name?: string;
  cwdLabel: string;
}

/** 命令执行结果。 */
export type CommandResult =
  | { ok: true; duplicate?: boolean }
  | { ok: false; code: string; message: string };

/**
 * 附着到当前 Pi Session 的桥接器。
 * index.ts 负责把 pi.on(...) 事件转发到此处；HTTP 层通过 executeCommand 注入命令。
 */
export class SessionBridge {
  private pi: ExtensionAPI;
  private journal: EventJournal;
  private projector = new TranscriptProjector();
  private ctx: ExtensionContext | null = null;
  private shareSessionId: string | null = null;
  private isStreaming = false;
  /** 当前流式助手消息的条目 ID。 */
  private streamingAssistantId: string | null = null;
  /** 已发布到 journal 的条目 ID（区分 added / updated 事件）。 */
  private projectedIds = new Set<string>();
  /** 待合并的流式条目更新（合并窗口见 LIMITS.streamingUpdateCoalesceMs）。 */
  private pendingStreamUpdate: {
    entry: RemoteEntry;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** 命令幂等去重（定容 FIFO）。 */
  private recentCommandIds: string[] = [];
  private seenCommandIds = new Set<string>();

  constructor(pi: ExtensionAPI, journal: EventJournal) {
    this.pi = pi;
    this.journal = journal;
  }

  // ---- 生命周期 ----

  /** Session 启动/重载：保存上下文。分享逻辑由 RemoteHub 决定是否重建。 */
  attach(ctx: ExtensionContext): void {
    this.ctx = ctx;
  }

  /** Session 关闭：释放上下文引用（分享本身由 RemoteHub 停止）。 */
  detach(): void {
    this.ctx = null;
    this.streamingAssistantId = null;
    this.shareSessionId = null;
    this.isStreaming = false;
    this.dropStreamUpdate();
  }

  get attached(): boolean {
    return this.ctx !== null;
  }

  /** 分享开始：锁定 Session 身份并从活动分支重建投影。 */
  beginShare(): SessionInfo | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const sessionId = ctx.sessionManager.getSessionId();
    this.shareSessionId = sessionId;
    this.projectedIds.clear();
    this.projector.rebuild(ctx.sessionManager.getBranch());
    for (const entry of this.projector.snapshot()) {
      this.projectedIds.add(entry.id);
    }
    return this.sessionInfo();
  }

  /** 活动分支发生变化（tree 导航/压缩）：重建投影并要求观察者重同步。 */
  resyncFromSession(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.dropStreamUpdate();
    this.projectedIds.clear();
    this.projector.rebuild(ctx.sessionManager.getBranch());
    for (const entry of this.projector.snapshot()) {
      this.projectedIds.add(entry.id);
    }
    this.journal.invalidate();
  }

  sessionInfo(): SessionInfo | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const cwd = ctx.sessionManager.getCwd();
    return {
      id: ctx.sessionManager.getSessionId(),
      name: ctx.sessionManager.getSessionName() ?? undefined,
      cwdLabel: cwd ? basename(cwd) || cwd : "",
    };
  }

  /** 是否仍处于分享开始时的同一 Session。 */
  get sameSession(): boolean {
    if (!this.ctx || !this.shareSessionId) return false;
    return this.ctx.sessionManager.getSessionId() === this.shareSessionId;
  }

  get streaming(): boolean {
    return this.isStreaming;
  }

  /** 生成快照（在单个同步块内保证 entries 与 cursor 一致）。 */
  buildSnapshot(shareId: string, state: RemoteState): SessionSnapshot | null {
    const info = this.sessionInfo();
    if (!info) return null;
    return {
      protocolVersion: PROTOCOL_VERSION,
      shareId,
      session: info,
      state,
      entries: this.projector.snapshot(),
      cursor: this.journal.cursor,
    };
  }

  // ---- Pi 事件入口（由 index.ts 转发） ----

  onAgentStart(): void {
    this.isStreaming = true;
    this.flushStreamUpdate();
    this.journal.append({ type: "agent_state", isStreaming: true });
  }

  onAgentSettled(): void {
    this.isStreaming = false;
    this.flushStreamUpdate();
    this.journal.append({ type: "agent_state", isStreaming: false });
  }

  onMessageStart(message: AgentMessage): void {
    if (message.role === "assistant") {
      // 仅预分配条目 ID；首帧可见内容到达时才发布（见 updateAssistantStream）。
      this.streamingAssistantId = this.projector.beginAssistantStream(message.model);
    }
  }

  onMessageUpdate(message: AgentMessage): void {
    if (message.role === "assistant" && this.streamingAssistantId) {
      const entry = this.projector.updateAssistantStream(
        this.streamingAssistantId,
        message,
      );
      if (entry) this.publishEntries([entry]);
    }
  }

  onMessageEnd(message: AgentMessage): void {
    if (message.role === "assistant") {
      if (this.streamingAssistantId) {
        // 丢弃未发布的中间帧：定稿事件携带完整最终内容。
        this.dropStreamUpdate();
        const entries = this.projector.finalizeAssistantStream(
          this.streamingAssistantId,
          message,
        );
        this.publishEntries(entries);
        this.streamingAssistantId = null;
      } else {
        // 非流式路径（异常恢复等）：整体吸收。
        const entries = this.projector.absorbMessage(message);
        this.publishEntries(entries);
      }
      return;
    }
    if (message.role === "user" || message.role === "toolResult") {
      const entries = this.projector.absorbMessage(message);
      this.publishEntries(entries);
    }
  }

  onToolExecutionStart(toolCallId: string, toolName: string, args: unknown): void {
    const entry = this.projector.toolStarted(toolCallId, toolName, args);
    if (entry) this.publishEntries([entry]);
  }

  onToolExecutionEnd(
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ): void {
    const entry = this.projector.toolFinished(toolCallId, toolName, result, isError);
    if (entry) this.publishEntries([entry]);
  }

  private publishEntries(entries: RemoteEntry[]): void {
    if (entries.length === 0) return;
    const added: RemoteEntry[] = [];
    const updated: RemoteEntry[] = [];
    for (const entry of entries) {
      if (this.projectedIds.has(entry.id)) {
        updated.push(entry);
      } else {
        added.push(entry);
        this.projectedIds.add(entry.id);
      }
    }
    if (added.length > 0) {
      this.journal.append({ type: "entries_added", entries: added });
    }
    for (const entry of updated) {
      if (entry.id === this.streamingAssistantId) {
        // 流式帧进入合并窗口，降低高频全量更新带来的事件风暴与带宽。
        this.scheduleStreamUpdate(entry);
      } else {
        this.journal.append({ type: "entry_updated", entry });
      }
    }
  }

  /** 流式帧进入合并窗口：窗口内新帧覆盖旧帧，到期发布最新一帧。 */
  private scheduleStreamUpdate(entry: RemoteEntry): void {
    if (this.pendingStreamUpdate) clearTimeout(this.pendingStreamUpdate.timer);
    this.pendingStreamUpdate = {
      entry,
      timer: setTimeout(
        () => this.flushStreamUpdate(),
        LIMITS.streamingUpdateCoalesceMs,
      ),
    };
  }

  /** 立即发布挂起的流式帧（如存在）。 */
  private flushStreamUpdate(): void {
    const pending = this.pendingStreamUpdate;
    if (!pending) return;
    this.pendingStreamUpdate = null;
    clearTimeout(pending.timer);
    this.journal.append({ type: "entry_updated", entry: pending.entry });
  }

  /** 丢弃挂起的流式帧（定稿/重建会发布或取代其内容）。 */
  private dropStreamUpdate(): void {
    const pending = this.pendingStreamUpdate;
    if (!pending) return;
    this.pendingStreamUpdate = null;
    clearTimeout(pending.timer);
  }

  // ---- 命令注入（Command Gateway 核心逻辑） ----

  /**
   * 执行远端命令：Session 身份校验、幂等去重、状态校验与 Pi API 调用。
   */
  executeCommand(command: RemoteCommand): CommandResult {
    if (this.seenCommandIds.has(command.id)) {
      return { ok: true, duplicate: true };
    }
    this.rememberCommand(command.id);

    const ctx = this.ctx;
    if (!ctx || !this.sameSession) {
      return { ok: false, code: "unavailable", message: "分享已失效" };
    }

    const idle = ctx.isIdle();

    if (command.type === "abort") {
      if (idle) {
        return { ok: false, code: "not_running", message: "Agent 未在运行" };
      }
      ctx.abort();
      return { ok: true };
    }

    switch (command.type) {
      case "prompt": {
        if (!idle) {
          return { ok: false, code: "agent_running", message: "Agent 运行中，请使用 steer" };
        }
        this.pi.sendUserMessage(command.text);
        return { ok: true };
      }
      case "steer":
      case "follow_up": {
        if (idle) {
          this.pi.sendUserMessage(command.text);
        } else {
          const deliverAs = command.type === "steer" ? "steer" : "followUp";
          this.pi.sendUserMessage(command.text, { deliverAs });
        }
        return { ok: true };
      }
    }
  }

  private rememberCommand(id: string): void {
    this.seenCommandIds.add(id);
    this.recentCommandIds.push(id);
    if (this.recentCommandIds.length > LIMITS.commandDedupCapacity) {
      const evicted = this.recentCommandIds.shift();
      if (evicted !== undefined) this.seenCommandIds.delete(evicted);
    }
  }
}
