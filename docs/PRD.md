# PRD：Pi HAPI Remote MVP

## Problem Statement

Pi 用户在桌面终端中运行长时间编码任务时，无法方便地从手机、平板或另一台电脑继续查看和控制当前会话。离开电脑后，用户通常只能等待任务结束，或者通过通用远程桌面操作整个终端；前者缺少及时反馈和纠偏能力，后者操作笨重、暴露范围过大，并且不理解 Pi 的消息、工具调用、Steer、Follow-up 和 Abort 等原生语义。

用户需要一种随时开启、无需部署专用中转服务器的临时分享方式。远端设备应能查看同一个 Pi Session 的活动分支（含思考过程与工具调用过程，即完整转发所有消息），并在获得授权后接管输入和中止能力；本机用户必须保留最终控制权，能够随时撤销远端权限。分享过程还必须避免公开系统提示词、废弃分支和扩展私有数据，并确保固定托管的前端不会接触或保存会话内容。

## Solution

提供一个可发布安装的 Pi Package，其中包含直接附着到当前 Pi Session 的扩展。用户执行 `/remote start` 后，扩展在本机回环地址启动临时 HTTP Bridge，通过 Tunnelmole 建立公网 HTTPS 入口，并生成只读 Viewer URL 和一次性 Controller QR。

远端用户通过部署在 Vercel 固定域名上的移动端 PWA 连接临时入口。PWA 仅作为静态客户端运行，会话快照、增量事件和控制命令均在远端浏览器与本机扩展之间直接传输，不经过 Vercel 服务端。由于 Tunnelmole 不适合承载入站 WebSocket 或持续 SSE，MVP 使用 HTTP 长轮询接收事件、使用 POST 发送命令，并通过单调递增 Cursor 支持断线恢复。

Viewer URL 持有者默认只有当前活动分支的读取权限，可以申请控制权；Controller QR 包含只能兑换一次的 Claim Capability，便于用户在离开电脑前直接为自己的手机完成授权。任何时刻只允许一个远端设备持有写租约。本机通过醒目的控制状态条、快捷键和 `/remote reclaim` 命令随时收回控制。

远端控制者可以发送普通 Prompt；Agent 运行时默认发送 Steer，也可以明确选择 Follow-up，并可以执行 Abort。分享停止、Session 切换、扩展重载或 Pi 退出时，本地服务、隧道进程和所有能力令牌必须同步失效。

## User Stories

1. As a Pi 用户, I want to 临时分享当前正在运行的 Session, so that 我可以离开电脑后继续查看任务进度。
2. As a Pi 用户, I want to 在不重启 Pi 的情况下开启远端访问, so that 当前上下文、活动分支和运行状态不会丢失。
3. As a Pi 用户, I want to 通过单个命令开启分享, so that 我不需要手动启动本地服务器或隧道程序。
4. As a Pi 用户, I want to 在开启分享前看到明确的数据暴露提示, so that 我能够判断当前对话是否适合公开给链接持有者。
5. As a Pi 用户, I want to 获得一个只读 Viewer URL, so that 我可以让其他人观察进度但不能直接修改会话。
6. As a Pi 用户, I want to 获得一个一次性 Controller QR, so that 我可以在离开电脑前快速授权自己的手机接管会话。
7. As a 手机用户, I want to 扫描 Controller QR 后直接获得控制权, so that 我不需要回到本机终端完成第二次确认。
8. As a Viewer URL 持有者, I want to 默认以只读身份进入, so that 持有普通分享链接不会自动获得修改权限。
9. As a 只读观察者, I want to 申请控制权, so that 在本机用户同意后我可以参与当前会话。
10. As a Pi 用户, I want to 在本机看到控制权申请及设备信息, so that 我可以判断是否批准该设备。
11. As a Pi 用户, I want to 明确确认是否替换当前控制者, so that 第二台设备不会无提示地夺走控制权。
12. As a Pi 用户, I want to 同时允许多个只读观察者, so that 多个设备或协作者可以一起查看进度。
13. As a Pi 用户, I want to 任意时刻只允许一个远端写入者, so that 并发输入不会破坏 Agent 状态或命令顺序。
14. As a Pi 用户, I want to 在远端接管时看到醒目的本机状态条, so that 我始终知道当前由哪个设备控制。
15. As a Pi 用户, I want to 通过快捷键立即收回控制权, so that 出现错误操作时我可以快速停止远端继续输入。
16. As a Pi 用户, I want to 通过 `/remote reclaim` 收回控制权, so that 即使快捷键不可用也有可靠的命令入口。
17. As a Pi 用户, I want to 在远端控制期间阻止普通本机输入, so that 本机和远端不会形成双写竞态。
18. As a 远端观察者, I want to 查看当前活动分支中的用户消息, so that 我能理解任务背景和已有要求。
19. As a 远端观察者, I want to 查看助手的可见正文, so that 我能跟踪 Agent 的分析结果和回答。
20. As a 远端观察者, I want to 实时看到工具调用状态, so that 我知道 Agent 正在读文件、修改代码还是执行命令。
21. As a 远端观察者, I want to 展开查看工具参数和结果, so that 我能判断执行行为及其输出是否正确。
22. As a 远端观察者, I want to 默认折叠较长的工具结果, so that 手机页面不会被大量日志占满。
23. As a 远端观察者, I want to 查看助手思考过程（Thinking）与错误信息, so that 我能完整跟踪模型的推理与分析过程（协议 v2 起取代早期"排除 Thinking"的需求）。
24. As a Pi 用户, I want to 排除系统提示词, so that Pi 和扩展的内部指令不会被分享。
25. As a Pi 用户, I want to 排除废弃分支, so that 远端只看到当前正在使用的会话路径。
26. As a Pi 用户, I want to 排除扩展私有数据和不必要的本机路径元数据, so that 分享范围保持最小化。
27. As a 远端控制者, I want to 在 Agent 空闲时发送普通 Prompt, so that 我可以开始下一项工作。
28. As a 远端控制者, I want to 在 Agent 运行时默认发送 Steer, so that 我能及时纠正当前任务方向。
29. As a 远端控制者, I want to 主动选择 Follow-up, so that 新要求可以等待当前任务结束后再执行。
30. As a 远端控制者, I want to Abort 当前运行, so that 我能阻止错误、危险或不再需要的操作继续进行。
31. As a 远端控制者, I want to 在连接中断时禁止发送命令, so that 不确定状态下不会生成重复或乱序操作。
32. As a 远端控制者, I want to 在刷新页面或短暂断网后恢复当前分享, so that 移动网络切换不会迫使我重新审批。
33. As a 远端观察者, I want to 在重连后从最后 Cursor 继续接收事件, so that 不需要每次重新加载全部会话。
34. As a 远端观察者, I want to 在 Cursor 已过期时自动重新同步 Snapshot, so that 页面能够从事件缓冲区缺口中恢复。
35. As a Pi 用户, I want to 防止网络重试重复提交同一条 Prompt, so that 一次点击只会在 Session 中产生一条用户消息。
36. As a Pi 用户, I want to 让控制凭证只在当前 Share 生命周期有效, so that 旧设备无法在后续分享中自动获得权限。
37. As a Pi 用户, I want to 撤销当前远端设备, so that 我可以保留分享页面但取消其写权限。
38. As a Pi 用户, I want to 一次性停止分享, so that 隧道、连接和所有授权能够立即关闭。
39. As a Pi 用户, I want to 在 Session 切换时自动停止分享, so that 原 Session 的能力令牌不会错误控制新 Session。
40. As a Pi 用户, I want to 在扩展重载或 Pi 退出时自动终止 Tunnelmole 子进程, so that 不会留下失控的公网入口。
41. As a Pi 用户, I want to 查看当前分享状态, so that 我能确认公网地址、观察者数量和控制设备。
42. As a Pi 用户, I want to 在 Session 中保留分享开始、批准、撤销、接管和 Abort 的审计事件, so that 我能够事后识别关键远端控制行为。
43. As a Pi 用户, I want to 让审计事件不进入模型上下文, so that 控制元数据不会改变模型行为。
44. As a 移动端用户, I want to 使用响应式聊天界面, so that 消息、工具状态和输入控件适合手机屏幕。
45. As a 移动端用户, I want to 将远端界面安装到主屏幕, so that 我可以像应用一样快速重新打开当前分享。
46. As a PWA 用户, I want to 只保存当前连接信息而不保存对话正文, so that 可以恢复连接同时减少敏感数据落盘。
47. As a PWA 用户, I want to 在分享失效后自动清除连接凭证, so that 无效令牌不会长期留在设备上。
48. As a Pi 用户, I want to 让敏感分享参数位于 URL Fragment, so that Vercel 请求日志不会收到 Endpoint 和能力令牌。
49. As a Pi 用户, I want to 让 Vercel 只提供静态资源, so that 会话正文不会经过固定托管服务端。
50. As a Pi 用户, I want to 禁用分析、遥测和第三方错误上报, so that 使用情况和会话元数据不会被额外收集。
51. As a Pi 用户, I want to 让本地 Bridge 只监听回环地址, so that 局域网设备不能绕过隧道授权直接访问接口。
52. As a Pi 用户, I want to 对请求体、消息长度、控制申请和长轮询连接进行限制, so that 临时公网入口不容易被滥用或耗尽资源。
53. As a Pi 用户, I want to 使用加密安全的能力令牌并只在服务端保存摘要, so that 内存泄漏或状态检查不会直接暴露可用凭证。
54. As a Pi 用户, I want to 将 Tunnelmole 运行在隔离子进程中, so that 隧道错误不会直接退出 Pi 主进程。
55. As a Pi 用户, I want to 使用可替换的 Tunnel Adapter, so that 后续可以增加 Cloudflare 或自托管 Hub，而不改动 Session 控制逻辑。
56. As a Pi Package 使用者, I want to 通过 npm 或 Git 安装扩展, so that 不需要复制本机固定路径或手工维护依赖。
57. As a Pi Package 维护者, I want to 保持 Node 和平台路径可移植, so that macOS 首验后可以继续支持 Linux 和 Windows。
58. As a 自托管用户, I want to 覆盖默认 PWA 地址, so that 我可以在自己的固定域名部署相同静态客户端。

## Implementation Decisions

- 产品由 Pi 扩展、本地 Remote Bridge、Tunnel Adapter、共享协议模型和移动端 PWA 五个主要部分组成。
- Pi 扩展直接附着到已经运行的当前 Session，而不是启动新的 Pi RPC 子进程。Session 是消息和运行状态的唯一事实来源。
- Session Bridge 作为深模块封装 Pi 生命周期事件、活动分支快照、事件归一化、命令注入和 Session 身份校验。外部模块只接触稳定的 Snapshot、Remote Event 和 Remote Command 接口。
- Transcript Projector 作为深模块把 Pi Session entries 和实时生命周期事件转换为可公开的远端表示，并统一过滤系统提示词、废弃分支、扩展私有数据和不必要的路径元数据；Thinking 正文与助手错误信息随助手条目转发（协议 v2 起）。
- Event Journal 作为深模块维护单调递增 Cursor、有限容量事件缓冲区、长轮询等待者和重同步判定。它不感知 HTTP、PWA 或 Pi API。
- Capability Authority 作为深模块负责 Viewer Token、一次性 Claim Token、Controller Token、设备身份、令牌摘要、过期和撤销。令牌使用至少 256 位加密安全随机数生成。
- Control Lease 作为深模块维护单远端写入者规则、批准状态、替换控制者、本机收回和 Share 生命周期失效。多个观察者可以并存，但只有当前租约持有者可以发送控制命令。
- Command Gateway 作为深模块执行命令鉴权、Session 身份检查、幂等去重、状态校验和 Pi API 调用。网络重试必须依靠客户端命令 ID 防止重复 Prompt。
- Remote Bridge 只监听随机的 `127.0.0.1` 端口，提供 Snapshot、长轮询事件、控制申请、一次性 Claim 兑换、命令提交和最小健康检查接口。
- Snapshot 接口返回当前活动分支的归一化条目、Agent 状态、控制权状态和当前 Cursor。
- Events 接口使用最长约 25 秒的 HTTP 长轮询。有事件时立即返回；Cursor 超出缓冲区时要求客户端重新读取 Snapshot。
- Commands 接口只接受当前 Controller Token。支持 Prompt、Steer、Follow-up 和 Abort 四种命令。
- Agent 空闲时，远端主发送行为是普通 Prompt；Agent 运行时，主发送行为默认是 Steer；Follow-up 作为明确的次级选择。
- Viewer URL 只包含 Viewer Capability；Controller QR 额外包含只能兑换一次的 Claim Capability。所有敏感连接参数位于固定 PWA URL 的 Fragment 中。
- 普通 Viewer 可以申请控制权。扩展在本机显示设备申请，批准后签发当前 Share 有效的 Controller Capability；批准第二台设备时必须明确替换现有控制者。
- 控制设备刷新或短暂断网后，可以凭当前 Share 的设备凭证恢复。停止分享、撤销设备、切换 Session、扩展重载或 Pi 退出后凭证全部失效。
- 远端控制期间阻止本机普通输入，避免双写；本机通过醒目状态条、快捷键或 `/remote reclaim` 收回控制。
- 关键控制事件以不进入模型上下文的 Session 自定义条目记录，包括分享开始和停止、设备申请和批准、撤销、控制权转移及远端 Abort。普通远端 Prompt 仍表现为正常用户消息。
- Tunnelmole 通过子进程运行，不在 Pi 主进程中直接调用其库 API。子进程必须支持启动超时、URL 解析、异常检测和确定性终止，并关闭 Tunnelmole 遥测。
- Tunnel Adapter 提供稳定的 Start/Stop 抽象。MVP 只实现 Tunnelmole，但 Session、授权和协议模块不得依赖具体隧道供应商。
- 由于 Tunnelmole 的完整 HTTP 响应转发模型不适合入站 WebSocket 或持续 SSE，MVP 使用长轮询与 POST；协议应保留未来增加 WebSocket Transport 的空间。
- PWA 使用 React、TypeScript、Vite 和 PWA 构建能力，部署到 Vercel 固定域名。Vercel 只托管静态资源，不提供会话 API。
- PWA Service Worker 只缓存应用壳，不缓存 Snapshot、Events、Commands 或 Control 请求及响应。
- PWA 的 IndexedDB 只保存当前 Endpoint、Share ID、设备信息、当前 Share 凭证和最后 Cursor，不保存对话正文、工具结果或输入历史。Share 失效后清除连接信息。
- 远端工具结果默认折叠；连接断开时保留内存中的当前画面但禁用控制操作；重连后优先增量同步，必要时重新获取 Snapshot。
- 本地服务执行严格 Origin 校验、请求体限制、文本长度限制、控制端点限速和并发长轮询限制。健康检查不得暴露 Session 或授权状态。
- 项目以可发布 Pi Package 组织，可通过 npm 或 Git 安装；macOS 作为首要验收平台，但运行时代码不得绑定本机绝对路径，并应保持 Linux 和 Windows 可移植性。
- MVP 提供 `/remote start`、`/remote status`、`/remote reclaim`、`/remote revoke` 和 `/remote stop` 命令。

## Testing Decisions

- 当前仓库只有实施计划，没有既有测试基础设施或可参考的同类测试；按照已确认的项目约束，MVP 不新增自动化测试功能。
- 验收以外部可见行为为准，不检查模块内部字段、私有函数或具体框架实现。
- Session Bridge 的手工验收应覆盖：附着当前 Session、读取活动分支、接收消息和工具生命周期、注入 Prompt/Steer/Follow-up、执行 Abort，以及 Session 切换和退出时清理。
- Transcript Projector 的手工验收应覆盖：展示用户消息、助手可见正文、思考过程与错误信息、工具调用和工具结果；排除系统提示词、废弃分支、扩展私有条目和不必要的路径元数据。
- Event Journal 的手工验收应覆盖：新事件立即唤醒长轮询、Cursor 连续增长、断线后增量恢复、Cursor 过期后触发完整重同步。
- Capability Authority 和 Control Lease 的手工验收应覆盖：Viewer 只读、Claim 只能兑换一次、未批准设备不能写、单控制者、控制替换、本机收回、撤销和 Share 结束后旧令牌失效。
- Command Gateway 的手工验收应覆盖：命令 ID 去重、错误 Session 拒绝、无租约拒绝、运行中默认 Steer、明确 Follow-up 和 Abort。
- Tunnel Adapter 的手工验收应覆盖：公网 URL 成功产生、Tunnelmole 异常不会退出 Pi、停止分享后子进程退出、Reload 和 Pi 退出后不残留公网入口。
- PWA 的手工验收应覆盖：移动端响应布局、安装到主屏幕、Fragment 解析、当前连接恢复、工具结果折叠、断线禁用输入、控制权变化即时反映，以及浏览器存储中不存在对话正文。
- 安全验收应使用无令牌、错误令牌、过期令牌、错误 Origin、超长正文、重复命令和过多长轮询连接验证拒绝行为。
- 端到端验收应至少使用一台运行 Pi 的 macOS 设备、一台移动网络下的手机和第二个只读浏览器，验证 Viewer、Controller QR、控制申请、收回和停止分享完整流程。

## Out of Scope

- 图片、截图或任意文件附件上传。
- 远端工具权限审批和交互式工具确认。
- 远端切换模型、Provider、Thinking Level 或 Steering Mode。
- Compact、Fork、Tree、Resume、Rewind 和跨 Session 导航。
- 多个远端设备同时写入。
- 固定 VPS Hub、离线消息、推送通知和后台队列。
- 系统提示词、废弃分支和扩展私有数据展示。
- 启发式密钥或工具输出自动脱敏。
- 对话正文及工具输出的离线持久化。
- 长期可信设备和跨 Share 自动授权。
- Vercel 服务端 API、会话中转、分析、遥测或第三方错误上报。
- Cloudflare Tunnel、固定自定义隧道域名或其他 Tunnel Adapter 的具体实现。
- 完整桌面端双栏布局和高级会话管理界面。
- 自动化测试基础设施。

## Further Notes

- 当前代码库尚未初始化应用骨架，只有 MVP 架构与实施计划文档，因此所有模块均为新增模块，没有历史兼容或迁移要求。
- 分享模型是“持有 Viewer URL 即可读取当前活动分支，写权限需要一次性 Controller Claim 或本机批准”。开启分享前必须明确告知用户工具输出可能包含密钥、环境变量和文件内容；MVP 不提供可能漏报或误报的自动脱敏。
- 固定 PWA 地址的默认部署目标是 Vercel，同时应允许用户配置自托管静态 PWA URL。
- 首版 Tunnelmole Transport 的长轮询限制是已知架构约束。未来增加支持 WebSocket 的隧道或自托管 Hub 时，应复用相同的 Snapshot、Remote Event、Remote Command、Capability Authority 和 Control Lease 语义。
- 建议按五个垂直阶段交付：本地 Session Bridge、授权与控制权、Tunnelmole 公网传输、Vercel PWA、发布与安全加固。
- 最终验收要求：手机能查看同一个当前 Session、获得授权后执行 Prompt/Steer/Follow-up/Abort、本机能立即收回、未授权设备无法写入、分享停止或 Session 变化后所有公网能力失效。
