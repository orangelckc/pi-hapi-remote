# CONTEXT

pi-hapi-remote 的域语言。架构评审、命名与文档统一使用这些术语。

## 分享与会话

- **Share（分享）**：一次 `/remote start` 到 `/remote stop` 的生命周期，绑定唯一 Session 与全部令牌。
- **Session Bridge（会话桥）**：附着 Pi 生命周期、重建活动分支快照、注入命令并校验 Session 身份的模块。
- **Transcript Projector（转录投影）**：把 Session entries 与实时事件转换为可公开 `RemoteEntry` 的模块；系统提示词、废弃分支与扩展私有数据在此统一过滤。
- **Event Journal（事件日志）**：单调游标 + 环形缓冲 + 长轮询等待者；投影重建后要求观察者重同步。
- **Entry Log（条目日志）**：按插入序维护的条目集合（shared 模块），服务端投影与 PWA 归约共用的唯一实现。

## 控制权

- **Capability Authority（能力授权）**：Viewer / 一次性 Claim / Controller 令牌的签发与校验；只保存摘要。
- **Control Lease（控制租约）**：纯租约状态机——单写者归属与变化通知，不编排副作用。
- **Control Flow（控制流转）**：控制权的唯一编排点。Claim 兑换、申请审批、远端移交、本机收回与撤销五种流转在此完成「租约变更 ⇒ 令牌轮换/撤销 ⇒ 审计 ⇒ control_state 广播」的完整协同；Gateway 只按令牌发起流转。

## 传输与前端

- **Remote Bridge（远端桥）**：本地回环 HTTP 服务 + Command Gateway（路由、鉴权、限速）。
- **Static Frontend（静态前端）**：同源伺服 web/dist 的独立模块（MIME、缓存头、gzip、路径穿越防护）；未配置时返回构建引导页。
- **Tunnel Adapter（隧道适配器）**：`start/stop` 契约；当前唯一适配器为 Tunnelmole。
- **Remote Chat View（远端会话视图）**：PWA 聊天界面对远端会话的唯一视图接口（状态 + 消息 + 动作）；生产由 `useRemoteChat` 提供，开发预览由静态适配器提供。UI 层不接触 connection / transport。

## 客户端角色

- **Viewer（观察者）**：持有 Viewer Token 的只读设备。
- **Controller（控制者）**：持有 Controller Token 的写租约设备；获得途径为一次性 Claim 兑换或本机审批。
