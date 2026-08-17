# 发布说明

## Pi Package 结构

根 `package.json` 即 Pi Package 清单：

```json
{
  "name": "pi-hapi-remote",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions/pi-hapi-remote/index.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "dependencies": { "qrcode": "^1.5.4", "tunnelmole": "^2.2.0" }
}
```

- 扩展源码以 TypeScript 直接分发（Pi 通过 jiti 加载，无需预编译）。
- `qrcode`（QR 渲染）与 `tunnelmole`（CLI 子进程）为运行时依赖，位于 `dependencies`，`pi install` 时自动安装。
- Pi 核心包声明为 `peerDependencies`（Pi 打包提供，不重复捆绑）。

## 发布到 npm

```bash
pnpm typecheck          # 必须通过
pnpm build:web          # 可选：同时刷新 PWA 产物（web/dist 不随 npm 包分发）
npm publish             # files 字段外的内容不会发布；确认 .npmignore/未配置 files 时包含
```

发布前检查：

1. `package.json` 的 `version` 已递增。
2. `npx tsc --noEmit` 与 `pnpm --filter pi-hapi-remote-web typecheck` 通过。
3. `pi -e ./extensions/pi-hapi-remote/index.ts` 实际加载无错误。

安装：

```bash
pi install npm:pi-hapi-remote
```

## 发布到 Git

```bash
git tag v0.1.0 && git push --tags
pi install git:github.com/<you>/pi-hapi-remote@v0.1.0
```

Pi 克隆仓库后在根目录执行安装（读取根 `package.json` 的 `dependencies`）。

## PWA 部署（Vercel）

```bash
cd web && pnpm build     # 产物 web/dist
vercel deploy --prod     # 或推送 GitHub 后导入，配置见 web/vercel.json
```

默认分享链接基址为 `https://pi-hapi-remote.vercel.app/`。自托管：

1. 将 `web/dist` 部署到任意 HTTPS 静态托管。
2. 启动 Pi 前设置 `PI_REMOTE_PWA_URL=https://your-host.example.com/`。

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

### 0.1.0

MVP：

- `/remote start|status|reclaim|revoke|stop` 命令集与 `Ctrl+Shift+R` 收回快捷键。
- 本地 Session Bridge：活动分支归一化、实时事件（含流式正文与工具状态）、Prompt/Steer/Follow-up/Abort 注入。
- 能力令牌（Viewer/一次性 Claim/Controller，SHA-256 摘要保管）与单写者控制租约。
- Tunnelmole 子进程隧道（30s 启动超时、确定性终止、遥测关闭）。
- Snapshot + 长轮询（25s）+ 游标断线恢复 + 过期重同步。
- Vercel 静态 PWA：Fragment 连接、IndexedDB 凭证恢复、工具折叠、断线禁用输入、可安装。
- 限速、请求体限制、Origin 白名单、命令幂等、协议版本检查、审计条目。
