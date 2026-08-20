/**
 * 消息列表：呈现层分组渲染（活动组折叠 + 轮次耗时/diff 摘要）+
 * 粘性滚动（stick-to-bottom）+ 悬浮"回到底部"按钮（附带新消息计数）。
 */
import { Fragment, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import type { RemoteUIMessage } from "../../chat/ui-messages.js";
import { presentMessages, type TurnTiming } from "../../chat/presentation.js";
import { cn } from "../../lib/utils.js";
import { EntryItem } from "./EntryItem.js";
import { ActivityGroup, TurnDiffCard, TurnDuration } from "./ActivityGroup.js";

interface MessageListProps {
  messages: RemoteUIMessage[];
  isStreaming: boolean;
}

const NEAR_BOTTOM_PX = 120;

export function MessageList({ messages, isStreaming }: MessageListProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  const lastCountRef = useRef(0);
  // 运行中轮次计时：基准跨度来自服务端时钟，推进量来自本地时钟差值
  // （差值不受手机与主机的时钟偏移影响），每秒 tick 重绘。
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const runningBaseRef = useRef<{ key: string; span: number; startedAt: number } | null>(null);

  useEffect(() => {
    if (!isStreaming) return;
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [isStreaming]);

  const presentation = useMemo(
    () => presentMessages(messages, isStreaming),
    [messages, isStreaming],
  );

  /** 运行中轮次的展示计时：服务端已知跨度 + 本地已推进秒数（轮以起始时间戳标识）。 */
  const displayTiming = (timing: TurnTiming): TurnTiming => {
    if (!timing.running) return timing;
    const key = String(timing.startAt);
    let base = runningBaseRef.current;
    if (!base || base.key !== key) {
      base = {
        key,
        span: Math.max(0, timing.endAt - timing.startAt),
        startedAt: Date.now(),
      };
      runningBaseRef.current = base;
    }
    const elapsed = Math.floor((Date.now() - base.startedAt) / 1_000);
    return { ...timing, endAt: timing.startAt + base.span + elapsed * 1_000 };
  };

  const scrollToBottom = (smooth = false): void => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  useEffect(() => {
    if (!stickToBottom) {
      // 不在底部时累计新消息（含流式更新帧，按条目数近似）。
      setUnread(Math.max(0, messages.length - lastCountRef.current));
    }
    lastCountRef.current = messages.length;
    if (stickToBottom) scrollToBottom();
  }, [messages, isStreaming, stickToBottom]);

  const onScroll = (): void => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    setStickToBottom(nearBottom);
    if (nearBottom) setUnread(0);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={listRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto overscroll-contain px-3 py-4 sm:px-6"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-2.5">
          {presentation.items.map((item) => (
            <Fragment key={item.key}>
              {item.kind === "activity" ? (
                <ActivityGroup item={item} />
              ) : (
                <EntryItem
                  message={item.message}
                  conclusion={presentation.conclusionKeys.has(item.key)}
                />
              )}
              {presentation.turnTimings.has(item.key) && (
                <TurnDuration timing={displayTiming(presentation.turnTimings.get(item.key)!)} />
              )}
              {presentation.turnDiffs.has(item.key) && (
                <TurnDiffCard
                  summary={presentation.turnDiffs.get(item.key)!}
                  running={presentation.turnTimings.get(item.key)?.running ?? false}
                />
              )}
            </Fragment>
          ))}
          {presentation.items.length === 0 && (
            <div className="mt-16 text-center text-[13px] text-muted-foreground">
              暂无消息，等待会话内容同步…
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        aria-label="回到底部"
        className={cn(
          "absolute bottom-4 left-1/2 -translate-x-1/2 transition-all duration-200",
          stickToBottom
            ? "pointer-events-none translate-y-3 opacity-0"
            : "opacity-100",
        )}
        onClick={() => {
          setStickToBottom(true);
          setUnread(0);
          scrollToBottom(true);
        }}
      >
        <span className="relative flex size-9 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-lg shadow-black/20 active:bg-accent">
          <ArrowDown className="size-4" />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </span>
      </button>
    </div>
  );
}
