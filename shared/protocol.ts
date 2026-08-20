/**
 * Pi HAPI Remote 共享协议模型。
 *
 * 本文件同时被扩展（Node 运行时）与 PWA（浏览器运行时）引用，
 * 不得引入任何平台专属 API。协议类型一经发布即视为稳定契约，
 * 变更时必须递增 PROTOCOL_VERSION。
 */

export const PROTOCOL_VERSION = 3;

/** URL Fragment 中的连接载荷（Fragment 不会发送给静态托管服务端）。 */
export interface SharePayload {
  version: number;
  /** 公网 HTTPS 入口，例如 https://xxxx.tunnelmole.net */
  endpoint: string;
  shareId: string;
  viewerToken: string;
  /** 一次性控制权兑换令牌；仅 Controller QR 携带，兑换后立即作废。 */
  claimToken?: string;
}

/** 远端可见的归一化会话条目。系统提示词、废弃分支与扩展私有数据不在此列；
 * Thinking 正文与助手错误信息自协议 v2 起转发。 */
export type RemoteEntry =
  | UserMessageEntry
  | AssistantMessageEntry
  | ToolCallEntry
  | NoticeEntry;

export interface UserMessageEntry {
  kind: "user_message";
  id: string;
  /** 剥离内部信封（plan-mode / skill / pi-context 等）后的用户可见文本。 */
  text: string;
  /** skill 信封的技能名（v3），渲染为气泡内小标签。 */
  skillName?: string;
  /** pi-context 中的文件引用（v3，@basename 形式）。 */
  contextFiles?: string[];
  timestamp: number;
}

export interface AssistantMessageEntry {
  kind: "assistant_message";
  id: string;
  text: string;
  /** 思考过程（Thinking 块拼接，已截断）；流式期间随 entry_updated 增量更新。 */
  thinking?: string;
  thinkingTruncated?: boolean;
  /** 思考内容被提供商安全过滤（redacted）时为 true，thinking 为空。 */
  thinkingRedacted?: boolean;
  /** 助手消息出错信息（Provider 报错、中断原因等）。 */
  error?: string;
  /** 模型显示信息，例如 "claude-sonnet-4-5"；不含 Provider 密钥等敏感内容。 */
  modelLabel?: string;
  timestamp: number;
}

export interface ToolCallEntry {
  kind: "tool_call";
  /** 与 Pi 的 toolCallId 一致，同一工具调用的状态更新复用此 id。 */
  id: string;
  toolName: string;
  /** 参数预览（已截断），默认折叠展示。 */
  argsPreview: string;
  status: "running" | "complete" | "error";
  /** 工具结果文本（已截断），完成后填充。 */
  resultText?: string;
  resultTruncated?: boolean;
  /** 工具目标摘要（v3）：bash→command、read/write/edit→path、grep→pattern/query 等，
   * 服务端从原始参数提取，避免前端解析截断后的 argsPreview。 */
  target?: string;
  /** 编辑类工具的 unified diff 行（v3，来自工具结果 details.diff，已截断）。 */
  diff?: string;
  diffTruncated?: boolean;
  timestamp: number;
  completedAt?: number;
}

/** 会话级提示（如压缩摘要），只读展示。 */
export interface NoticeEntry {
  kind: "notice";
  id: string;
  text: string;
  timestamp: number;
}

/** Agent 与控制权状态（快照与 control_state 事件共用）。 */
export interface RemoteState {
  /** Agent 是否正在运行（含自动重试、压缩重试与排队 follow-up）。 */
  isStreaming: boolean;
  /** 当前远端控制者设备 ID；无远端控制者时为空。 */
  controllerDeviceId?: string;
  controllerLabel?: string;
  /** 本机是否持有控制权。 */
  localHasControl: boolean;
}

export interface SessionSnapshot {
  protocolVersion: number;
  shareId: string;
  session: {
    id: string;
    name?: string;
    cwdLabel: string;
  };
  state: RemoteState;
  entries: RemoteEntry[];
  /** 当前事件游标；客户端从此游标继续长轮询。 */
  cursor: number;
}

/** 增量事件。游标单调递增，事件按追加顺序分发给所有观察者。 */
export type RemoteEvent =
  | { type: "entries_added"; entries: RemoteEntry[] }
  | { type: "entry_updated"; entry: RemoteEntry }
  | { type: "agent_state"; isStreaming: boolean }
  | { type: "control_state"; state: RemoteState }
  | { type: "share_ended"; reason?: string };

export interface EventBatch {
  events: RemoteEvent[];
  cursor: number;
  /** 游标已过期（事件缓冲被覆盖），客户端必须重新拉取 Snapshot。 */
  resyncRequired?: boolean;
}

/** 远端控制命令。id 由客户端生成，用于网络重试幂等去重。 */
export type RemoteCommand =
  | { id: string; type: "prompt"; text: string }
  | { id: string; type: "steer"; text: string }
  | { id: string; type: "follow_up"; text: string }
  | { id: string; type: "abort" };

export type RemoteCommandType = RemoteCommand["type"];

/** 申请/兑换控制权时上报的设备信息。 */
export interface DeviceInfo {
  deviceId: string;
  deviceLabel: string;
}

export interface ClaimResponse {
  controllerToken: string;
}

export interface CommandAck {
  ok: true;
  /** 命令 id 重复提交时为 true，不会重复执行。 */
  duplicate?: boolean;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/** 协议与资源限制常量（两端共用）。 */
export const LIMITS = {
  /** 单个请求体上限。 */
  maxBodyBytes: 256 * 1024,
  /** 单条消息文本上限。 */
  maxTextLength: 100_000,
  /** 思考过程截断长度。 */
  maxThinkingLength: 50_000,
  /** 工具参数预览截断长度。 */
  maxArgsPreviewLength: 2_000,
  /** 工具结果截断长度。 */
  maxToolResultLength: 50_000,
  /** 工具 diff 截断长度。 */
  maxDiffLength: 50_000,
  /** 工具目标摘要截断长度。 */
  maxTargetLength: 88,
  /** 长轮询最长等待。 */
  longPollMaxWaitMs: 25_000,
  /** 全局并发长轮询上限。 */
  maxConcurrentPolls: 32,
  /** 事件环形缓冲容量；超出后旧事件被覆盖，旧游标触发 resync。 */
  eventBufferCapacity: 2_000,
  /** 控制权申请等待本机审批的最长时间。 */
  controlRequestTimeoutMs: 60_000,
  /** 隧道启动超时。 */
  tunnelStartTimeoutMs: 30_000,
  /** 命令幂等去重表容量。 */
  commandDedupCapacity: 500,
  /** 控制端点限速：每分钟每设备最大请求数。 */
  controlRateLimitPerMinute: 30,
  /** 流式条目更新合并窗口：窗口内的连续帧合并为一帧发布。 */
  streamingUpdateCoalesceMs: 50,
} as const;

/** 通用错误码。 */
export const ERROR_CODES = {
  badRequest: "bad_request",
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  notFound: "not_found",
  methodNotAllowed: "method_not_allowed",
  payloadTooLarge: "payload_too_large",
  rateLimited: "rate_limited",
  conflict: "conflict",
  protocolMismatch: "protocol_mismatch",
  unavailable: "unavailable",
} as const;
