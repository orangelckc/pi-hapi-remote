/**
 * Static Frontend（深模块）：同源伺服前端静态产物（web/dist）。
 *
 * 路径穿越防护、MIME 推断、Vite 内容哈希产物长缓存与文本资源 gzip。
 * 未配置产物目录时返回构建引导页。不感知 API 与鉴权。
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { createGzip } from "node:zlib";
import { ERROR_CODES } from "../../shared/protocol.js";
import { HttpError } from "./http.js";

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

export class StaticFrontend {
  private root: string | null;

  constructor(root: string | null) {
    this.root = root;
  }

  /** 是否已配置前端产物目录。 */
  get available(): boolean {
    return this.root !== null;
  }

  /** 伺服 GET 静态资源；未命中或越界访问抛 404。 */
  async serve(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (!this.root) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(MISSING_DIST_PAGE);
      return;
    }
    const root = this.root;
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
}
