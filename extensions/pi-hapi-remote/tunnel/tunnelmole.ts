/**
 * Tunnelmole Adapter：以隔离子进程运行 Tunnelmole CLI，
 * 解析 stdout 中的公网 URL，关闭遥测，支持启动超时与确定性终止。
 *
 * 选择子进程而非库 API 的原因：其库没有清晰的关闭句柄，
 * 且部分错误路径可能调用 process.exit()。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { LIMITS } from "../../../shared/protocol.js";
import type {
  TunnelAdapter,
  TunnelHandle,
  TunnelStartOptions,
} from "./types.js";

/** 解析 tunnelmole CLI 入口脚本（跨平台：直接用 node 运行 js 文件）。 */
function resolveTunnelmoleEntry(): string {
  const require = createRequire(import.meta.url);
  try {
    const pkgPath = require.resolve("tunnelmole/package.json");
    const pkg = require(pkgPath) as { bin?: Record<string, string> | string };
    const pkgDir = path.dirname(pkgPath);
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.tunnelmole;
    if (bin) {
      const entry = path.resolve(pkgDir, bin);
      if (existsSync(entry)) return entry;
    }
  } catch {
    // 包未安装：回退 npx
  }
  return "npx";
}

/** 只匹配实际分配的隧道子域（*.tunnelmole.net），排除 dashboard.tunnelmole.com 提示链接。 */
const URL_PATTERN = /https:\/\/[a-zA-Z0-9][a-zA-Z0-9-]*\.tunnelmole\.net\b/;

export class TunnelmoleAdapter implements TunnelAdapter {
  private child: ChildProcess | null = null;
  private stopped = false;

  async start(options: TunnelStartOptions): Promise<TunnelHandle> {
    if (this.child) {
      throw new Error("Tunnelmole 已在运行");
    }
    this.stopped = false;

    const entry = resolveTunnelmoleEntry();
    const useNpx = entry === "npx";
    const args = useNpx
      ? ["-y", "tunnelmole", String(options.localPort)]
      : [entry, String(options.localPort)];

    const child = useNpx
      ? spawn("npx", args, {
          env: {
            ...process.env,
            // 关闭 Tunnelmole 遥测（QUIET_MODE 会连 URL 输出一起抑制，不可设置）。
            TUNNELMOLE_TELEMETRY: "0",
          },
          stdio: ["ignore", "pipe", "pipe"],
          shell: process.platform === "win32",
        })
      : spawn(process.execPath, args, {
          env: {
            ...process.env,
            TUNNELMOLE_TELEMETRY: "0",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
    this.child = child;

    return await new Promise<TunnelHandle>((resolve, reject) => {
      let output = "";
      let settled = false;

      const finish = (error: Error | null, url?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.killChild();
          reject(error);
        } else {
          resolve({ publicUrl: url! });
        }
      };

      const onOutput = (chunk: Buffer): void => {
        output += chunk.toString("utf8");
        const match = URL_PATTERN.exec(output);
        if (match) {
          finish(null, match[0]);
        }
      };
      child.stdout?.on("data", onOutput);
      child.stderr?.on("data", onOutput);

      child.on("error", (error) => {
        finish(new Error(`Tunnelmole 启动失败：${error.message}`));
      });
      child.on("exit", (code) => {
        if (!settled && !this.stopped) {
          finish(new Error(`Tunnelmole 进程异常退出（code=${code}）：${output.slice(-500)}`));
        }
      });

      const timer = setTimeout(() => {
        finish(new Error(`Tunnelmole 启动超时（${LIMITS.tunnelStartTimeoutMs / 1000}s）`));
      }, LIMITS.tunnelStartTimeoutMs);

      options.signal.addEventListener(
        "abort",
        () => finish(new Error("Tunnelmole 启动被中止")),
        { once: true },
      );
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.killChild();
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;
    // 确定性终止：SIGTERM，短暂等待后 SIGKILL。
    child.kill("SIGTERM");
    const killer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 3_000);
    child.on("exit", () => clearTimeout(killer));
  }
}
