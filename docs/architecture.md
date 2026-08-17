# 架构

## 总览

Pi 扩展直连当前 Session + 本地 HTTP Bridge（同源伺服前端静态页）+ Tunnelmole 临时隧道。

```text
Pi 当前进程
┌──────────────────────────────────────────────┐
│ pi-hapi-remote Extension                     │
│                                              │
│  index.ts          事件绑定 / 命令 / 快捷键   │
│  remote-hub.ts     组合根（生命周期编排）      │
│  session-bridge.ts Session Bridge（深模块）    │
│  transcript.ts     Transcript Projector      │
│  event-buffer.ts   Event Journal             │
│  auth.ts           Capability Authority      │
│  control-lease.ts  Control Lease             │
│  remote-server.ts  Remote Bridge + Gateway   │
│  audit.ts          审计（custom entry）       │
│  tui-status.ts     TUI 状态条                │
│  tunnel/           Tunnel Adapter 抽象       │
└──────────────┬───────────────────────────────┘
               │ 127.0.0.1:<随机端口>
        Tunnelmole 子进程（HTTPS）
               │
               ▼ 静态页面 + 长轮询 + POST（同源）
        远端浏览器（React + Vite + Service Worker）
```

## 深模块职责

各模块对外只暴露稳定接口，内部实现可替换。

### Session Bridge（session-bridge.ts）

封装 Pi 生命周期附着、活动分支快照、事件归一化、命令注入与 Session 身份校验。

- `beginShare()`：锁定 Session ID 并从 `getBranch()` 重建投影。
- 事件入口：`onAgentStart/Settled`、`onMessageStart/Update/End`、`onToolExecutionStart/End`。
- 命令注入：`executeCommand()` 统一执行 Session 身份校验、幂等去重（客户端命令 ID）、状态校验（idle 才允许 prompt；运行中才允许 abort）与 Pi API 调用。
- `resyncFromSession()`：tree 导航或压缩后全量重建并要求观察者重同步。

### Transcript Projector（transcript.ts）

把 Session entries 与实时事件转换为可公开的 `RemoteEntry`。统一过滤：

- 系统提示词（从不进入投影）。
- 废弃分支（只投影当前活动路径）。
- `custom` / `custom_message` 扩展私有数据。
- 不必要的本机路径元数据（只保留 cwd 尾段作为标签）。

Thinking 正文与助手错误信息自协议 v2 起随助手条目转发（流式期间随 `entry_updated` 增量更新，截断至 50 000 字符）。

维护条目唯一事实来源：快照与增量事件都来自同一份内部状态，保证一致。

### Event Journal（event-buffer.ts）

单调递增游标（seq 从 1 开始）、有限容量环形缓冲（默认 2000）、长轮询等待者与重同步判定：

- 有新事件立即唤醒全部等待者。
- 无事件最多等待 `wait` 毫秒后返回空批。
- 游标落后于缓冲起点或超前于当前值 → `resyncRequired`。
- `invalidate()`：投影重建后使所有后续 poll 立即要求重同步。

### Capability Authority（auth.ts）

Viewer Token、一次性 Claim Token、Controller Token 的签发与校验：

- 令牌为 256 位加密安全随机数，前缀 `phr1_`。
- 服务端只保存 SHA-256 摘要，比较使用 `timingSafeEqual`。
- `consumeClaimToken()` 命中即作废（一次性语义）。
- `revokeAll()` 在分享结束时使全部令牌失效。

### Control Lease（control-lease.ts）

单远端写入者规则：

- 本机默认持有控制权；`grant()` 授予（Claim 兑换或本机批准，可替换现有控制者）、`reclaim()` / `revoke()` / `end()` 释放。
- 归属变化回调统一驱动：`control_state` 事件发布、审计写入、TUI 状态条刷新与本机输入拦截开关。

### Remote Bridge / Command Gateway（remote-server.ts）

`node:http` 实现，只监听 `127.0.0.1` 随机端口；同时同源伺服前端静态产物（`web/dist`）：

- 静态路由：`GET /` 与非 `/v1/` 路径 → `web/dist`（路径穿越防护；`/assets/*` 长缓存 immutable，其余 no-cache；文本资源按 `Accept-Encoding` gzip）。
- 传输优化：JSON 响应 ≥ 1KB 时 gzip；`keepAliveTimeout` 30s 覆盖长轮询周期，减少经隧道中继的重复握手。

| 接口 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /v1/health` | 无 | 最小健康检查，不暴露 Session/授权状态 |
| `GET /v1/snapshot` | Viewer 或 Controller | 归一化条目 + Agent/控制状态 + 当前游标 |
| `GET /v1/events?cursor&wait` | Viewer 或 Controller | 长轮询增量事件（≤25s） |
| `POST /v1/commands` | Controller | prompt / steer / follow_up / abort，幂等 |
| `POST /v1/control/claim` | Claim（一次性） | 兑换 Controller Token |
| `POST /v1/control/request` | Viewer | 申请控制权，同步等待本机审批（≤60s） |

### Tunnel Adapter（tunnel/）

`TunnelAdapter` 提供 `start(options) / stop()` 抽象；MVP 只实现 `TunnelmoleAdapter`：

- 以 `node <tunnelmole-cli-entry> <port>` 子进程运行（不用其库 API：无清晰关闭句柄且部分错误路径会 `process.exit()`）。
- `TUNNELMOLE_TELEMETRY=0` 关闭遥测（注意 `QUIET_MODE`/`CI` 会连 URL 输出一起抑制，不可设置）。
- 从 stdout/stderr 解析 `https://*.tunnelmole.net`（排除 dashboard 提示链接）。
- 启动超时 30s；`stop()` 先 SIGTERM、3s 后 SIGKILL，确定性终止。

### 审计（audit.ts）

关键控制事件写入 `pi.appendEntry("remote-audit", …)` 自定义条目——**不进入模型上下文**，TUI 中以暗色单行渲染。

### TUI（tui-status.ts + index.ts）

- 远端控制期间：编辑器上方醒目状态条 + 收回提示；`input` 事件拦截普通本机输入（`source === "extension"` 的远端注入放行；`/remote` 命令在 input 之前处理不受影响）。
- 分享期间：页脚显示观察者数量与控制权归属。
- `Ctrl+Shift+R` 快捷键立即收回。

## PWA（web/）

React 18 + TypeScript + Vite + vite-plugin-pwa：

- `app/connection.ts`：API 客户端、长轮询循环（指数退避重连）、事件归约、命令幂等发送（网络失败自动同 ID 重试一次）、Claim 兑换与控制申请。
- `app/useRemote.ts`：连接生命周期 Hook，凭证节流持久化。
- `storage/db.ts`：IndexedDB 只存连接信息（Endpoint、Share ID、设备 ID、凭证、游标），不存对话正文；Share 失效自动清除。
- URL Fragment `#/connect/<base64url payload>` 携带全部连接参数，隧道服务方不可见；解析后立即从地址栏清除。
- Service Worker 只 precache 应用壳（跨域 API 请求不拦截不缓存）。
- 命令状态机：空闲=发送（prompt），运行中=立即引导（steer）+ 完成后执行（follow_up）+ 停止（abort）；只读设备显示申请控制权。

## 数据流（一次远端 Steer）

1. 远端 PWA `POST /v1/commands {id, type:"steer", text}`。
2. Gateway：Origin 校验 → 限速 → Controller Token 验证 → 租约校验 → 命令校验 → 幂等检查。
3. Session Bridge：Session 身份校验 → `pi.sendUserMessage(text, {deliverAs:"steer"})`。
4. Pi 事件回流：`message_start/update/end` → Projector → Journal → 长轮询分发给所有观察者。
5. Abort 类命令额外写入审计条目。

## 生命周期失效矩阵

| 触发 | 行为 |
| --- | --- |
| `/remote stop` | 广播 `share_ended` → 隧道终止 → Server 关闭 → 令牌全部失效 → 审计 |
| `/remote reclaim` / `Ctrl+Shift+R` | 撤销 Controller Token，租约回本机，广播 `control_state`，审计 |
| `/remote revoke` | 同上但保留分享 |
| Session 切换 / Fork（`session_shutdown`） | 与 `/remote stop` 等价 |
| 扩展重载（`/reload`） | `session_shutdown(reason=reload)` → 同上 |
| Pi 退出（Ctrl+C/D、SIGHUP/SIGTERM） | `session_shutdown` → 同上 |
| Tunnelmole 崩溃 | 隧道入口失效；令牌仍在但不可达（无公网入口即无暴露面） |
