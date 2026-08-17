/**
 * 连接生命周期 Hook：封装 RemoteConnection 的创建、凭证持久化与清理。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { LIMITS, type SharePayload } from "../protocol.js";
import {
  clearConnection,
  loadConnection,
  saveConnection,
  type StoredConnection,
} from "../storage/db.js";
import { getDeviceId, getDeviceLabel } from "./device.js";
import { RemoteConnection, type ConnectionState } from "./connection.js";

export interface RemoteSession {
  state: ConnectionState | null;
  connection: RemoteConnection | null;
  amController: boolean;
  hasClaimToken: boolean;
  startFromPayload(payload: SharePayload): Promise<void>;
  startFromStorage(): Promise<boolean>;
  disconnect(): void;
  clearCredentials(): Promise<void>;
}

export function useRemote(): RemoteSession {
  const [state, setState] = useState<ConnectionState | null>(null);
  const connRef = useRef<RemoteConnection | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback((conn: RemoteConnection): void => {
    if (saveTimer.current) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const creds = conn.credentialSnapshot;
      void saveConnection({
        endpoint: creds.endpoint,
        shareId: creds.shareId,
        deviceId: conn.device.deviceId,
        deviceLabel: conn.device.deviceLabel,
        viewerToken: creds.viewerToken,
        claimToken: creds.claimToken,
        controllerToken: creds.controllerToken,
        lastCursor: conn.currentCursor,
        savedAt: Date.now(),
      });
    }, 2_000);
  }, []);

  const createConnection = useCallback(
    (stored: StoredConnection): RemoteConnection => {
      connRef.current?.stop();
      const conn = new RemoteConnection(
        {
          endpoint: stored.endpoint,
          shareId: stored.shareId,
          viewerToken: stored.viewerToken,
          claimToken: stored.claimToken,
          controllerToken: stored.controllerToken,
        },
        { deviceId: stored.deviceId, deviceLabel: stored.deviceLabel },
      );
      connRef.current = conn;
      conn.onStateChange = (next) => {
        setState(next);
        if (next.phase === "ended" || next.phase === "invalid") {
          void clearConnection();
        } else {
          persist(conn);
        }
      };
      return conn;
    },
    [persist],
  );

  const startFromPayload = useCallback(
    async (payload: SharePayload): Promise<void> => {
      const stored: StoredConnection = {
        endpoint: payload.endpoint,
        shareId: payload.shareId,
        deviceId: getDeviceId(),
        deviceLabel: getDeviceLabel(),
        viewerToken: payload.viewerToken,
        claimToken: payload.claimToken,
        lastCursor: 0,
        savedAt: Date.now(),
      };
      await saveConnection(stored);
      const conn = createConnection(stored);
      await conn.start();
      // QR 携带一次性 Claim：自动兑换，扫码即获得控制权。
      if (conn.hasClaimToken && conn.state.phase !== "invalid" && conn.state.phase !== "ended") {
        try {
          await conn.claimControl();
          persist(conn);
        } catch {
          // Claim 已失效：保持只读观察者身份。
          persist(conn);
        }
      }
    },
    [createConnection, persist],
  );

  const startFromStorage = useCallback(async (): Promise<boolean> => {
    const stored = await loadConnection();
    if (!stored) return false;
    if (stored.claimToken && Date.now() - stored.savedAt > LIMITS.controlRequestTimeoutMs) {
      // 旧 Claim 大概率已被本机扫描设备兑换，避免误用。
      stored.claimToken = undefined;
    }
    const conn = createConnection(stored);
    await conn.start();
    return true;
  }, [createConnection]);

  const disconnect = useCallback((): void => {
    connRef.current?.stop();
    connRef.current = null;
    setState(null);
  }, []);

  const clearCredentials = useCallback(async (): Promise<void> => {
    await clearConnection();
  }, []);

  useEffect(() => {
    return () => {
      connRef.current?.stop();
    };
  }, []);

  const conn = connRef.current;
  return {
    state,
    connection: conn,
    amController: conn?.amController ?? false,
    hasClaimToken: conn?.hasClaimToken ?? false,
    startFromPayload,
    startFromStorage,
    disconnect,
    clearCredentials,
  };
}
