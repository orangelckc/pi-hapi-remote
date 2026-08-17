/**
 * 会话条目渲染：消费 AI SDK UIMessage parts（text / reasoning /
 * dynamic-tool / data-*），原始字段回退到 metadata.entry。
 */
import { memo, useEffect, useState } from "react";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Info,
  Loader2,
  X,
} from "lucide-react";
import type { AssistantMessageEntry, ToolCallEntry } from "../../protocol.js";
import type { RemoteUIMessage } from "../../chat/ui-messages.js";
import { cn } from "../../lib/utils.js";
import { Markdown } from "./Markdown.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible.js";

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 思考面板：流式阶段自动展开，正文出现后自动折叠；用户手动切换优先。 */
function ThinkingPanel({ entry }: { entry: AssistantMessageEntry }): JSX.Element {
  const [userToggled, setUserToggled] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const streaming = !entry.text && entry.error === undefined;

  useEffect(() => {
    if (!userToggled) setExpanded(streaming);
  }, [streaming, userToggled]);

  const hidden = entry.thinkingRedacted === true && !entry.thinking;
  const chars = entry.thinking?.length ?? 0;

  return (
    <Collapsible open={expanded} onOpenChange={(v) => { setUserToggled(true); setExpanded(v); }}>
      <div className="mb-2 overflow-hidden rounded-lg border border-dashed border-border">
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
          {streaming ? (
            <Loader2 className="size-3.5 animate-spin text-primary" />
          ) : (
            <Brain className="size-3.5" />
          )}
          <span className={cn("font-medium", streaming && "text-primary")}>
            {streaming ? "思考中…" : "思考过程"}
          </span>
          {chars > 0 && <span className="text-[10px] opacity-70">{chars} 字</span>}
          {entry.thinkingRedacted === true && (
            <span className="rounded-full bg-warn/15 px-1.5 py-px text-[10px] text-warn">
              部分被安全过滤
            </span>
          )}
          <span className="ml-auto">
            {expanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words px-2.5 pb-2.5 text-[12.5px] italic text-muted-foreground">
            {hidden ? "（思考内容已被提供商安全过滤，不可见）" : entry.thinking}
            {entry.thinkingTruncated && (
              <span className="mt-1 block text-[11px] opacity-70">
                （思考过程过长已截断）
              </span>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function duration(entry: ToolCallEntry): string | null {
  if (entry.completedAt === undefined) return null;
  const seconds = Math.max(1, Math.round((entry.completedAt - entry.timestamp) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

/** 工具调用卡片：状态图标 + 名称 + 参数预览，展开后显示参数与结果。 */
function ToolCallCard({ entry }: { entry: ToolCallEntry }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const resultLines = (entry.resultText ?? "").split("\n").length;
  const elapsed = duration(entry);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div
        className={cn(
          "overflow-hidden rounded-xl border bg-card/60 transition-colors",
          entry.status === "error" ? "border-danger/30" : "border-border/70",
        )}
      >
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-accent/40">
          {entry.status === "running" ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
          ) : entry.status === "error" ? (
            <X className="size-4 shrink-0 text-danger" />
          ) : (
            <Check className="size-4 shrink-0 text-ok" />
          )}
          <span className="shrink-0 font-mono font-semibold text-primary">
            {entry.toolName}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {entry.argsPreview.split("\n")[0]?.slice(0, 80) || ""}
          </span>
          {elapsed && (
            <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground">
              <Clock3 className="size-3" />
              {elapsed}
            </span>
          )}
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border/60 px-3 py-2.5">
            {entry.argsPreview && (
              <pre className="mb-2 max-h-[40vh] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/70 p-2.5 font-mono text-xs">
                {entry.argsPreview}
              </pre>
            )}
            {entry.resultText !== undefined ? (
              <pre
                className={cn(
                  "max-h-[40vh] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/70 p-2.5 font-mono text-xs",
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
            ) : (
              entry.status === "running" && (
                <div className="text-xs text-muted-foreground">执行中…</div>
              )
            )}
          </div>
        </CollapsibleContent>
        {!expanded && entry.resultText !== undefined && (
          <div className="px-3 pb-2 text-[11px] text-muted-foreground">
            {entry.status === "error" ? "执行出错" : `完成 · ${resultLines} 行结果`}
          </div>
        )}
      </div>
    </Collapsible>
  );
}

function UserBubble({ message }: { message: RemoteUIMessage }): JSX.Element {
  const text = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
  return (
    <div className="fade-in-up flex justify-end">
      <div className="max-w-[85%] rounded-xl rounded-br-sm bg-primary px-3 py-2 text-primary-foreground shadow-sm">
        <div className="whitespace-pre-wrap break-words text-[14.5px] leading-relaxed">
          {text}
        </div>
        <div className="mt-0.5 text-right text-[10px] text-primary-foreground/60">
          {formatTime(message.metadata.entry.timestamp)}
        </div>
      </div>
    </div>
  );
}

function AssistantMessage({ message }: { message: RemoteUIMessage }): JSX.Element {
  const entry = message.metadata.entry as AssistantMessageEntry;
  const hasText = message.parts.some((p) => p.type === "text" && p.text);
  const streaming = !hasText && entry.error === undefined && !entry.thinking;

  return (
    <div className="fade-in-up flex justify-start">
      <div className="w-full max-w-[92%] rounded-xl rounded-bl-sm border border-border/60 bg-card px-3 py-2 shadow-sm sm:max-w-[80%]">
        {(entry.thinking !== undefined || entry.thinkingRedacted === true) && (
          <ThinkingPanel entry={entry} />
        )}
        {message.parts.map((part, i) => {
          if (part.type === "text" && part.text) {
            return <Markdown key={i} text={part.text} />;
          }
          if (part.type === "text" && streaming) {
            return (
              <span
                key={i}
                className="caret-blink mt-1 inline-block h-4 w-[2px] bg-primary align-text-bottom"
              />
            );
          }
          if (part.type === "data-error") {
            return (
              <div
                key={i}
                className="mt-2 flex items-start gap-2 rounded-lg bg-danger/10 px-2.5 py-2 text-[12.5px] text-danger"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 whitespace-pre-wrap break-words">
                  {part.data.message}
                </span>
              </div>
            );
          }
          return null;
        })}
        <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
          {entry.modelLabel && <span>{entry.modelLabel}</span>}
          <span className={cn(!entry.modelLabel && "ml-auto")}>
            {formatTime(entry.timestamp)}
          </span>
        </div>
      </div>
    </div>
  );
}

function ToolMessage({ message }: { message: RemoteUIMessage }): JSX.Element {
  return (
    <div className="fade-in-up">
      <ToolCallCard entry={message.metadata.entry as ToolCallEntry} />
    </div>
  );
}

function NoticeMessage({ message }: { message: RemoteUIMessage }): JSX.Element {
  const text = message.parts
    .filter((p) => p.type === "data-notice")
    .map((p) => (p as { data: { text: string } }).data.text)
    .join("");
  return (
    <div className="flex items-center justify-center gap-1.5 px-6 py-1 text-center text-xs text-muted-foreground">
      <Info className="size-3 shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}

export const EntryItem = memo(function EntryItem({
  message,
}: {
  message: RemoteUIMessage;
}): JSX.Element {
  switch (message.metadata.entry.kind) {
    case "user_message":
      return <UserBubble message={message} />;
    case "assistant_message":
      return <AssistantMessage message={message} />;
    case "tool_call":
      return <ToolMessage message={message} />;
    case "notice":
      return <NoticeMessage message={message} />;
  }
});
