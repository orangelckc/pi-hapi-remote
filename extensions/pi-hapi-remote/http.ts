/**
 * HTTP 基础设施：Remote Bridge 与 Static Frontend 共用的错误类型、
 * 令牌提取与请求体解析。不感知业务协议。
 */
import type { IncomingMessage } from "node:http";
import { ERROR_CODES, LIMITS } from "../../shared/protocol.js";

/** 携带 HTTP 状态与协议错误码的业务异常。 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 提取 Authorization: Bearer 令牌。 */
export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
}

/** 读取并解析 JSON 请求体（限制总大小；空体视为 {}）。 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
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
