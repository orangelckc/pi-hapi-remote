# pi-hapi-remote

临时分享并远端控制当前 [Pi](https://github.com/earendil-works/pi-mono) 编码会话的扩展包。

在本机终端里执行 `/remote start`，扩展会在回环地址启动临时 HTTP Bridge、通过 Tunnelmole 建立公网 HTTPS 入口，并生成只读 Viewer 链接与一次性 Controller 二维码。前端页面由本机直接伺服（与 API 同源），远端设备打开链接即可查看当前活动分支，并在获得授权后接管输入。

```text
Pi 当前进程
└─ pi-hapi-remote Extension（Session Bridge + 授权 + 控制租约 + 前端静态伺服）
     └─ Local HTTP Bridge 127.0.0.1:<随机端口>
          └─ Tunnelmole 子进程（临时 HTTPS 隧道）
               ▲ 静态页面 + 长轮询 + POST（同源，全部直达本机）
               │
          远端浏览器（React + Vite + Service Worker）
```

## 特性

- **不重启 Pi**：扩展直接附着当前运行的 Session，上下文与活动分支不丢失。
- **只读 Viewer 链接**：任何持有者可观察进度，含思考过程与工具调用过程，但不能申请或取得控制权；系统提示词、废弃分支与扩展私有数据不会公开。
- **一次性 Controller QR**：第一个扫描的设备直接获得控制权，无需回到电脑二次确认。
- **单写者租约**：同一时刻至多一个远端设备写入；本机通过 `Ctrl+Shift+R` 或 `/remote reclaim` 随时收回，收回期间本机输入自动暂停避免双写；远端也可随时移交控制权回本机。
- **Steer / Follow-up / Abort**：Agent 运行中默认以 Steer 注入，可显式排队 Follow-up，或远端 Abort。
- **断线恢复**：单调递增游标 + 事件缓冲，短暂断网后增量续传；游标过期自动重同步。
- **审计**：分享开始/停止、QR 兑换、替换、收回、撤销与远端 Abort 以自定义条目记录（不进入模型上下文）。
- **零遥测**：前端由本机直接伺服，不经任何第三方静态托管；页面不缓存会话数据，IndexedDB 只保存连接凭证；Tunnelmole 遥测关闭。
- **RPC 可视化桥接**：在 Pi RPC 模式下发布版本化分享状态，供 VS Code 等宿主安全展示二维码、观察连接和控制权操作。

## 安装

```bash
# npm
pi install npm:pi-hapi-remote

# git
pi install git:github.com/orangelckc/pi-hapi-remote

# 本地开发
git clone <repo> && pnpm install
pi -e ./extensions/pi-hapi-remote/index.ts
```

## 使用

| 命令 | 说明 |
| --- | --- |
| `/remote start` | 确认数据暴露提示后开启分享，展示二维码与链接 |
| `/remote status` | 查看公网地址、观察者数量与控制权状态 |
| `/remote reclaim` | 本机收回控制权（等效 `Ctrl+Shift+R`） |
| `/remote revoke` | 撤销当前远端设备写权限（保留分享） |
| `/remote stop` | 停止分享，关闭隧道与全部授权 |
| `/remote sync` | RPC 宿主静默重新获取结构化分享状态 |

远端手机打开 Viewer 链接只能只读观察；扫描一次性控制二维码才能获得控制权。Viewer 页面不提供控制申请入口。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PI_REMOTE_WEB_DIST` | `<仓库>/web/dist` | 前端静态产物目录（存在才伺服；缺失时分享链接只提示构建引导页） |

分享前先构建前端：`pnpm build:web`（产物在 `web/dist`）。未构建时 API 仍可用，页面会提示运行构建。

## 开发

```bash
pnpm install         # 安装依赖
pnpm typecheck       # 扩展 + PWA 类型检查
pnpm dev:web         # 本地 PWA 开发服务器（localhost:5173）
pnpm build:web       # 构建 PWA（web/dist）
```

目录结构：

```text
extensions/pi-hapi-remote/   扩展（Session Bridge / 授权 / 租约 / HTTP Bridge / 隧道）
shared/                      扩展与 PWA 共享的协议模型
web/                         React + Vite PWA
docs/                        架构、协议、安全与发布说明
```

更多细节见 [docs/architecture.md](docs/architecture.md)、[docs/protocol.md](docs/protocol.md)、[docs/security.md](docs/security.md)、[docs/release.md](docs/release.md)。

## 安全要点

- 本地 Bridge 只监听 `127.0.0.1` 随机端口，局域网不可直达。
- 所有令牌（Viewer / 一次性 Claim / Controller）均为 256 位加密安全随机数，服务端只保存 SHA-256 摘要。
- 敏感连接参数位于 URL Fragment，隧道服务方请求日志不可见。
- 严格 Origin 白名单、请求体与文本长度限制、控制端点限速、并发长轮询上限。
- 分享停止、Session 切换、扩展重载或 Pi 退出时，隧道子进程与全部能力令牌同步失效。

工具输出可能包含密钥、环境变量与文件内容，本产品不做自动脱敏——分享前请自行判断（`/remote start` 时会再次提示）。

## License

MIT
