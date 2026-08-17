/**
 * 会话条目渲染：用户消息、助手消息（思考过程 + 流式光标 + 错误信息）、
 * 工具调用（可折叠）、提示。
 */
import { useEffect, useMemo, useState } from "react";
import type { AssistantMessageEntry, RemoteEntry } from "../protocol.js";

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function EntryItem({ entry }: { entry: RemoteEntry }): JSX.Element {
  switch (entry.kind) {
    case "user_message":
      return (
        <div className="row row-user">
          <div className="bubble bubble-user">
            <div className="bubble-text">{entry.text}</div>
            <div className="bubble-time">{formatTime(entry.timestamp)}</div>
          </div>
        </div>
      );
    case "assistant_message":
      return <AssistantMessageItem entry={entry} />;
    case "tool_call":
      return <ToolCallItem entry={entry} />;
    case "notice":
      return <div className="notice">{entry.text}</div>;
  }
}

/** 助手消息：思考过程（可折叠）+ 正文 + 错误信息。 */
function AssistantMessageItem({ entry }: { entry: AssistantMessageEntry }): JSX.Element {
  const hasThinking = entry.thinking !== undefined || entry.thinkingRedacted === true;
  const showPlaceholder = !entry.text && !hasThinking && entry.error === undefined;
  return (
    <div className="row row-assistant">
      <div className="bubble bubble-assistant">
        {hasThinking && <ThinkingPanel entry={entry} />}
        {(entry.text || showPlaceholder) && (
          <div className="bubble-text assistant-text">
            {entry.text || "…"}
            <span className="caret" />
          </div>
        )}
        {entry.error !== undefined && <div className="assistant-error">{entry.error}</div>}
        <div className="bubble-meta">
          {entry.modelLabel && <span className="model-label">{entry.modelLabel}</span>}
          <span className="bubble-time">{formatTime(entry.timestamp)}</span>
        </div>
      </div>
    </div>
  );
}

/** 思考过程面板：流式阶段自动展开，正文出现后自动折叠；用户手动切换优先。 */
function ThinkingPanel({ entry }: { entry: AssistantMessageEntry }): JSX.Element {
  const [userToggled, setUserToggled] = useState(false);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (!userToggled) setExpanded(!entry.text);
  }, [entry.text, userToggled]);

  const toggle = (): void => {
    setUserToggled(true);
    setExpanded((v) => !v);
  };

  const hidden = entry.thinkingRedacted === true && !entry.thinking;

  return (
    <div className="thinking">
      <button
        type="button"
        className="thinking-header"
        onClick={toggle}
        aria-expanded={expanded}
      >
        <span className="thinking-label">思考过程</span>
        {entry.thinkingRedacted === true && (
          <span className="thinking-redacted-badge">部分被安全过滤</span>
        )}
        <span className="tool-chevron">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="thinking-body">
          {hidden ? "（思考内容已被提供商安全过滤，不可见）" : entry.thinking}
          {entry.thinkingTruncated && (
            <span className="tool-result-truncated">（思考过程过长已截断）</span>
          )}
        </div>
      )}
    </div>
  );
}

function ToolCallItem({ entry }: { entry: Extract<RemoteEntry, { kind: "tool_call" }> }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const statusIcon =
    entry.status === "running" ? (
      <span className="spinner" />
    ) : entry.status === "error" ? (
      <span className="tool-status tool-status-error">✗</span>
    ) : (
      <span className="tool-status tool-status-ok">✓</span>
    );

  const resultLines = useMemo(() => (entry.resultText ?? "").split("\n").length, [entry.resultText]);

  return (
    <div className={`tool-card tool-${entry.status}`}>
      <button
        type="button"
        className="tool-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {statusIcon}
        <span className="tool-name">{entry.toolName}</span>
        <span className="tool-args-preview">
          {entry.argsPreview.split("\n")[0]?.slice(0, 80) || ""}
        </span>
        <span className="tool-chevron">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="tool-body">
          {entry.argsPreview && (
            <pre className="tool-args">{entry.argsPreview}</pre>
          )}
          {entry.resultText !== undefined && (
            <pre className={`tool-result ${entry.status === "error" ? "tool-result-error" : ""}`}>
              {entry.resultText}
              {entry.resultTruncated && (
                <span className="tool-result-truncated">（结果过长已截断）</span>
              )}
            </pre>
          )}
          {entry.resultText === undefined && entry.status === "running" && (
            <div className="tool-running">执行中…</div>
          )}
        </div>
      )}
      {!expanded && entry.resultText !== undefined && (
        <div className="tool-summary">
          {entry.status === "error" ? "执行出错" : `完成 · ${resultLines} 行结果`}
        </div>
      )}
    </div>
  );
}
