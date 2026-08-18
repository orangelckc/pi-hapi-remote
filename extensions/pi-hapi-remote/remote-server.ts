/**
 * Remote Bridge（本地 HTTP 服务）+ Command Gateway。
 *
 * 只监听 127.0.0.1 随机端口，路由 Snapshot、长轮询事件、命令提交与
 * 控制权流转端点。API 执行严格 Origin 校验、请求体限制、控制端点限速
 * 与并发长轮询限制；静态前端由 Static Frontend 模块同源伺服
 * （静态资源不做 Origin 校验：顶级导航无 Origin 头）。
 */
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import {
  ERROR_CODES,
  LIMITS,
  PROTOCOL_VERSION,
  type CommandAck,
  type DeviceInfo,
  type EventBatch,
} from "../../shared/protocol.js";
import { validateDeviceInfo, validateRemoteCommand } from "../../shared/schemas.js";
import type { CapabilityAuthority } from "./auth.js";
import type { ControlFlow } from "./control-flow.js";
import type { EventJournal } from "./event-buffer.js";
import { bearerToken, HttpError, readJsonBody } from "./http.js";
import type { SessionBridge } from "./session-bridge.js";
import { StaticFrontend } from "./static-frontend.js";

export interface RemoteServerDeps {
  /** Viewer 读取鉴权（控制权流转经 control 进行）。 */
  auth: CapabilityAuthority;
  /** 控制权流转：claim / request / release 的唯一编排点。 */
  control: ControlFlow;
  journal: EventJournal;
  bridge: SessionBridge;
  /** 允许的浏览器 Origin（隧道公网地址与本地开发地址）。 */
  allowedOrigins: string[];
  /** 前端静态伺服（web/dist；未配置时返回构建提示页）。 */
  staticFrontend: StaticFrontend;
  /** 远端 Abort 审计回调。 */
  onRemoteAbort: (deviceLabel: string) => void;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

const gzipAsync = promisify(gzip);

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
    return this.deps.staticFrontend.available;
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
        await this.deps.staticFrontend.serve(req, res, url.pathname);
        return;
      }

      // Origin 校验：携带 Origin 时必须是白名单来源；同源 GET 请求无 Origin 头，放行。
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
      if (path === "/v1/control/release" && method === "POST") {
        await this.handleControlRelease(req, res);
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

  private originOf(req: IncomingMessage): string | undefined {
    const origin = req.headers.origin;
    return typeof origin === "string" && origin.length > 0 ? origin : undefined;
  }

  private requireOrigin(req: IncomingMessage): void {
    // 浏览器对同源 GET 请求（fetch）不发送 Origin 头，缺失时视为同源页面或
    // 非浏览器客户端，交由 Bearer Token 鉴权；非浏览器客户端本就可伪造 Origin，
    // 此处只需拦截携带其他 Origin 的浏览器页面（无法伪造，且能读取响应）。
    const origin = this.originOf(req);
    if (origin && !this.deps.allowedOrigins.includes(origin)) {
      throw new HttpError(
        403,
        ERROR_CODES.forbidden,
        "Origin 不在白名单内：请通过分享链接打开的 PWA 页面访问",
      );
    }
  }

  private handlePreflight(req: IncomingMessage, res: ServerResponse): void {
    const origin = this.originOf(req);
    const headers: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
    };
    if (origin && this.deps.allowedOrigins.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
    }
    res.writeHead(204, headers);
    res.end();
  }

  // ---- 接口实现 ----

  private requireViewerRole(req: IncomingMessage): "viewer" | "controller" {
    const role = this.deps.auth.verifyViewerToken(bearerToken(req));
    if (!role) {
      throw new HttpError(401, ERROR_CODES.unauthorized, "令牌无效");
    }
    return role;
  }

  private requireController(req: IncomingMessage): DeviceInfo {
    // 401 与 403 语义不同：前者令牌无效（客户端据此标记凭证失效），
    // 后者令牌有效但租约已不在远端。
    if (!this.deps.auth.verifyControllerToken(bearerToken(req))) {
      throw new HttpError(401, ERROR_CODES.unauthorized, "令牌无效");
    }
    const controller = this.deps.control.current;
    if (!controller) {
      throw new HttpError(403, ERROR_CODES.forbidden, "控制权已收回");
    }
    return controller;
  }

  private async handleSnapshot(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requireViewerRole(req);
    const state = this.deps.control.current;
    const snapshot = this.deps.bridge.buildSnapshot(this.deps.auth.shareId, {
      isStreaming: this.deps.bridge.streaming,
      controllerDeviceId: state?.deviceId,
      controllerLabel: state?.deviceLabel,
      localHasControl: state === null,
    });
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
    const result = this.deps.control.claim(token, device);
    if (!result.ok) {
      throw new HttpError(result.status, result.code, result.message);
    }
    await this.sendJson(res, 200, { controllerToken: result.controllerToken });
  }

  private async handleControlRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requireViewerRole(req);
    const body = await readJsonBody(req);
    const device = validateDeviceInfo(body);
    if (!device) {
      throw new HttpError(400, ERROR_CODES.badRequest, "设备信息无效");
    }
    this.checkRateLimit(`req:${device.deviceId}`);

    const result = await this.deps.control.request(bearerToken(req), device);
    if (!result.ok) {
      throw new HttpError(result.status, result.code, result.message);
    }
    const responseBody =
      result.status === "approved"
        ? { status: result.status, controllerToken: result.controllerToken }
        : { status: result.status };
    await this.sendJson(res, 200, responseBody);
  }

  /** 当前控制者主动移交控制权给本机。 */
  private async handleControlRelease(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = bearerToken(req);
    this.checkRateLimit(`rel:${token?.slice(-16) ?? "anon"}`);
    // 丢弃（可选的空）请求体，保证连接可复用。
    await readJsonBody(req);
    const result = this.deps.control.release(token);
    if (!result.ok) {
      throw new HttpError(result.status, result.code, result.message);
    }
    await this.sendJson(res, 200, { ok: true } satisfies CommandAck);
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
