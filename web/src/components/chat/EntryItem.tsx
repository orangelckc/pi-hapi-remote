/**
 * 会话条目渲染：用户气泡 / 助手卡片（含思考面板）/ 系统提示。
 * 工具调用与纯思考条目由 ActivityGroup 分组渲染（见 presentation.ts）；
 * 原始字段回退到 metadata.entry。
 */
import { memo, useEffect, useState } from "react";
import { AlertTriangle, Brain, ChevronDown, ChevronRight, Info, Loader2, Sparkles } from "lucide-react";
import type { AssistantMessageEntry, UserMessageEntry } from "../../protocol.js";
import type { RemoteUIMessage } from "../../chat/ui-messages.js";
import { messageText } from "../../chat/presentation.js";
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

/** 思考面板：流式阶段自动展开，正文出现后自动折叠；用户手动切换优先。
 * live=false（所在活动组已完成）时始终呈现完成态。 */
export function ThinkingPanel({
  entry,
  live,
}: {
  entry: AssistantMessageEntry;
  live?: boolean;
}): JSX.Element {
  const [userToggled, setUserToggled] = useState(false);
  const streaming = live === false ? false : !entry.text && entry.error === undefined;
  const [expanded, setExpanded] = useState(streaming);

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

/** 用户气泡：技能 / 文件引用小标签 + 可见文本（信封已在服务端剥离）。 */
function UserBubble({ message }: { message: RemoteUIMessage }): JSX.Element {
  const entry = message.metadata.entry as UserMessageEntry;
  const hasBody = Boolean(messageText(message).trim());
  return (
    <div className="fade-in-up flex justify-end">
      <div className="max-w-[85%] rounded-xl rounded-br-sm bg-primary px-3 py-2 text-primary-foreground shadow-sm">
        {entry.skillName && (
          <div className="mb-1 inline-flex max-w-full items-center gap-1 rounded-full bg-black/20 px-2 py-0.5 text-[11px]">
            <Sparkles className="size-3 shrink-0" />
            <span className="truncate">{entry.skillName}</span>
          </div>
        )}
        {entry.contextFiles && entry.contextFiles.length > 0 && (
          <div className="mb-1 flex flex-wrap justify-end gap-1">
            {entry.contextFiles.map((ref) => (
              <span
                key={ref}
                className="max-w-[12rem] truncate rounded-full bg-black/20 px-2 py-0.5 font-mono text-[11px]"
                title={ref}
              >
                {ref}
              </span>
            ))}
          </div>
        )}
        {hasBody && (
          <div className="whitespace-pre-wrap break-words text-[14.5px] leading-relaxed">
            {messageText(message)}
          </div>
        )}
        <div className="mt-0.5 text-right text-[10px] text-primary-foreground/60">
          {formatTime(entry.timestamp)}
        </div>
      </div>
    </div>
  );
}

/** 助手消息卡片：思考面板 + 正文 + 错误信息；结论消息边框强调。 */
function AssistantMessage({
  message,
  conclusion,
}: {
  message: RemoteUIMessage;
  conclusion: boolean;
}): JSX.Element {
  const entry = message.metadata.entry as AssistantMessageEntry;
  const hasText = message.parts.some((p) => p.type === "text" && p.text);
  const streaming = !hasText && entry.error === undefined && !entry.thinking;

  return (
    <div className="fade-in-up flex justify-start">
      <div
        className={cn(
          "w-full max-w-[92%] rounded-xl rounded-bl-sm border bg-card px-3 py-2 shadow-sm sm:max-w-[80%]",
          conclusion ? "border-primary/40" : "border-border/60",
        )}
      >
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
  conclusion,
}: {
  message: RemoteUIMessage;
  conclusion?: boolean;
}): JSX.Element | null {
  const entry = message.metadata?.entry;
  // 防御：无 metadata 的消息（如外部注入）降级为纯文本气泡，
  // 避免渲染抛错导致整树卸载。
  if (!entry) {
    const text = messageText(message);
    return (
      <div className="fade-in-up flex justify-end">
        <div className="max-w-[85%] rounded-xl rounded-br-sm bg-primary px-3 py-2 text-primary-foreground shadow-sm">
          <div className="whitespace-pre-wrap break-words text-[14.5px] leading-relaxed">
            {text}
          </div>
        </div>
      </div>
    );
  }
  switch (entry.kind) {
    case "user_message":
      return <UserBubble message={message} />;
    case "assistant_message":
      return <AssistantMessage message={message} conclusion={conclusion === true} />;
    case "notice":
      return <NoticeMessage message={message} />;
    default:
      // tool_call 已由 ActivityGroup 分组渲染，此处仅为类型完备性兑底。
      return null;
  }
});
