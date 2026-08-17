# 同步协议

协议版本：`2`（`shared/protocol.ts` 中的 `PROTOCOL_VERSION`）。快照与 PWA 均携带版本号，不匹配时客户端提示更新。

## 连接载荷

分享链接格式（敏感参数全部位于 Fragment，不发送给静态托管服务端）：

```text
<PWA_BASE_URL>#/connect/<base64url(JSON)>
```

```ts
interface SharePayload {
  version: 1;
  endpoint: string;      // 公网 HTTPS 入口（Tunnelmole URL）
  shareId: string;       // 展示用短 ID
  viewerToken: string;   // 只读令牌
  claimToken?: string;   // 一次性控制权兑换令牌（仅 Controller QR）
}
```

PWA 解析成功后立即从地址栏清除 Fragment。

## 认证

所有业务接口使用 `Authorization: Bearer <token>`：

- `viewerToken`：可读取 Snapshot / Events、申请控制权。
- `controllerToken`：蕴含读取权限，额外可提交命令。
- `claimToken`：仅可用于一次 `/v1/control/claim`，命中即作废。

令牌格式 `phr1_<43 字符 base64url>`（256 位随机数）。错误、过期、被撤销统一返回 `401`，不区分原因（避免状态枚举）。

## 接口

### GET /v1/snapshot

```ts
interface SessionSnapshot {
  protocolVersion: 1;
  shareId: string;
  session: { id: string; name?: string; cwdLabel: string };
  state: {
    isStreaming: boolean;          // Agent 是否运行（含重试与排队 follow-up）
    controllerDeviceId?: string;
    controllerLabel?: string;
    localHasControl: boolean;
  };
  entries: RemoteEntry[];
  cursor: number;                  // 从此游标继续长轮询
}
```

### GET /v1/events?cursor=N&wait=25000

长轮询。有 `seq > cursor` 的事件立即返回；否则最多等待 `wait` 毫秒（上限 25s）。

```ts
interface EventBatch {
  events: RemoteEvent[];
  cursor: number;
  resyncRequired?: boolean;   // 游标过期：客户端必须重新拉 Snapshot
}
```

```ts
type RemoteEvent =
  | { type: "entries_added"; entries: RemoteEntry[] }
  | { type: "entry_updated"; entry: RemoteEntry }      // 流式正文 / 工具状态
  | { type: "agent_state"; isStreaming: boolean }
  | { type: "control_state"; state: RemoteState }
  | { type: "share_ended"; reason?: string };
```

客户端循环：收到即处理 → 立即发起下一次请求。断线用指数退避重连（1s 起，上限 15s）。

### POST /v1/commands

```ts
type RemoteCommand =
  | { id: string; type: "prompt"; text: string }      // 仅空闲
  | { id: string; type: "steer"; text: string }       // 运行中注入（空闲时等同 prompt）
  | { id: string; type: "follow_up"; text: string }   // 排队至当前任务完成
  | { id: string; type: "abort" };                    // 仅运行中
```

- `id` 由客户端生成（UUID），服务端 500 条 LRU 去重；网络重试复用同 ID 不会产生重复消息。
- 状态不符返回 `409`（如空闲时 steer 之外的 prompt、空闲时 abort）。

### POST /v1/control/claim

```jsonc
// 请求：Bearer <claimToken>
{ "deviceId": "…", "deviceLabel": "iPhone · Safari（手机）" }
// 响应
{ "controllerToken": "…" }
```

一次性：第二个设备再用同一 Claim 即 `401`。兑换即替换现有控制者（QR 视为本机用户的预先授权）。

### POST /v1/control/request

```jsonc
// 请求：Bearer <viewerToken>
{ "deviceId": "…", "deviceLabel": "…" }
// 响应（同步等待本机审批，最长 60s）
{ "status": "approved", "controllerToken": "…" }
{ "status": "denied" }
{ "status": "timeout" }
```

本机审批界面显示设备信息；已有控制者时明确提示"将替换当前控制者"。

## 条目模型

```ts
type RemoteEntry =
  | { kind: "user_message"; id; text; timestamp }
  | { kind: "assistant_message"; id; text; thinking?; thinkingTruncated?; thinkingRedacted?;
      error?; modelLabel?; timestamp }
  | { kind: "tool_call"; id; toolName; argsPreview; status: "running"|"complete"|"error";
      resultText?; resultTruncated?; timestamp; completedAt? }
  | { kind: "notice"; id; text; timestamp };
```

- `tool_call.id` 与 Pi 的 toolCallId 一致，运行/完成状态以同一 id 更新。
- `argsPreview` 截断至 2000 字符，`resultText` 截断至 50000 字符（`resultTruncated` 标记）。
- `thinking` 为 Thinking 块拼接（协议 v2 起转发），流式期间随 `entry_updated` 增量更新，截断至 50000 字符；被提供商安全过滤（redacted）时 `thinkingRedacted` 为 true。
- `error` 为助手消息出错信息（Provider 报错、中断原因等），协议 v2 起转发。
- 系统提示词、废弃分支、`custom`/`custom_message` 扩展私有条目不进入条目模型。

## 限流与限制

| 项 | 值 |
| --- | --- |
| 请求体上限 | 256 KB |
| 文本长度上限 | 100 000 字符 |
| 思考过程截断 | 50 000 字符 |
| 工具参数预览截断 | 2 000 字符 |
| 工具结果截断 | 50 000 字符 |
| 长轮询最长等待 | 25 s |
| 并发长轮询上限 | 32（超出立即返回空批） |
| 控制端点限速 | 30 次/分钟/设备（claim/request/commands） |
| 事件缓冲容量 | 2000（覆盖后旧游标触发重同步） |
| 控制申请等待 | 60 s |
| 隧道启动超时 | 30 s |

## 错误码

统一响应体 `{ "error": { "code": "…", "message": "…" } }`：

`bad_request` `unauthorized` `forbidden` `not_found` `method_not_allowed` `payload_too_large` `rate_limited` `conflict` `protocol_mismatch` `unavailable`（另含命令态错误如 `agent_running` / `not_running`）。
