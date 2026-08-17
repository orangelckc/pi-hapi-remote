# 安全设计

## 威胁模型

- **链接泄漏**：Viewer URL 被转发给第三方 → 只读暴露当前活动分支（这正是产品语义）；控制权仍需一次性 Claim 或本机批准。
- **固定托管方**：Vercel 只提供静态 PWA 壳。会话快照、事件与命令均在浏览器与本地扩展之间直接传输（经 Tunnelmole 隧道），不经过 Vercel 服务端；敏感参数位于 URL Fragment，不出现在其请求日志中。
- **局域网**：本地 Bridge 只监听 `127.0.0.1` 随机端口，局域网设备必须经过隧道授权链路。
- **恶意网站**（跨站请求）：严格 Origin 白名单（默认 PWA 域名 + 本地开发地址），无 Origin 或非白名单一律 `403`；预检与响应只回显白名单 Origin。
- **令牌窃取**（内存/状态泄漏）：服务端只保存 SHA-256 摘要；摘要比较使用 `timingSafeEqual`。
- **重放/重复提交**：命令携带客户端 ID，服务端 500 条 LRU 去重；网络重试复用同 ID。
- **资源耗尽**：请求体 256KB 上限、文本 10 万字符上限、控制端点 30 次/分钟限速、32 并发长轮询上限（超出返回空批而非报错）。

## 能力令牌

每次 `/remote start` 重新生成（256 位 `crypto.randomBytes`，前缀 `phr1_`）：

| 令牌 | 权限 | 失效 |
| --- | --- | --- |
| `viewerToken` | 读取 Snapshot/Events；申请控制 | 分享结束 |
| `claimToken` | 一次 Claim 兑换 | 兑换即作废或分享结束 |
| `controllerToken` | 读取 + 命令提交 | 收回/撤销/替换/分享结束 |

所有失效令牌统一返回通用 `401`，不区分原因，避免枚举。

## 控制权

- 单写者租约：任意时刻至多一个远端设备持有。
- Claim 兑换 = 本机用户的预先授权（QR 一次性）。
- Viewer 申请控制需本机确认；已有控制者时明确显示替换提示。
- 远端控制期间本机普通输入被拦截（`source === "extension"` 的注入放行），`Ctrl+Shift+R` / `/remote reclaim` 立即收回。
- 收回后旧 Controller Token 立即失效，后续命令全部拒绝。

## 数据最小化

远端只接触：

- 用户消息、助手可见正文、工具名/参数预览/结果（均截断）。
- Agent 运行状态、控制权状态、会话名与 cwd 尾段标签。

不接触：Thinking、系统提示词、废弃分支、`custom`/`custom_message` 扩展私有数据、Session 文件路径与本机绝对路径。

PWA 存储（IndexedDB）只保存 Endpoint、Share ID、设备 ID/标签、当前凭证与最后游标；不保存对话正文、工具结果或输入历史。Share 失效（`share_ended` / `401`）自动清除。

Service Worker 只 precache 应用壳；跨域 API 请求不拦截、不缓存。

## 审计

以下事件以自定义条目持久化在 Session 中（不进入模型上下文）：分享开始/停止、控制权申请（含批准/拒绝）、QR 兑换、控制者替换、本机收回、撤销设备、远端 Abort。

## 隧道

- Tunnelmole 运行于隔离子进程，崩溃不影响 Pi 主进程。
- `TUNNELMOLE_TELEMETRY=0` 关闭遥测。
- 停止/重载/切换 Session/退出 Pi 均确定性终止子进程（SIGTERM → 3s → SIGKILL）。
- 健康检查 `/v1/health` 只返回 `{ok, protocolVersion}`，不暴露 Session 或授权状态。

## 已知限制（MVP）

- Tunnelmole 免费版 URL 为随机子域且依赖其公共服务可用性。
- 长轮询模型不适合高频流式推送（事件批量粒度受轮询间隔影响）。
- 工具输出不做自动脱敏（可能包含密钥/环境变量/文件内容），`/remote start` 时向用户明确提示。
