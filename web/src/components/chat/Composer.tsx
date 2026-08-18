/**
 * 输入区：自动增高、桌面/移动差异化回车行为、虚拟键盘与安全区适配。
 * 全部动作经 RemoteChatView 视图接口，不直接接触连接对象。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ListEnd, Loader2, Send, Square } from "lucide-react";
import type { RemoteChatView } from "../../app/useRemoteChat.js";
import type { RemoteCommandKind } from "../../chat/transport.js";
import { cn } from "../../lib/utils.js";
import { Button } from "../ui/button.js";
import { Textarea } from "../ui/textarea.js";

const MAX_ROWS_PX = 8 * 24;

/** 虚拟键盘弹起时的可视高度差（iOS PWA 下 body 不自动收缩）。 */
function useKeyboardInset(
  targetRef: React.RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const apply = (): void => {
      const inset = Math.max(
        0,
        window.innerHeight - viewport.height - viewport.offsetTop,
      );
      targetRef.current?.style.setProperty("--keyboard-inset", `${inset}px`);
    };
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    apply();
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
    };
  }, [targetRef]);
}

export function Composer({ view }: { view: RemoteChatView }): JSX.Element {
  const { state, amController, sending, sendError, send, abort } = view;
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const footerRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useKeyboardInset(footerRef);

  const offline = state.phase !== "connected";
  const canSend = !offline && !sending && text.trim().length > 0;

  // 自动增高（JS 兜底，兼容不支持 field-sizing 的浏览器）。
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, [text]);

  const doSend = (kind: RemoteCommandKind): void => {
    if (!canSend) return;
    setError(null);
    send(text.trim(), kind);
    setText("");
  };

  const doAbort = async (): Promise<void> => {
    setError(null);
    try {
      abort();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    }
  };

  if (!amController) {
    return (
      <footer
        ref={footerRef}
        className="flex shrink-0 flex-col gap-2.5 border-t border-border/70 bg-background/85 px-4 pt-2.5 backdrop-blur-md"
        style={{ paddingBottom: "calc(0.625rem + max(env(safe-area-inset-bottom,0px), var(--keyboard-inset, 0px)))" }}
      >
        <p className="text-center text-xs text-muted-foreground">
          只读观察 · 无法发送消息或申请控制权
        </p>
      </footer>
    );
  }

  const streaming = state.isStreaming;

  return (
    <footer
      ref={footerRef}
      className="flex shrink-0 flex-col gap-2 border-t border-border/70 bg-background/85 px-4 pt-2.5 backdrop-blur-md"
      style={{ paddingBottom: "calc(0.625rem + max(env(safe-area-inset-bottom,0px), var(--keyboard-inset, 0px)))" }}
    >
      {error && <p className="text-xs text-danger">{error}</p>}
      {sendError && !error && <p className="text-xs text-danger">{sendError}</p>}
      <div className="mx-auto w-full max-w-3xl">
        <Textarea
          ref={textareaRef}
          rows={1}
          className="resize-none"
          placeholder={
            streaming
              ? "Agent 运行中… 输入内容将作为引导（Steer）"
              : "输入消息发送给 Pi…"
          }
          value={text}
          disabled={offline}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey) return;
            // 精确指针设备（桌面）：Enter 发送；触屏设备 Enter 换行。
            // Cmd/Ctrl+Enter 任何设备都发送。
            if (e.metaKey || e.ctrlKey || window.matchMedia("(pointer: fine)").matches) {
              e.preventDefault();
              doSend(streaming ? "steer" : "prompt");
            }
          }}
        />
        <div className="mt-2 flex items-center gap-2">
          <div className="flex flex-1 items-center gap-2">
            {streaming && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={offline || sending || !text.trim()}
                  onClick={() => doSend("follow_up")}
                >
                  <ListEnd className="size-3.5" />
                  完成后执行
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={offline || sending}
                  onClick={() => void doAbort()}
                >
                  <Square className="size-3" />
                  停止
                </Button>
              </>
            )}
          </div>
          <Button
            size="sm"
            className={cn("min-w-20", !streaming && "px-5")}
            disabled={!canSend}
            onClick={() => doSend(streaming ? "steer" : "prompt")}
          >
            {sending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            {sending ? "发送中" : streaming ? "立即引导" : "发送"}
          </Button>
        </div>
        {offline && (
          <p className="mt-1.5 text-xs text-warn">连接中断，命令发送已禁用。</p>
        )}
      </div>
    </footer>
  );
}
