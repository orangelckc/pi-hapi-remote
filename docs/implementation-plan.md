# Pi HAPI Remote：MVP 架构与实施计划

## 1. 方案结论

采用“**Pi 扩展直连当前 Session + 本地 HTTP Bridge（同源伺服前端静态页）+ Tunnelmole 临时隧道**”。

它与 HAPI 的目标类似，但首版不复制 HAPI 的 Hub/RPC 完整架构：

```text
Pi 当前进程
┌──────────────────────────────────┐
│ pi-hapi-remote Extension         │
│                                  │
│ Session Adapter                  │
│  ├─ 读取当前活动分支             │
│  ├─ 监听消息/工具/运行状态       │
│  └─ 注入 prompt/steer/follow-up  │
│                                  │
│ Control Lease + Auth             │
│                                  │
│ Local HTTP Bridge 127.0.0.1:*    │
└────────────────┬─────────────────┘
                 │
          Tunnelmole 子进程
                 │ HTTPS
                 ▼
         Tunnelmole 公网地址
                 ▲
                 │ 长轮询 + POST
                 ▼
┌──────────────────────────────────┐
│ 远端浏览器（本机同源伺服的静态页） │
│ React + TypeScript + Vite        │
│ 不处理、不存储任何会话数据       │
└──────────────────────────────────┘
```

HAPI 通过 Hub 和 Pi RPC 管理独立 Pi 运行时，适合稳定地址、多设备、通知和完整会话管理。本方案直接作为扩展附着在已经运行的 Pi Session 上，更符合“随时分享当前对话”和零 VPS 运维的目标。

## 2. MVP 产品范围

### 2.1 包含

- `/remote start` 开启当前 Session 的临时分享。
- `/remote status` 查看地址、设备和控制权状态。
- `/remote reclaim` 本机收回控制权。
- `/remote revoke` 撤销当前远端设备。
- `/remote stop` 关闭隧道和所有授权。
- 远端实时查看当前活动分支。
- 远端查看助手流式正文、工具调用及工具结果。
- 远端发送普通 Prompt。
- Agent 运行中默认发送 Steer。
- 支持主动选择 Follow-up。
- 支持远端 Abort。
- 支持多个只读观察者。
- 任意时刻只有一个远端写入者。
- 一次性控制二维码和只读分享链接。
- 本机审批其他观察者的控制请求。
- 可安装的移动端 PWA。

### 2.2 不包含

- 图片或文件上传。
- 远端工具权限审批。
- 模型和思考等级切换。
- Compact、Fork、Tree、Resume 等会话管理。
- 多人同时写入。
- VPS 中转和离线消息。
- Thinking 内容展示。
- 系统提示词和废弃分支展示。
- 对话正文离线缓存。
- 遥测、分析或错误上报。

## 3. 分享与授权流程

### 3.1 开启分享

用户执行：

```text
/remote start
```

扩展首先提示：

```text
当前活动分支中的用户消息、助手正文、工具参数和工具输出
将对分享链接持有者可见。

Thinking、系统提示词、废弃分支和扩展私有数据不会公开。
```

确认后：

1. 在随机本地端口启动 HTTP Bridge。
2. 生成新的 `shareId` 和能力令牌。
3. 启动 Tunnelmole 子进程。
4. 获得 HTTPS 公网地址。
5. 输出只读链接和一次性控制二维码。
6. 在 Session 中写入分享开始审计事件。

### 3.2 两种链接

#### Viewer URL

任何持有者都可以：

- 查看活动分支。
- 接收实时事件。
- 申请控制权。

不能直接发送消息或 Abort。

#### Controller QR

二维码包含一次性 Claim Capability：

- 第一个扫描设备可兑换控制凭证。
- 兑换成功后 Claim Capability 立即作废。
- 相当于用户在本机开启分享时，提前批准自己的手机。
- 避免离开电脑后无法批准手机的问题。

### 3.3 URL 格式

敏感参数放在 URL Fragment，而不是 Query：

```text
https://<tunnel-subdomain>.tunnelmole.net/#/connect/<encoded-payload>
```

Fragment 不会发送给隧道服务方。Payload 包含：

```ts
interface SharePayload {
  version: 1;
  endpoint: string;
  shareId: string;
  viewerToken: string;
  claimToken?: string;
}
```

Viewer 链接不含 `claimToken`，控制二维码包含一次性 `claimToken`。

## 4. 控制权模型

采用单写者租约：

```text
本机拥有控制权
       ⇅
一个已批准的远端设备
       │
其他远端设备只读
```

规则如下：

- 同时允许多个观察者。
- 同时只允许一个远端控制者。
- 控制设备刷新页面或短暂断网后可恢复。
- 控制凭证只在当前 Share 生命周期有效。
- `/remote stop`、`revoke`、切换 Session、Reload 或 Pi 退出后全部失效。
- 第二个设备申请控制时，本机审批界面明确显示是否替换现有控制者。
- 本机普通输入在远端控制期间暂时阻止，避免并发写入。
- 本机始终可通过状态条快捷键收回。

TUI 展示：

```text
┌ Remote: iPhone 正在控制 ──────────┐
│ Ctrl+Shift+R 收回控制权           │
└───────────────────────────────────┘
```

同时保留：

```text
/remote reclaim
```

收回后，远端设备立即降为只读。

## 5. Pi 扩展设计

### 5.1 Session Adapter

通过 Pi Extension API 直接接入当前 Session：

```ts
pi.on("session_start", ...)
pi.on("message_start", ...)
pi.on("message_update", ...)
pi.on("message_end", ...)
pi.on("tool_execution_start", ...)
pi.on("tool_execution_update", ...)
pi.on("tool_execution_end", ...)
pi.on("queue_update", ...)
pi.on("agent_start", ...)
pi.on("agent_settled", ...)
pi.on("session_shutdown", ...)
```

初次连接通过：

```ts
ctx.sessionManager.getBranch()
```

生成当前活动分支快照。

只输出：

- User Message。
- Assistant Text。
- Tool Call。
- Tool Result。
- Agent 和队列状态。
- 必要的模型显示信息。

过滤：

- `thinking` 内容块。
- `custom` entries。
- `custom_message` 扩展私有消息，除非未来显式允许。
- System Prompt。
- 废弃分支。
- Session 文件路径和本机绝对路径元数据中不必要的部分。

### 5.2 远端命令注入

空闲时：

```ts
pi.sendUserMessage(text)
```

运行中默认 Steer：

```ts
pi.sendUserMessage(text, {
  deliverAs: "steer",
})
```

用户主动选择 Follow-up：

```ts
pi.sendUserMessage(text, {
  deliverAs: "followUp",
})
```

Abort：

```ts
ctx.abort()
```

执行命令前必须再次检查：

- Share 是否仍有效。
- Session ID 是否匹配。
- 设备是否仍被批准。
- 设备是否持有当前写租约。
- 命令序号是否重复。
- Agent 当前状态是否允许该操作。

### 5.3 本机输入拦截

使用 `input` 事件检测本机交互输入：

- 没有远端控制者时正常放行。
- 远端持有写租约时阻止普通输入并提示使用收回快捷键。
- `/remote reclaim` 是扩展命令，在 `input` 之前被处理，因此不会被阻止。

## 6. 同步协议

Tunnelmole 当前实现将公网 HTTP 请求和完整 HTTP 响应序列化转发，不适合直接承载入站 WebSocket 或持续 SSE。因此使用：

- HTTP POST 发送命令。
- HTTP 长轮询接收增量事件。
- 单调递增事件序号恢复断线。

### 6.1 初始化

```http
GET /v1/snapshot
Authorization: Bearer <viewer-token>
```

响应：

```ts
interface SessionSnapshot {
  protocolVersion: 1;
  shareId: string;
  session: {
    id: string;
    name?: string;
    cwdLabel: string;
  };
  state: {
    isStreaming: boolean;
    controllerDeviceId?: string;
    localHasControl: boolean;
  };
  entries: RemoteEntry[];
  cursor: number;
}
```

### 6.2 长轮询事件

```http
GET /v1/events?cursor=123&wait=25000
Authorization: Bearer <viewer-token>
```

响应：

```ts
interface EventBatch {
  events: RemoteEvent[];
  cursor: number;
  resyncRequired?: boolean;
}
```

行为：

- 有新事件时立即返回。
- 无事件时最多等待约 25 秒。
- 返回后 PWA 立即发起下一次请求。
- Cursor 太旧或事件环形缓冲区已覆盖时返回 `resyncRequired`。
- PWA 随后重新请求 Snapshot。

### 6.3 远端命令

```http
POST /v1/commands
Authorization: Bearer <controller-token>
Content-Type: application/json
```

```ts
type RemoteCommand =
  | {
      id: string;
      type: "prompt";
      text: string;
    }
  | {
      id: string;
      type: "steer";
      text: string;
    }
  | {
      id: string;
      type: "follow_up";
      text: string;
    }
  | {
      id: string;
      type: "abort";
    };
```

命令必须带客户端生成的唯一 ID，用于防止网络重试导致重复 Prompt。

## 7. 安全设计

### 7.1 Capability Token

每次 `/remote start` 生成全新的随机令牌：

- `viewerToken`：读取快照和事件、申请控制。
- `claimToken`：一次性兑换控制凭证。
- `controllerToken`：批准后签发，仅当前 Share 有效。

令牌至少使用 256 位加密安全随机数：

```ts
crypto.randomBytes(32)
```

服务端只保存令牌摘要：

```ts
sha256(token)
```

### 7.2 本地服务约束

- 只监听 `127.0.0.1`。
- 使用系统分配的随机端口。
- 不监听局域网地址。
- 只接受隧道地址 Origin（分享启动后动态加入）与本地开发 Origin。
- 限制请求体大小。
- 文本消息设置长度上限。
- 控制请求和 Claim 接口限速。
- 长轮询连接数量设置上限。
- 无认证的健康检查不暴露 Session 信息。
- 所有失效令牌统一返回通用错误，避免枚举状态。

### 7.3 PWA 数据策略

IndexedDB 只保存：

- 当前 Endpoint。
- Share ID。
- 当前设备 ID。
- 当前 Share 的设备凭证。
- 最后接收 Cursor。

不保存：

- 对话正文。
- 工具结果。
- 用户输入历史。
- Thinking。
- Session 文件路径。

Share 失效后清除本地连接信息。

Service Worker 只缓存静态应用壳，不缓存：

```text
/v1/snapshot
/v1/events
/v1/commands
/v1/control/*
```

### 7.4 零遥测

- 前端由本机同源伺服，不经任何第三方静态托管。
- 不接入 Sentry。
- 不上传错误堆栈。
- Tunnelmole 子进程设置：

```text
TUNNELMOLE_TELEMETRY=0
TUNNELMOLE_QUIET_MODE=1
```

## 8. Tunnelmole 生命周期

不直接在 Pi 进程内调用 Tunnelmole 库，因为其 API 没有清晰的关闭句柄，且部分错误路径可能调用 `process.exit()`。

扩展应把 Tunnelmole 作为子进程启动：

```text
Pi Extension
    └── Node child_process
            └── tunnelmole CLI <local-port>
```

优势：

- `/remote stop` 可以可靠终止。
- `/reload` 和 `session_shutdown` 可清理。
- Tunnelmole 崩溃不会直接结束 Pi。
- 可以捕获 stdout 解析公网 URL。
- 可以加入启动超时。
- 未来可替换成 Cloudflare、VPS Hub 等 Adapter。

抽象接口：

```ts
interface TunnelAdapter {
  start(options: {
    localPort: number;
    signal: AbortSignal;
  }): Promise<{
    publicUrl: string;
  }>;

  stop(): Promise<void>;
}
```

MVP 只实现：

```text
TunnelmoleAdapter
```

## 9. PWA 页面结构

```text
┌───────────────────────────────────┐
│ Session 名称       远端控制/只读 │
├───────────────────────────────────┤
│                                   │
│ User Message                      │
│ Assistant Message                 │
│ Tool: bash                        │
│   ✓ 完成                          │
│   [展开结果]                      │
│                                   │
├───────────────────────────────────┤
│ Prompt / Steer / Follow-up        │
│ ┌───────────────────────────────┐ │
│ │ 输入消息                      │ │
│ └───────────────────────────────┘ │
│ [发送]              [停止运行]   │
└───────────────────────────────────┘
```

运行状态规则：

- Agent 空闲：主按钮显示“发送”。
- Agent 运行：主按钮显示“立即引导”。
- 次级操作允许“完成后执行”。
- Abort 仅在 Agent 运行时显示。
- 只读设备不显示可用输入框，改为“申请控制权”。
- 控制权被本机收回时，输入框立即禁用。
- 工具输出默认折叠，避免手机页面被长日志淹没。
- 连接中断时保留当前内存中的画面，但不允许发送命令。
- 重连成功后根据 Cursor 增量恢复；必要时重新拉取 Snapshot。

## 10. 建议目录结构

```text
pi-hapi-remote/
├── package.json
├── pnpm-workspace.yaml
├── extensions/
│   └── pi-hapi-remote/
│       ├── index.ts
│       ├── commands.ts
│       ├── session-bridge.ts
│       ├── transcript.ts
│       ├── remote-server.ts
│       ├── event-buffer.ts
│       ├── control-lease.ts
│       ├── auth.ts
│       ├── audit.ts
│       ├── tui-status.ts
│       └── tunnel/
│           ├── types.ts
│           └── tunnelmole.ts
├── shared/
│   ├── protocol.ts
│   ├── schemas.ts
│   └── version.ts
├── web/
│   ├── package.json
│   ├── vite.config.ts
│   ├── public/
│   │   ├── manifest.webmanifest
│   │   └── icons/
│   └── src/
│       ├── app/
│       ├── protocol/
│       ├── storage/
│       ├── components/
│       └── main.tsx
└── docs/
    ├── architecture.md
    ├── protocol.md
    ├── security.md
    └── release.md
```

根 `package.json`：

```json
{
  "name": "pi-hapi-remote",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": [
      "./extensions/pi-hapi-remote/index.ts"
    ]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

Tunnelmole、二维码等第三方运行时包放在 `dependencies`，前端构建依赖放在 `devDependencies`。

## 11. 实施顺序

### 第 1 阶段：本地 Session Bridge

完成：

- Pi Package 骨架。
- `/remote` 命令集。
- 当前活动分支归一化。
- Pi 事件转换为内部 Remote Event。
- Prompt、Steer、Follow-up 和 Abort。
- Session Shutdown 清理。

验收：

- 不启动隧道时，可通过 localhost 页面接管当前 Session。
- 不重启 Pi、不创建新 Session、不丢失上下文。

### 第 2 阶段：授权和控制权

完成：

- Viewer Token。
- 一次性 Claim Token。
- 本机控制申请确认。
- Controller Token。
- 单写者租约。
- TUI 状态条和收回快捷键。
- Custom Entry 审计。

验收：

- 未批准设备不能发送命令。
- Controller QR 只能兑换一次。
- 本机收回后，旧控制者的后续命令全部拒绝。

### 第 3 阶段：Tunnelmole

完成：

- 子进程启动、URL 解析和退出。
- Tunnelmole Adapter。
- 长轮询协议。
- Cursor、断线恢复和 Snapshot 重同步。
- `/remote stop` 强制清理。

验收：

- 手机使用移动网络可查看并控制当前 Session。
- Pi 退出、Reload 或切换 Session 后公网入口失效。

### 第 4 阶段：前端页面（本机同源伺服）

完成：

- React + Vite 移动页面。
- URL Fragment 连接载荷。
- PWA Manifest 和应用图标。
- Service Worker 仅缓存应用壳。
- IndexedDB 当前连接恢复。
- 工具事件折叠和运行状态显示。

验收：

- 可添加到手机主屏幕。
- 从主屏幕重新打开可恢复当前有效分享。
- 浏览器存储中不存在对话正文缓存。

### 第 5 阶段：发布加固

完成：

- 请求限速和大小限制。
- Tunnel 启动超时与异常清理。
- 协议版本检查。
- 配置项和自托管 PWA URL。
- npm/git Pi Package 发布说明。
- macOS 手工端到端验证，检查 Linux/Windows 路径兼容性。

首版不新增自动化测试；按项目约束采用手工验收清单验证关键流程。

## 12. 最终验收场景

1. 在已有 Pi 对话中执行 `/remote start`，手机看到完整活动分支，但看不到 Thinking、系统提示词和废弃分支。
2. 手机扫描 Controller QR 后直接获得控制，发送消息进入同一个 Pi Session，并能在生成过程中发送 Steer、Follow-up 和 Abort。
3. 第二台设备通过 Viewer URL 只能查看，申请控制后必须在本机批准。
4. 本机按 `Ctrl+Shift+R` 收回控制后，远端立即变为只读，旧 Controller Token 无法继续发送命令。
5. 执行 `/remote stop`、切换 Session、Reload 或退出 Pi 后，隧道子进程、长轮询请求和全部授权均被关闭。

## 13. 参考资料

- [HAPI](https://github.com/tiann/hapi)
- [Pi Extensions](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi SDK](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi RPC Mode](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/rpc.md)
- [Tunnelmole Client](https://github.com/robbie-cahill/tunnelmole-client)
- [Tunnelmole Service HTTP forwarding](https://github.com/robbie-cahill/tunnelmole-service/blob/main/src/handlers/handle-request.ts)
