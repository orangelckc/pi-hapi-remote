/**
 * 活动组渲染：连续工具调用与思考过程的折叠组 + 轮次 diff 摘要与耗时
 * （呈现方式对齐参考 webview 的 activity-group / activity-timeline）。
 *
 * 折叠语义：运行中默认展开，running → 完成的瞬间自动折叠一次，
 * 用户手动切换始终优先（见 presentation.ts 的 activityGroupOpen 说明）。
 */
import { memo, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileDiff,
  Loader2,
  X,
} from "lucide-react";
import type { ToolCallEntry } from "../../protocol.js";
import {
  calculateDiffStats,
  formatTurnDuration,
  friendlyToolName,
  toolTargetLabel,
  type ActivitySummary,
  type RenderItem,
  type TurnTiming,
} from "../../chat/presentation.js";
import { cn } from "../../lib/utils.js";
import { ThinkingPanel } from "./EntryItem.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible.js";

export type ActivityItem = Extract<RenderItem, { kind: "activity" }>;

const MAX_DIFF_LINES = 400;

function formatDuration(entry: ToolCallEntry): string | null {
  if (entry.completedAt === undefined) return null;
  const seconds = Math.max(1, Math.round((entry.completedAt - entry.timestamp) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

/** 单个工具耗时行。 */
export function TurnDuration({ timing }: { timing: TurnTiming }): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
      <Clock3 className="size-3" />
      <span>{formatTurnDuration(timing)}</span>
    </div>
  );
}

/** unified diff 行级着色展示（客户端只分类着色，不重算 diff）。 */
function DiffBlock({ diff }: { diff: string }): JSX.Element {
  const lines = diff.replace(/\n$/, "").split("\n");
  const truncated = lines.length > MAX_DIFF_LINES;
  const shown = truncated ? lines.slice(0, MAX_DIFF_LINES) : lines;
  return (
    <div className="overflow-x-auto rounded-lg bg-muted/70 py-1 font-mono text-xs">
      {shown.map((line, i) => {
        const marker = line.charAt(0);
        return (
          <div
            key={i}
            className={cn(
              "whitespace-pre px-2 leading-5",
              marker === "+" && "bg-ok/10 text-ok",
              marker === "-" && "bg-danger/10 text-danger",
              marker !== "+" && marker !== "-" && "text-muted-foreground",
            )}
          >
            {line || " "}
          </div>
        );
      })}
      {truncated && (
        <div className="px-2 py-0.5 text-muted-foreground">
          … 还有 {lines.length - MAX_DIFF_LINES} 行
        </div>
      )}
    </div>
  );
}

/** 工具时间线细行：状态 + 友好名 + 目标 + diff 统计，展开显示参数 / 结果 / diff。 */
function ToolRow({ entry }: { entry: ToolCallEntry }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const diffStats = entry.diff ? calculateDiffStats(entry.diff) : null;
  const elapsed = formatDuration(entry);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="overflow-hidden rounded-lg border border-border/50 bg-background/40">
        <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/40">
          {entry.status === "running" ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
          ) : entry.status === "error" ? (
            <X className="size-3.5 shrink-0 text-danger" />
          ) : (
            <Check className="size-3.5 shrink-0 text-ok" />
          )}
          <span className="shrink-0 font-medium text-foreground/90">
            {friendlyToolName(entry.toolName)}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {toolTargetLabel(entry)}
          </span>
          {diffStats && (
            <span className="flex shrink-0 items-center gap-1 font-mono text-[11px]">
              <span className="text-ok">+{diffStats.added}</span>
              <span className="text-danger">-{diffStats.removed}</span>
            </span>
          )}
          {elapsed && (
            <span className="shrink-0 text-[11px] text-muted-foreground">{elapsed}</span>
          )}
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 border-t border-border/50 px-2.5 py-2">
            {entry.argsPreview && (
              <pre className="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/70 p-2 font-mono text-xs">
                {entry.argsPreview}
              </pre>
            )}
            {entry.diff ? (
              <DiffBlock diff={entry.diff} />
            ) : (
              entry.resultText !== undefined && (
                <pre
                  className={cn(
                    "max-h-[30vh] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/70 p-2 font-mono text-xs",
                    entry.status === "error" && "text-danger",
                  )}
                >
                  {entry.resultText}
                  {entry.resultTruncated && (
                    <span className="mt-1.5 block text-[11px] text-muted-foreground">
                      （结果过长已截断）
                    </span>
                  )}
                </pre>
              )
            )}
            {entry.status === "running" && !entry.resultText && !entry.diff && (
              <div className="text-xs text-muted-foreground">执行中…</div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/** 轮次 diff 摘要卡：运行中"正在编辑"，完成后列出文件与增删统计。 */
export function TurnDiffCard({
  summary,
  running,
}: {
  summary: ActivitySummary;
  running: boolean;
}): JSX.Element | null {
  const [showAll, setShowAll] = useState(false);
  if (summary.fileCount === 0 || (summary.added === 0 && summary.removed === 0)) {
    return null;
  }
  if (running) {
    return (
      <div
        role="status"
        className="flex items-center justify-center gap-2 rounded-xl border border-border/70 bg-card/60 px-3 py-2 text-[13px]"
      >
        <Loader2 className="size-3.5 animate-spin text-primary" />
        <span>正在编辑 {summary.fileCount} 个文件</span>
        <span className="flex items-center gap-1 font-mono text-[12px]">
          <span className="text-ok">+{summary.added}</span>
          <span className="text-danger">-{summary.removed}</span>
        </span>
      </div>
    );
  }
  const visible = showAll ? summary.files : summary.files.slice(0, 3);
  const remaining = summary.files.length - visible.length;
  return (
    <section className="overflow-hidden rounded-xl border border-border/70 bg-card/60">
      <header className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-[13px]">
        <FileDiff className="size-4 shrink-0 text-primary" />
        <span className="font-medium">已编辑 {summary.fileCount} 个文件</span>
        <span className="ml-auto flex items-center gap-1 font-mono text-[12px]">
          <span className="text-ok">+{summary.added}</span>
          <span className="text-danger">-{summary.removed}</span>
        </span>
      </header>
      <div className="divide-y divide-border/40">
        {visible.map((file) => (
          <div
            key={file.path}
            className="flex items-center gap-2 px-3 py-1.5 text-xs"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
              {file.path}
            </span>
            <span className="flex shrink-0 items-center gap-1 font-mono">
              <span className="text-ok">+{file.added}</span>
              <span className="text-danger">-{file.removed}</span>
            </span>
          </div>
        ))}
        {remaining > 0 && (
          <button
            type="button"
            className="flex min-h-9 w-full items-center justify-center gap-1 px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "收起文件" : `再显示 ${remaining} 个文件`}
            {showAll ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        )}
      </div>
    </section>
  );
}

/** 活动组：思考面板 + 工具时间线的折叠容器。 */
export const ActivityGroup = memo(function ActivityGroup({
  item,
}: {
  item: ActivityItem;
}): JSX.Element {
  const { tools, thinking, status } = item;
  const [open, setOpen] = useState(status === "running");
  const prevStatusRef = useRef(status);

  useEffect(() => {
    // running → 完成/出错的瞬间自动折叠一次；用户手动切换不受影响。
    if (prevStatusRef.current === "running" && status !== "running") {
      setOpen(false);
    }
    prevStatusRef.current = status;
  }, [status]);

  const errorCount = tools.filter((t) => t.status === "error").length;
  const label =
    tools.length === 0
      ? status === "running"
        ? "正在推理"
        : "推理过程"
      : status === "running"
        ? `正在执行 ${tools.length} 项操作`
        : `已完成 ${tools.length} 项操作`;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "fade-in-up overflow-hidden rounded-xl border bg-card/60 transition-colors",
          status === "error" ? "border-danger/30" : "border-border/70",
        )}
      >
        <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent/40">
          {status === "running" ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
          ) : status === "error" ? (
            <X className="size-4 shrink-0 text-danger" />
          ) : (
            <Check className="size-4 shrink-0 text-ok" />
          )}
          <span className={cn("font-medium", status === "running" && "text-primary")}>
            {label}
          </span>
          {errorCount > 0 && (
            <span className="text-[11px] text-danger">失败 {errorCount}</span>
          )}
          {open ? (
            <ChevronDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-1.5 border-t border-border/60 px-2.5 py-2">
            {thinking.map((entry) => (
              <ThinkingPanel key={entry.id} entry={entry} live={status === "running"} />
            ))}
            {tools.map((entry) => (
              <ToolRow key={entry.id} entry={entry} />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
});
