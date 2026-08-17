/**
 * 应用入口：解析 URL Fragment 连接载荷、恢复已存连接、渲染聊天界面。
 */
import { useCallback, useEffect, useState } from "react";
import type { SharePayload } from "../protocol.js";
import { ChatView } from "../components/ChatView.js";
import { Welcome } from "../components/Welcome.js";
import { useRemote } from "./useRemote.js";

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 解析 #/connect/<payload>；Fragment 不会发送给静态托管服务端。 */
function parseConnectPayload(): SharePayload | null {
  const match = /^#\/connect\/([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  if (!match) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(match[1]!)) as SharePayload;
    if (
      payload &&
      payload.version === 1 &&
      typeof payload.endpoint === "string" &&
      typeof payload.shareId === "string" &&
      typeof payload.viewerToken === "string"
    ) {
      return payload;
    }
    return null;
  } catch {
    return null;
  }
}

export function App(): JSX.Element {
  const remote = useRemote();
  const [booted, setBooted] = useState(false);

  const boot = useCallback(async (): Promise<void> => {
    const payload = parseConnectPayload();
    if (payload) {
      // 清除地址栏中的敏感 Fragment，避免被复制或记录。
      history.replaceState(null, "", window.location.pathname);
      await remote.startFromPayload(payload);
      return;
    }
    const restored = await remote.startFromStorage();
    if (!restored) {
      setBooted(true);
    }
  }, [remote]);

  useEffect(() => {
    void boot();
    // 仅启动时执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state = remote.state;

  if (!state) {
    if (!booted) {
      return <div className="boot">正在连接…</div>;
    }
    return <Welcome />;
  }

  return (
    <ChatView
      state={state}
      amController={remote.amController}
      connection={remote.connection}
      onClear={remote.clearCredentials}
    />
  );
}
