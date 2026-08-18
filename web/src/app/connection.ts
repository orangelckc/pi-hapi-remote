/**
 * 远端连接核心：API 客户端、长轮询循环、事件归约与控制命令。
 */
import {
  LIMITS,
  PROTOCOL_VERSION,
  type DeviceInfo,
  type RemoteCommand,
  type RemoteEntry,
  type RemoteEvent,
  type SessionSnapshot,
} from "../protocol.js";
import { EntryLog } from "../protocol.js";

export type ConnectionPhase =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "invalid"
  | "error";

export interface ConnectionState {
  phase: ConnectionPhase;
  errorMessage?: string;
  session?: SessionSnapshot["session"];
  isStreaming: boolean;
  controllerDeviceId?: string;
  controllerLabel?: string;
  localHasControl: boolean;
  entries: RemoteEntry[];
}

export interface ConnectionCredentials {
  endpoint: string;
  shareId: string;
  viewerToken: string;
  claimToken?: string;
  controllerToken?: string;
}

export class RemoteConnectionError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const POLL_BUFFER_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

export class RemoteConnection {
  readonly device: DeviceInfo;
  private credentials: ConnectionCredentials;
  private cursor = 0;
  private running = false;
  private pollAbort: AbortController | null = null;
  private log = new EntryLog<RemoteEntry>();
  private backoffMs = 1_000;

  state: ConnectionState = {
    phase: "connecting",
    isStreaming: false,
    localHasControl: true,
    entries: [],
  };

  constructor(credentials: ConnectionCredentials, device: DeviceInfo) {
    this.credentials = { ...credentials };
    this.device = device;
  }

  get amController(): boolean {
    return (
      this.state.controllerDeviceId === this.device.deviceId &&
      this.credentials.controllerToken !== undefined
    );
  }

  get hasClaimToken(): boolean {
    return this.credentials.claimToken !== undefined;
  }

  /** 当前游标（持久化用）。 */
  get currentCursor(): number {
    return this.cursor;
  }

  onStateChange: (state: ConnectionState) => void = () => {};

  private update(patch: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...patch };
    this.onStateChange(this.snapshotState());
  }

  private snapshotState(): ConnectionState {
    return { ...this.state, entries: this.log.entries() };
  }

  // ---- 生命周期 ----

  async start(): Promise<void> {
    this.running = true;
    try {
      await this.resync();
      if (!this.running) return;
      this.update({ phase: "connected" });
      this.backoffMs = 1_000;
      void this.pollLoop();
    } catch (error) {
      this.handleFailure(error);
    }
  }

  stop(): void {
    this.running = false;
    this.pollAbort?.abort();
  }

  /** 重新拉取 Snapshot（游标过期或断线恢复）。 */
  async resync(): Promise<void> {
    const snapshot = await this.fetchSnapshot();
    this.log.replace(snapshot.entries);
    this.cursor = snapshot.cursor;
    this.update({
      session: snapshot.session,
      isStreaming: snapshot.state.isStreaming,
      controllerDeviceId: snapshot.state.controllerDeviceId,
      controllerLabel: snapshot.state.controllerLabel,
      localHasControl: snapshot.state.localHasControl,
    });
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      this.pollAbort = new AbortController();
      try {
        const batch = await this.getEvents(this.cursor, LIMITS.longPollMaxWaitMs);
        this.pollAbort = null;
        if (!this.running) return;
        if (this.state.phase === "reconnecting") {
          this.update({ phase: "connected" });
        }
        this.backoffMs = 1_000;
        if (batch.resyncRequired) {
          await this.resync();
          continue;
        }
        for (const event of batch.events) {
          this.applyEvent(event);
        }
        this.cursor = Math.max(this.cursor, batch.cursor);
      } catch (error) {
        this.pollAbort = null;
        if (!this.running) return;
        if (error instanceof RemoteConnectionError) {
          if (error.status === 401) {
            this.update({ phase: "invalid", errorMessage: "分享凭证已失效" });
            this.running = false;
            return;
          }
        }
        this.update({ phase: "reconnecting" });
        await sleep(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
      }
    }
  }

  private applyEvent(event: RemoteEvent): void {
    switch (event.type) {
      case "entries_added":
        for (const entry of event.entries) {
          this.log.put(entry);
        }
        break;
      case "entry_updated":
        this.log.put(event.entry);
        break;
      case "agent_state":
        this.update({ isStreaming: event.isStreaming });
        return;
      case "control_state":
        this.update({
          controllerDeviceId: event.state.controllerDeviceId,
          controllerLabel: event.state.controllerLabel,
          localHasControl: event.state.localHasControl,
        });
        return;
      case "share_ended":
        this.running = false;
        this.update({ phase: "ended" });
        return;
    }
    this.update({});
  }

  // ---- HTTP ----

  private get readToken(): string {
    return this.credentials.controllerToken ?? this.credentials.viewerToken;
  }

  private url(path: string): string {
    const base = this.credentials.endpoint.replace(/\/+$/, "");
    return `${base}${path}`;
  }

  private readHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.readToken}`,
      "X-Pi-Remote-Device-Id": this.device.deviceId,
    };
  }

  private async readJson(response: Response): Promise<never> {
    let code = "error";
    let message = `请求失败（${response.status}）`;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // 保留默认信息。
    }
    throw new RemoteConnectionError(response.status, code, message);
  }

  private async fetchSnapshot(): Promise<SessionSnapshot> {
    const response = await fetchWithTimeout(
      this.url("/v1/snapshot"),
      { headers: this.readHeaders() },
      30_000,
    );
    if (!response.ok) await this.readJson(response);
    const snapshot = (await response.json()) as SessionSnapshot;
    if (snapshot.protocolVersion !== PROTOCOL_VERSION) {
      throw new RemoteConnectionError(
        400,
        "protocol_mismatch",
        `协议版本不兼容（服务端 v${snapshot.protocolVersion}，客户端 v${PROTOCOL_VERSION}），请刷新更新应用`,
      );
    }
    return snapshot;
  }

  private async getEvents(cursor: number, waitMs: number) {
    const response = await fetchWithTimeout(
      this.url(`/v1/events?cursor=${cursor}&wait=${waitMs}`),
      { headers: this.readHeaders() },
      waitMs + POLL_BUFFER_MS,
    );
    if (!response.ok) await this.readJson(response);
    return (await response.json()) as {
      events: RemoteEvent[];
      cursor: number;
      resyncRequired?: boolean;
    };
  }

  /** 发送控制命令。网络类失败自动重试一次（同 id 幂等防重复）。 */
  async sendCommand(command: RemoteCommand): Promise<void> {
    if (!this.credentials.controllerToken) {
      throw new RemoteConnectionError(403, "forbidden", "没有控制权");
    }
    const attempt = async (): Promise<Response> =>
      fetchWithTimeout(
        this.url("/v1/commands"),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.credentials.controllerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(command),
        },
        30_000,
      );

    let response: Response;
    try {
      response = await attempt();
    } catch {
      await sleep(1_500);
      response = await attempt();
    }
    if (!response.ok) await this.readJson(response);
  }

  /** 兑换一次性 Claim Token 获得控制权。 */
  async claimControl(): Promise<boolean> {
    if (!this.credentials.claimToken) return false;
    const response = await fetchWithTimeout(
      this.url("/v1/control/claim"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.credentials.claimToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(this.device),
      },
      30_000,
    );
    if (!response.ok) {
      if (response.status === 401) {
        // Claim 已被使用或失效。
        this.credentials.claimToken = undefined;
      }
      await this.readJson(response);
    }
    const body = (await response.json()) as { controllerToken: string };
    this.credentials.claimToken = undefined;
    this.credentials.controllerToken = body.controllerToken;
    return true;
  }

  /** 移交控制权给本机（仅当前控制者可用）；成功后本地清除控制令牌。 */
  async releaseControl(): Promise<void> {
    if (!this.credentials.controllerToken) {
      throw new RemoteConnectionError(403, "forbidden", "没有控制权");
    }
    const response = await fetchWithTimeout(
      this.url("/v1/control/release"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.credentials.controllerToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
      30_000,
    );
    if (!response.ok) await this.readJson(response);
    // 服务端已作废该令牌；本地同步清除，持久化由下一次状态变化触发。
    this.credentials.controllerToken = undefined;
  }

  /** 更新持久化用的凭证视图。 */
  get credentialSnapshot(): ConnectionCredentials {
    return { ...this.credentials };
  }

  private handleFailure(error: unknown): void {
    if (error instanceof RemoteConnectionError && error.status === 401) {
      this.update({ phase: "invalid", errorMessage: "分享凭证已失效" });
      return;
    }
    this.update({
      phase: "error",
      errorMessage: error instanceof Error ? error.message : "连接失败",
    });
  }
}
