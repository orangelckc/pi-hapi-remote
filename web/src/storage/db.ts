/**
 * 连接信息持久化（IndexedDB）。
 *
 * 只保存当前 Endpoint、Share ID、设备信息、当前 Share 凭证与最后游标；
 * 不保存对话正文、工具结果或输入历史。Share 失效后清除。
 */

const DB_NAME = "pi-hapi-remote";
const DB_VERSION = 1;
const STORE = "connection";

export interface StoredConnection {
  endpoint: string;
  shareId: string;
  deviceId: string;
  deviceLabel: string;
  viewerToken: string;
  /** 一次性兑换令牌；兑换成功后立即从存储中移除。 */
  claimToken?: string;
  /** 控制令牌；收回/撤销/停止后失效。 */
  controllerToken?: string;
  lastCursor: number;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadConnection(): Promise<StoredConnection | null> {
  try {
    const db = await openDb();
    const value = await wrap<StoredConnection | undefined>(
      db.transaction(STORE, "readonly").objectStore(STORE).get("current"),
    );
    db.close();
    return value ?? null;
  } catch {
    return null;
  }
}

export async function saveConnection(connection: StoredConnection): Promise<void> {
  try {
    const db = await openDb();
    await wrap(
      db.transaction(STORE, "readwrite").objectStore(STORE).put(connection, "current"),
    );
    db.close();
  } catch {
    // 存储失败不阻塞连接流程。
  }
}

export async function clearConnection(): Promise<void> {
  try {
    const db = await openDb();
    await wrap(
      db.transaction(STORE, "readwrite").objectStore(STORE).delete("current"),
    );
    db.close();
  } catch {
    // 忽略。
  }
}
