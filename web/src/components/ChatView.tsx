/**
 * 聊天主视图：顶部状态栏、消息列表、控制横幅与输入区。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionState, RemoteConnection } from "../app/connection.js";
import { EntryItem } from "./EntryItem.js";
import { Composer } from "./Composer.js";

interface ChatViewProps {
  state: ConnectionState;
  amController: boolean;
  connection: RemoteConnection | null;
  onClear(): Promise<void>;
}

export function ChatView({ state, amController, connection, onClear }: ChatViewProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  const entryCount = state.entries.length;
  useEffect(() => {
    if (!stickToBottom) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entryCount, state.isStreaming, stickToBottom]);

  const onScroll = (): void => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    setStickToBottom(nearBottom);
  };

  const controlBadge = useMemo(() => {
    if (state.controllerDeviceId === undefined) return null;
    if (amController) {
      return <span className="badge badge-controller">我在控制</span>;
    }
    return (
      <span className="badge badge-remote">
        {state.controllerLabel ?? "远端设备"} 控制中
      </span>
    );
  }, [state.controllerDeviceId, state.controllerLabel, amController]);

  const connectionDot =
    state.phase === "connected" ? (
      <span className="dot dot-ok" />
    ) : state.phase === "reconnecting" ? (
      <span className="dot dot-warn" />
    ) : (
      <span className="dot dot-err" />
    );

  if (state.phase === "ended") {
    return (
      <div className="overlay-center">
        <div className="card">
          <h2>分享已结束</h2>
          <p>本机已停止分享，或 Session 已切换。连接凭证已自动清除。</p>
          <button className="btn btn-primary" onClick={() => void onClear()}>
            返回首页
          </button>
        </div>
      </div>
    );
  }

  if (state.phase === "invalid") {
    return (
      <div className="overlay-center">
        <div className="card">
          <h2>凭证已失效</h2>
          <p>此分享可能已停止或令牌已被撤销。请向本机用户获取新的分享链接。</p>
          <button className="btn btn-primary" onClick={() => void onClear()}>
            返回首页
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="chat">
      <header className="chat-header">
        <div className="chat-header-main">
          <div className="chat-title">
            {state.session?.name || state.session?.cwdLabel || "Pi 会话"}
          </div>
          <div className="chat-sub">
            {connectionDot}
            <span>
              {state.session?.cwdLabel ? `${state.session.cwdLabel} · ` : ""}
              {state.phase === "reconnecting" ? "连接中断，正在重连…" : "已连接"}
              {state.isStreaming ? " · Agent 运行中" : ""}
            </span>
          </div>
        </div>
        <div className="chat-header-badges">{controlBadge}</div>
      </header>

      {state.phase === "reconnecting" && (
        <div className="banner banner-warn">
          连接中断，画面保留但不可发送命令；恢复后自动同步。
        </div>
      )}
      {state.phase === "error" && (
        <div className="banner banner-err">连接出错：{state.errorMessage ?? "未知错误"}</div>
      )}
      {!amController && state.controllerDeviceId === undefined && (
        <div className="banner banner-info">
          只读模式 · 你正在观察本机当前会话
        </div>
      )}
      {!amController && state.controllerDeviceId !== undefined && (
        <div className="banner banner-info">
          「{state.controllerLabel ?? "其他设备"}」正在控制 · 你以只读观察
        </div>
      )}

      <div className="message-list" ref={listRef} onScroll={onScroll}>
        {state.entries.map((entry) => (
          <EntryItem key={entry.id} entry={entry} />
        ))}
        {state.entries.length === 0 && (
          <div className="empty-hint">暂无消息，等待会话内容同步…</div>
        )}
      </div>

      <Composer
        state={state}
        amController={amController}
        connection={connection}
      />
    </div>
  );
}
