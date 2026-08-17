/**
 * 输入区：控制权申请、Prompt / Steer / Follow-up / Abort。
 * 运行状态决定主按钮行为：空闲=发送，运行中=立即引导。
 */
import { useState } from "react";
import type { ConnectionState, RemoteConnection } from "../app/connection.js";

interface ComposerProps {
  state: ConnectionState;
  amController: boolean;
  connection: RemoteConnection | null;
}

type RequestPhase = "idle" | "waiting" | "denied";

export function Composer({ state, amController, connection }: ComposerProps): JSX.Element {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestPhase, setRequestPhase] = useState<RequestPhase>("idle");

  const offline =
    state.phase !== "connected" || connection === null;

  const send = async (type: "prompt" | "steer" | "follow_up"): Promise<void> => {
    if (!connection || !text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await connection.sendCommand({
        id: crypto.randomUUID(),
        type,
        text,
      });
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送失败");
    } finally {
      setSending(false);
    }
  };

  const abort = async (): Promise<void> => {
    if (!connection || sending) return;
    setSending(true);
    setError(null);
    try {
      await connection.sendCommand({ id: crypto.randomUUID(), type: "abort" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setSending(false);
    }
  };

  const requestControl = async (): Promise<void> => {
    if (!connection) return;
    setRequestPhase("waiting");
    setError(null);
    try {
      const result = await connection.requestControl();
      setRequestPhase(result === "approved" ? "idle" : "denied");
    } catch (err) {
      setRequestPhase("denied");
      setError(err instanceof Error ? err.message : "申请失败");
    }
  };

  if (!amController) {
    return (
      <footer className="composer composer-readonly">
        {requestPhase === "denied" ? (
          <div className="composer-note composer-note-error">
            本机未批准控制申请（或已超时）。你可以继续只读观察。
          </div>
        ) : requestPhase === "waiting" ? (
          <div className="composer-note">等待本机用户审批…（最长 60 秒）</div>
        ) : (
          <div className="composer-note">只读模式 · 无法发送消息</div>
        )}
        <button
          type="button"
          className="btn btn-secondary"
          disabled={offline || requestPhase === "waiting"}
          onClick={() => void requestControl()}
        >
          申请控制权
        </button>
      </footer>
    );
  }

  const primaryAction = state.isStreaming ? "立即引导" : "发送";
  const primaryType = state.isStreaming ? "steer" : "prompt";

  return (
    <footer className="composer">
      {error && <div className="composer-error">{error}</div>}
      <div className="composer-input-row">
        <textarea
          className="composer-input"
          rows={Math.min(5, Math.max(1, text.split("\n").length))}
          placeholder={
            state.isStreaming
              ? "Agent 运行中… 输入内容将作为引导（Steer）"
              : "输入消息发送给 Pi…"
          }
          value={text}
          disabled={offline}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send(primaryType);
            }
          }}
        />
      </div>
      <div className="composer-actions">
        <div className="composer-actions-left">
          {state.isStreaming && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={offline || sending || !text.trim()}
                onClick={() => void send("follow_up")}
              >
                完成后执行
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={offline || sending}
                onClick={() => void abort()}
              >
                停止运行
              </button>
            </>
          )}
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={offline || sending || !text.trim()}
          onClick={() => void send(primaryType)}
        >
          {sending ? "发送中…" : primaryAction}
        </button>
      </div>
      {offline && (
        <div className="composer-note composer-note-error">
          连接中断，命令发送已禁用。
        </div>
      )}
    </footer>
  );
}
