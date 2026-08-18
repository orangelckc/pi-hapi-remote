# 发布说明

## Pi Package 结构

根 `package.json` 指向预构建入口，只发布 `dist/`、README 与许可证：

```json
{
  "name": "pi-hapi-remote",
  "keywords": ["pi-package"],
  "files": ["dist", "README.md", "LICENSE"],
  "pi": { "extensions": ["./dist/index.mjs"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

发布目录：

```text
dist/
├── index.mjs                  扩展单文件（包含 qrcode）
├── vendor/
│   ├── tunnelmole.cjs         Tunnelmole CLI 单文件
│   └── tunnelmole.cjs.LEGAL.txt
└── web/                       已构建 PWA
```

- `dist/` 由 `prepack` 在发布前生成并被 Git 忽略，不进入仓库历史。
- `qrcode` 与 `tunnelmole` 只存在于 `devDependencies`，构建时由 esbuild 打入发布产物。
- 发布包没有 `dependencies`，`pi install npm:...` 不再下载第三方运行时依赖。
- Pi 核心包声明为 `peerDependencies` 并保持外置，由 Pi 运行时提供。

## 发布到 npm

```bash
pnpm build:package      # 类型检查、构建 PWA、生成 dist
npm pack --dry-run      # 确认只包含发布产物
npm publish             # prepack 会再次执行完整构建
```

发布前检查：

1. `package.json` 的 `version` 已递增。
2. `pnpm build:package` 通过。
3. `npm pack --dry-run` 中不存在 `web/src`、`extensions`、`docs` 或锁文件。
4. 使用生成的 tgz 执行 `pi -e npm:./pi-hapi-remote-x.y.z.tgz`，确认实际加载无错误。

安装：

```bash
pi install npm:pi-hapi-remote
```

## 前端（本机同源伺服）

分享链接直接指向隧道地址，前端静态产物由本机 Remote Bridge 同源伺服，无需部署任何静态托管：

```bash
pnpm build:web          # 源码开发产物 web/dist
pnpm build:package      # 发布产物 dist/web
```

- npm 发布入口自动读取 `dist/web`；源码入口自动读取 `web/dist`，也可用 `PI_REMOTE_WEB_DIST` 覆盖。
- 未构建产物时分享仍可用（API 正常），页面返回构建提示；开发时可用 `pnpm dev:web`（localhost:5173，已在 Origin 白名单）。
- 注意：隧道地址每次分享都变化，主屏安装的 PWA 图标不跨会话保留。

## 手工验收清单（macOS 首验）

在真实 Pi 会话中逐项验证：

- [ ] `/remote start`：出现数据暴露确认；确认后输出公网地址、Viewer 链接与控制二维码。
- [ ] 手机（移动网络）打开 Viewer 链接：看到完整活动分支与思考过程；看不到系统提示词、废弃分支。
- [ ] 手机扫描 Controller QR：直接获得控制（页面显示"我在控制"）；第二台设备再扫同一 QR 无效。
- [ ] 控制设备空闲时发送 Prompt：进入同一 Session；运行中默认按钮为"立即引导"（Steer），可"完成后执行"（Follow-up）与"停止运行"（Abort）。
- [ ] 远端控制期间本机输入被拦截并有提示；`Ctrl+Shift+R` 收回后远端立即只读、旧命令被拒。
- [ ] 第二设备（Viewer）申请控制：本机弹出含设备信息的确认（含替换提示）；批准后可控制。
- [ ] `/remote revoke`：远端立即只读；分享仍可用。
- [ ] 断网/刷新：控制设备恢复后仍可控制；观察者从最后游标续传；长断线后自动重同步 Snapshot。
- [ ] `/remote stop`、`/new`、`/resume`、`/reload`、退出 Pi：隧道子进程退出（`ps` 无残留 tunnelmole）、旧链接立即失效、长轮询收到结束。
- [ ] 浏览器 DevTools：IndexedDB 无对话正文；Application → Cache Storage 只有应用壳。
- [ ] 审计条目在 transcript 中可见（分享开始/批准/收回等）。

## 平台兼容性

- **macOS**：首要验收平台（本清单）。
- **Linux**：预期直接可用——无平台专属 API（`node:http`、`node:child_process`、`node:crypto`）；Tunnelmole 与 qrcode 均跨平台。
- **Windows**：代码层面已处理（npx 回退路径使用 `shell: true`；路径一律 `node:path`）；`Ctrl+Shift+R` 快捷键与终端渲染待实测。

## 版本历史

### 0.2.0

- 前端改为本机同源伺服（移除固定静态托管依赖），会话数据不经任何第三方。
- 手机端界面重构（Vercel AI SDK 视图模型 + shadcn/ui）。
- 协议 v2：转发思考过程与助手错误信息。
- 远端可主动移交控制权回本机；观察者彻底只读化。
- RPC 可视化状态桥接：RPC 模式下发布版本化分享状态，供 VS Code 等宿主展示。
- 流式更新合并窗口，降低高频全量更新带来的延迟。
- 修复：纯工具调用轮次残留空白助手气泡；发送后界面黑屏；同源无 Origin 头请求被误拒。
- 架构深化：控制流转收拢至 Control Flow、静态伺服拆分为独立模块、条目日志统一。

### 0.1.0

MVP：

- `/remote start|status|reclaim|revoke|stop` 命令集与 `Ctrl+Shift+R` 收回快捷键。
- 本地 Session Bridge：活动分支归一化、实时事件（含流式正文与工具状态）、Prompt/Steer/Follow-up/Abort 注入。
- 能力令牌（Viewer/一次性 Claim/Controller，SHA-256 摘要保管）与单写者控制租约。
- Tunnelmole 子进程隧道（30s 启动超时、确定性终止、遥测关闭）。
- Snapshot + 长轮询（25s）+ 游标断线恢复 + 过期重同步。
- 本地伺服前端：同源访问、Fragment 连接、工具折叠、断线禁用输入、gzip 传输与静态资源缓存。
- 限速、请求体限制、Origin 白名单、命令幂等、协议版本检查、审计条目。
