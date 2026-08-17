/**
 * Remote Bridge（本地 HTTP 服务）+ Command Gateway。
 *
 * 只监听 127.0.0.1 随机端口，同时伺服前端静态产物（web/dist）与
 * Snapshot、长轮询事件、命令提交、一次性 Claim 兑换与控制权申请接口。
 * API 执行严格 Origin 校验、请求体限制、文本长度限制、控制端点限速
 * 与并发长轮询限制；静态资源不做 Origin 校验（顶级导航无 Origin 头）。
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { createGzip, gzip } from "node:zlib";
import {
  ERROR_CODES,
  LIMITS,
  PROTOCOL_VERSION,
  type DeviceInfo,
  type EventBatch,
  type RemoteCommand,
  type RemoteState,
} from "../../shared/protocol.js";
import { validateDeviceInfo, validateRemoteCommand } from "../../shared/schemas.js";
import { CapabilityAuthority } from "./auth.js";
import { ControlLease } from "./control-lease.js";
import { EventJournal } from "./event-buffer.js";
import { SessionBridge } from "./session-bridge.js";

export type ApprovalDecision = "approved" | "denied" | "timeout";

export interface RemoteServerDeps {
  auth: CapabilityAuthority;
  lease: ControlLease;
  journal: EventJournal;
  bridge: SessionBridge;
  /** 允许的浏览器 Origin（隧道公网地址与本地开发地址）。 */
  allowedOrigins: string[];
  /** 前端静态产物目录（web/dist）；为 null 时返回构建提示页。 */
  staticDir: string | null;
  /** 触发本机审批对话。currentControllerLabel 非空时表示将替换现有控制者。 */
  requestApproval: (
    device: DeviceInfo,
    currentControllerLabel: string | undefined,
  ) => Promise<ApprovalDecision>;
  /** 远端 Abort 审计回调。 */
  onRemoteAbort: (deviceLabel: string) => void;
  /** 控制权授予回调（审计 + 事件发布由上层统一处理）。 */
  onControllerGranted: (device: DeviceInfo, kind: "claimed" | "request_approved") => void;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

const gzipAsync = promisify(gzip);

/** 常见前端产物 MIME 类型。 */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/** 可 gzip 压缩的文本类扩展名。 */
const COMPRESSIBLE_EXTS = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".svg",
  ".webmanifest",
  ".txt",
]);

/** 未构建前端时的提示页。 */
const MISSING_DIST_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Pi HAPI Remote</title>
<p>前端产物未构建：请在仓库内运行 <code>pnpm build:web</code> 后重新分享，
或设置 <code>PI_REMOTE_WEB_DIST</code> 指向已构建的目录。</p>`;

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > LIMITS.maxBodyBytes) {
    throw new HttpError(413, ERROR_CODES.payloadTooLarge, "请求体过大");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > LIMITS.maxBodyBytes) {
      throw new HttpError(413, ERROR_CODES.payloadTooLarge, "请求体过大");
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, ERROR_CODES.badRequest, "无效 JSON");
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class RemoteBridgeServer {
  private server: http.Server | null = null;
  private portValue: number | null = null;
  private deps: RemoteServerDeps;
  private rateBuckets = new Map<string, RateBucket>();
  private closed = false;

  constructor(deps: RemoteServerDeps) {
    this.deps = deps;
  }

  get port(): number | null {
    return this.portValue;
  }

  /** 是否已配置前端静态产物目录。 */
  get hasStaticFrontend(): boolean {
    return this.deps.staticDir !== null;
  }

  async start(): Promise<number> {
    if (this.server) return this.portValue!;
    this.closed = false;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        void this.sendError(res, error);
      });
    });
    // 请求超时保护：长轮询 25s + 处理余量。
    server.requestTimeout = 60_000;
    server.headersTimeout = 35_000;
    // 空闲 keep-alive 覆盖长轮询周期，减少经隧道中继的重复 TCP/TLS 握手。
    server.keepAliveTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("无法绑定本地端口");
    }
    this.server = server;
    this.portValue = address.port;
    return address.port;
  }

  async stop(): Promise<void> {
    this.closed = true;
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // 长轮询连接由 journal.close() 唤醒后自然结束。
      setTimeout(resolve, 1_500);
    });
  }

  // ---- 请求处理 ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";

      if (method === "OPTIONS") {
        this.handlePreflight(req, res);
        return;
      }

      // 健康检查不暴露 Session 或授权状态，且不校验 Origin 之外的任何信息。
      if (path === "/v1/health" && method === "GET") {
        await this.sendJson(res, 200, { ok: true, protocolVersion: PROTOCOL_VERSION });
        return;
      }

      // 前端静态资源：与 API 同源（隧道地址），导航请求无 Origin 头，不做校验。
      const isApi = path === "/v1" || path.startsWith("/v1/");
      if (method === "GET" && !isApi) {
        await this.serveStatic(req, res, url.pathname);
        return;
      }

      // Origin 校验：拒绝非白名单来源（浏览器必须携带 Origin）。
      this.requireOrigin(req);

      if (this.closed) {
        throw new HttpError(503, ERROR_CODES.unavailable, "分享已停止");
      }

      if (path === "/v1/snapshot" && method === "GET") {
        await this.handleSnapshot(req, res);
        return;
      }
      if (path === "/v1/events" && method === "GET") {
        await this.handleEvents(url, req, res);
        return;
      }
      if (path === "/v1/commands" && method === "POST") {
        await this.handleCommands(req, res);
        return;
      }
      if (path === "/v1/control/claim" && method === "POST") {
        await this.handleClaim(req, res);
        return;
      }
      if (path === "/v1/control/request" && method === "POST") {
        await this.handleControlRequest(req, res);
        return;
      }

      throw new HttpError(404, ERROR_CODES.notFound, "接口不存在");
    } catch (error) {
      await this.sendError(res, error);
    }
  }

  /** 分享启动后追加允许的 Origin（隧道公网地址）。 */
  allowOrigin(origin: string): void {
    if (!this.deps.allowedOrigins.includes(origin)) {
      this.deps.allowedOrigins.push(origin);
    }
  }

  // ---- CORS / Origin ----

  private originOf(req: IncomingMessage): string | null {
    const origin = req.headers.origin;
    return typeof origin === "string" && origin.length > 0 ? origin : null;
  }

  private requireOrigin(req: IncomingMessage): void {
    const origin = this.originOf(req);
    if (!origin || !this.deps.allowedOrigins.includes(origin)) {
      throw new HttpError(
        403,
        ERROR_CODES.forbidden,
        "来源不被允许：请通过分享链接访问页面，而不是直接调用接口",
      );
    }
  }

  private handlePreflight(req: IncomingMessage, res: ServerResponse): void {
    const origin = this.originOf(req);
    if (origin && this.deps.allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Max-Age", "86400");
    }
    res.writeHead(204);
    res.end();
  }

  // ---- 接口实现 ----

  private currentState(): RemoteState {
    const controller = this.deps.lease.current;
    return {
      isStreaming: this.deps.bridge.streaming,
      controllerDeviceId: controller?.deviceId,
      controllerLabel: controller?.deviceLabel,
      localHasControl: controller === null,
    };
  }

  private requireViewerRole(req: IncomingMessage): "viewer" | "controller" {
    const role = this.deps.auth.verifyViewerToken(bearerToken(req));
    if (!role) {
      throw new HttpError(401, ERROR_CODES.unauthorized, "令牌无效");
    }
    return role;
  }

  private requireController(req: IncomingMessage): DeviceInfo {
    if (!this.deps.auth.verifyControllerToken(bearerToken(req))) {
      throw new HttpError(401, ERROR_CODES.unauthorized, "令牌无效");
    }
    const controller = this.deps.lease.current;
    if (!controller) {
      throw new HttpError(403, ERROR_CODES.forbidden, "控制权已收回");
    }
    return controller;
  }

  private async handleSnapshot(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requireViewerRole(req);
    const snapshot = this.deps.bridge.buildSnapshot(this.deps.auth.shareId, this.currentState());
    if (!snapshot) {
      throw new HttpError(503, ERROR_CODES.unavailable, "会话不可用");
    }
    await this.sendJson(res, 200, snapshot);
  }

  private async handleEvents(
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    this.requireViewerRole(req);
    const cursorRaw = url.searchParams.get("cursor");
    const cursor = cursorRaw === null ? 0 : Number(cursorRaw);
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new HttpError(400, ERROR_CODES.badRequest, "游标无效");
    }
    const waitRaw = Number(url.searchParams.get("wait") ?? LIMITS.longPollMaxWaitMs);
    const wait = Number.isFinite(waitRaw)
      ? Math.min(Math.max(waitRaw, 0), LIMITS.longPollMaxWaitMs)
      : LIMITS.longPollMaxWaitMs;

    if (this.deps.journal.waiterCount >= LIMITS.maxConcurrentPolls) {
      // 并发上限：立即返回空批，客户端稍后重试。
      await this.sendJson(res, 200, { events: [], cursor } satisfies EventBatch);
      return;
    }

    const batch = await this.deps.journal.poll(cursor, wait);
    await this.sendJson(res, 200, batch);
  }

  private async handleCommands(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const controller = this.requireController(req);
    this.checkRateLimit(`cmd:${controller.deviceId}`);

    const body = await readJsonBody(req);
    const command = validateRemoteCommand(body);
    if (!command) {
      throw new HttpError(400, ERROR_CODES.badRequest, "命令无效");
    }

    if (command.type === "abort") {
      this.deps.onRemoteAbort(controller.deviceLabel);
    }

    const result = this.deps.bridge.executeCommand(command);
    if (!result.ok) {
      throw new HttpError(409, result.code, result.message);
    }
    await this.sendJson(res, 200, { ok: true, duplicate: result.duplicate ?? false });
  }

  private async handleClaim(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = bearerToken(req);
    this.checkRateLimit(`claim:${token?.slice(-16) ?? "anon"}`);

    const body = await readJsonBody(req);
    const device = validateDeviceInfo(body);
    if (!device) {
      throw new HttpError(400, ERROR_CODES.badRequest, "设备信息无效");
    }
    if (!this.deps.auth.consumeClaimToken(token)) {
      throw new HttpError(401, ERROR_CODES.unauthorized, "令牌无效");
    }
    const controllerToken = this.deps.auth.issueControllerToken();
    this.deps.lease.grant(device, "claimed");
    this.deps.onControllerGranted(device, "claimed");
    await this.sendJson(res, 200, { controllerToken });
  }

  private async handleControlRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requireViewerRole(req);
    const body = await readJsonBody(req);
    const device = validateDeviceInfo(body);
    if (!device) {
      throw new HttpError(400, ERROR_CODES.badRequest, "设备信息无效");
    }
    this.checkRateLimit(`req:${device.deviceId}`);

    const current = this.deps.lease.current;
    if (current?.deviceId === device.deviceId) {
      throw new HttpError(409, ERROR_CODES.conflict, "该设备已是控制者");
    }

    const decision = await this.deps.requestApproval(
      device,
      current?.deviceLabel,
    );
    if (decision !== "approved") {
      await this.sendJson(res, 200, { status: decision });
      return;
    }
    const controllerToken = this.deps.auth.issueControllerToken();
    this.deps.lease.grant(device, "request_approved");
    this.deps.onControllerGranted(device, "request_approved");
    await this.sendJson(res, 200, { status: "approved", controllerToken });
  }

  // ---- 限速 ----

  private checkRateLimit(key: string): void {
    const now = Date.now();
    const bucket = this.rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
      return;
    }
    bucket.count += 1;
    if (bucket.count > LIMITS.controlRateLimitPerMinute) {
      throw new HttpError(429, ERROR_CODES.rateLimited, "请求过于频繁");
    }
    if (this.rateBuckets.size > 512) {
      // 防止键无限增长。
      for (const [k, b] of this.rateBuckets) {
        if (b.resetAt <= now) this.rateBuckets.delete(k);
      }
    }
  }

  // ---- 静态前端 ----

  private async serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (!this.deps.staticDir) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(MISSING_DIST_PAGE);
      return;
    }
    const root = this.deps.staticDir;
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      rel = "/";
    }
    if (rel === "/" || rel === "") rel = "/index.html";
    const filePath = path.join(root, path.normalize(rel));
    // 防路径穿越：解析结果必须仍在产物目录内。
    if (!filePath.startsWith(root + path.sep)) {
      throw new HttpError(404, ERROR_CODES.notFound, "资源不存在");
    }
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      throw new HttpError(404, ERROR_CODES.notFound, "资源不存在");
    }

    const ext = path.extname(filePath).toLowerCase();
    const headers: Record<string, string | number> = {
      "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
      // Vite 带内容哈希的产物可长缓存；其余（index.html / manifest 等）每次校验。
      "Cache-Control": rel.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      Vary: "Accept-Encoding",
    };
    const file = createReadStream(filePath).on("error", () => res.destroy());
    const acceptsGzip = (req.headers["accept-encoding"] ?? "").includes("gzip");
    if (acceptsGzip && COMPRESSIBLE_EXTS.has(ext)) {
      headers["Content-Encoding"] = "gzip";
      res.writeHead(200, headers);
      file.pipe(createGzip()).on("error", () => res.destroy()).pipe(res);
      return;
    }
    headers["Content-Length"] = info.size;
    res.writeHead(200, headers);
    file.pipe(res);
  }

  // ---- 响应工具 ----

  private async sendJson(res: ServerResponse, status: number, body: unknown): Promise<void> {
    if (res.writableEnded) return;
    const payload = Buffer.from(JSON.stringify(body), "utf-8");
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Vary: "Accept-Encoding",
    };
    const origin = res.req?.headers.origin;
    if (origin && this.deps.allowedOrigins.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
    }
    const acceptsGzip = (res.req?.headers["accept-encoding"] ?? "").includes("gzip");
    if (acceptsGzip && payload.length >= 1_024) {
      const compressed = await gzipAsync(payload);
      headers["Content-Encoding"] = "gzip";
      headers["Content-Length"] = compressed.length;
      res.writeHead(status, headers);
      res.end(compressed);
      return;
    }
    headers["Content-Length"] = payload.length;
    res.writeHead(status, headers);
    res.end(payload);
  }

  private async sendError(res: ServerResponse, error: unknown): Promise<void> {
    if (res.writableEnded) return;
    if (error instanceof HttpError) {
      await this.sendJson(res, error.status, {
        error: { code: error.code, message: error.message },
      });
      return;
    }
    await this.sendJson(res, 500, {
      error: { code: "internal", message: "内部错误" },
    });
  }
}
