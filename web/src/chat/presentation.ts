/**
 * 呈现层纯函数：把派生后的 UIMessage 列表重组为可渲染的分组结构，
 * 并计算活动组折叠语义、轮次 diff 汇总、轮次耗时与结论标记。
 *
 * 处理方式移植自 pi-agent-extension webview 的
 * activityModel / transcriptPresentation / turnTiming，适配 RemoteEntry 条目流：
 * 连续的 tool_call 与纯思考 assistant 条目合并为一个活动组，
 * 组运行中展开、完成后自动折叠、用户手动切换优先。
 */
import type { AssistantMessageEntry, ToolCallEntry } from "../protocol.js";
import type { RemoteUIMessage } from "./ui-messages.js";

export type ActivityStatus = "running" | "success" | "error";

export interface DiffStats {
  added: number;
  removed: number;
}

export interface ActivityFileSummary extends DiffStats {
  path: string;
}

export interface ActivitySummary extends DiffStats {
  toolCount: number;
  fileCount: number;
  files: ActivityFileSummary[];
  errorCount: number;
  status: ActivityStatus;
}

export interface TurnTiming {
  startAt: number;
  endAt: number;
  running: boolean;
}

/** 活动组折叠的既有状态（组件层按组 key 记忆）。 */
export interface PreviousActivityState {
  status: ActivityStatus;
  open: boolean;
}

export type RenderItem =
  | { kind: "user" | "notice"; key: string; message: RemoteUIMessage }
  | { kind: "assistant"; key: string; message: RemoteUIMessage }
  | {
      kind: "activity";
      key: string;
      /** 组内纯思考的助手条目（无正文、无错误），渲染为思考面板。 */
      thinking: AssistantMessageEntry[];
      tools: ToolCallEntry[];
      status: ActivityStatus;
    };

export interface MessagePresentation {
  items: RenderItem[];
  /** 轮次耗时，挂在每轮最后一个助手项（消息或活动组）上。 */
  turnTimings: Map<string, TurnTiming>;
  /** 每轮最后一个含正文助手消息的 key，赋予结论强调样式。 */
  conclusionKeys: Set<string>;
  /** 轮次 diff 汇总，挂在每轮最后一个助手项上。 */
  turnDiffs: Map<string, ActivitySummary>;
}

/** 条目纯文本（text parts 拼接）。 */
export function messageText(message: RemoteUIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** 该助手条目是否为"纯思考"：无正文且无错误（可归入活动组）。 */
function isThinkingOnly(entry: AssistantMessageEntry): boolean {
  return !entry.text && entry.error === undefined;
}

/**
 * 分组：连续的 tool_call 与纯思考 assistant 条目合并为活动组；
 * user / notice / 含正文（或错误）的 assistant 关闭当前组并独立成项。
 */
export function groupRenderItems(
  messages: RemoteUIMessage[],
  isStreaming: boolean,
): RenderItem[] {
  const items: RenderItem[] = [];
  let pending: {
    thinking: AssistantMessageEntry[];
    tools: ToolCallEntry[];
  } | null = null;

  const flush = (tail: boolean): void => {
    if (!pending) return;
    const status = activityStatusOf(pending.tools, tail && isStreaming);
    items.push({
      kind: "activity",
      key: `activity:${pending.tools[0]?.id ?? pending.thinking[0]?.id ?? ""}`,
      thinking: pending.thinking,
      tools: pending.tools,
      status,
    });
    pending = null;
  };

  for (const message of messages) {
    const entry = message.metadata?.entry;
    if (!entry) continue;
    switch (entry.kind) {
      case "tool_call":
        pending ??= { thinking: [], tools: [] };
        pending.tools.push(entry);
        break;
      case "assistant_message":
        if (isThinkingOnly(entry)) {
          pending ??= { thinking: [], tools: [] };
          pending.thinking.push(entry);
          break;
        }
        flush(false);
        items.push({ kind: "assistant", key: message.id, message });
        break;
      default:
        flush(false);
        items.push({
          kind: entry.kind === "user_message" ? "user" : "notice",
          key: message.id,
          message,
        });
    }
  }
  flush(true);
  return items;
}

function activityStatusOf(
  tools: ToolCallEntry[],
  thinkingStreaming: boolean,
): ActivityStatus {
  if (tools.length === 0) return thinkingStreaming ? "running" : "success";
  if (tools.some((t) => t.status === "error")) return "error";
  if (tools.some((t) => t.status === "running")) return "running";
  return "success";
}

/**
 * 活动组默认开合：首次渲染运行中展开、其余折叠；
 * running → 完成/出错的瞬间自动折叠一次；此后保留用户手动选择。
 */
export function activityGroupOpen(
  previous: PreviousActivityState | undefined,
  status: ActivityStatus,
): boolean {
  if (!previous) return status === "running";
  if (previous.status === "running" && status !== "running") return false;
  return previous.open;
}

/** 解析 unified diff 行的增删统计（跳过 +++/--- 文件头）。 */
export function calculateDiffStats(diff: string): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/** 汇总一轮工具活动：增删行数、按目标文件聚合与错误计数。 */
export function summarizeActivity(tools: ToolCallEntry[]): ActivitySummary {
  const files = new Map<string, DiffStats>();
  let added = 0;
  let removed = 0;
  let errorCount = 0;
  let status: ActivityStatus = "success";
  for (const entry of tools) {
    const stats = entry.diff ? calculateDiffStats(entry.diff) : { added: 0, removed: 0 };
    added += stats.added;
    removed += stats.removed;
    if (entry.diff && entry.target) {
      const previous = files.get(entry.target) ?? { added: 0, removed: 0 };
      files.set(entry.target, {
        added: previous.added + stats.added,
        removed: previous.removed + stats.removed,
      });
    }
    if (entry.status === "error") {
      errorCount += 1;
      status = "error";
    } else if (entry.status === "running" && status !== "error") {
      status = "running";
    }
  }
  return {
    toolCount: tools.length,
    fileCount: files.size,
    files: [...files].map(([path, stats]) => ({ path, ...stats })),
    added,
    removed,
    errorCount,
    status,
  };
}

/** 每轮耗时：user 时间戳起，末个助手项的完成时间止。
 * 时间戳均为服务端时钟；尾轮运行中的推进由展示层叠加本地相对秒数，
 * 避免手机与主机时钟偏移被计入耗时。 */
export function buildTurnTimings(
  items: RenderItem[],
  isStreaming: boolean,
): Map<string, TurnTiming> {
  const timings = new Map<string, TurnTiming>();
  let startAt: number | undefined;
  let lastKey: string | undefined;
  let endAt: number | undefined;

  const flush = (trailing: boolean): void => {
    if (lastKey === undefined || startAt === undefined) return;
    if (endAt !== undefined && endAt >= startAt) {
      timings.set(lastKey, { startAt, endAt, running: trailing && isStreaming });
    }
  };

  for (const item of items) {
    if (item.kind === "user") {
      flush(false);
      startAt = item.message.metadata.entry.timestamp;
      lastKey = undefined;
      endAt = undefined;
      continue;
    }
    if (item.kind === "notice") continue;
    if (startAt === undefined) continue;
    lastKey = item.key;
    if (item.kind === "activity") {
      for (const tool of item.tools) {
        const t = tool.completedAt ?? tool.timestamp;
        endAt = endAt === undefined ? t : Math.max(endAt, t);
      }
      for (const think of item.thinking) {
        endAt = endAt === undefined ? think.timestamp : Math.max(endAt, think.timestamp);
      }
    } else {
      const entry = item.message.metadata.entry;
      endAt = endAt === undefined ? entry.timestamp : Math.max(endAt, entry.timestamp);
    }
  }
  flush(true);
  return timings;
}

/** 结论标记：每轮最后一个含正文的助手消息；尾轮流式中不落定（避免闪烁）。 */
export function turnConclusionKeys(
  items: RenderItem[],
  isStreaming: boolean,
): Set<string> {
  const keys = new Set<string>();
  let candidate: string | undefined;
  const flush = (): void => {
    if (candidate) keys.add(candidate);
    candidate = undefined;
  };
  for (const item of items) {
    if (item.kind === "user") {
      flush();
      continue;
    }
    if (item.kind !== "assistant") continue;
    const entry = item.message.metadata.entry as AssistantMessageEntry;
    if (entry.error !== undefined) {
      candidate = item.key;
      continue;
    }
    if (!messageText(item.message).trim()) continue;
    candidate = item.key;
  }
  if (!isStreaming) flush();
  return keys;
}

/** 汇总入口：分组 + 轮次计时 + 结论标记 + diff 汇总。 */
export function presentMessages(
  messages: RemoteUIMessage[],
  isStreaming: boolean,
): MessagePresentation {
  const items = groupRenderItems(messages, isStreaming);
  const turnDiffs = new Map<string, ActivitySummary>();
  let tools: ToolCallEntry[] = [];
  let lastKey: string | undefined;
  const flush = (): void => {
    if (lastKey && tools.length > 0) turnDiffs.set(lastKey, summarizeActivity(tools));
    tools = [];
    lastKey = undefined;
  };
  for (const item of items) {
    if (item.kind === "user") {
      flush();
      continue;
    }
    if (item.kind === "notice") continue;
    lastKey = item.key;
    if (item.kind === "activity") tools.push(...item.tools);
  }
  flush();
  return {
    items,
    turnTimings: buildTurnTimings(items, isStreaming),
    conclusionKeys: turnConclusionKeys(items, isStreaming),
    turnDiffs,
  };
}

/** 工具名友好化（对齐参考 webview 的中文标签）。 */
const FRIENDLY_TOOL_NAMES: Record<string, string> = {
  bash: "运行命令",
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  grep: "搜索文本",
  find: "查找文件",
  glob: "查找文件",
  ls: "列出文件",
};

export function friendlyToolName(name: string): string {
  return FRIENDLY_TOOL_NAMES[name] ?? name.replaceAll("_", " ");
}

/** 工具目标展示：target 字段回退到 argsPreview 首行。 */
export function toolTargetLabel(entry: ToolCallEntry): string {
  if (entry.target) return entry.target;
  return entry.argsPreview.split("\n")[0]?.slice(0, 88) ?? "";
}

/** 轮次耗时文案：运行中"已用"，结束"耗时"。 */
export function formatTurnDuration(timing: TurnTiming): string {
  const seconds = Math.max(0, Math.floor((timing.endAt - timing.startAt) / 1_000));
  const label = timing.running ? "已用" : "耗时";
  if (seconds < 60) return `${label} ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${label} ${minutes} 分 ${remainingSeconds} 秒`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${label} ${hours} 小时 ${remainingMinutes} 分 ${remainingSeconds} 秒`;
}
