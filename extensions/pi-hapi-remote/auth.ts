/**
 * Capability Authority（深模块）：Viewer Token、一次性 Claim Token、
 * Controller Token 的签发、摘要保管与校验。
 *
 * 令牌使用 256 位加密安全随机数；服务端只保存 SHA-256 摘要，
 * 内存泄漏或状态检查不会直接暴露可用凭证。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "phr1_";

/** 生成带前缀的 256 位随机令牌。 */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestEquals(token: string, digest: string | undefined): boolean {
  if (!digest) return false;
  const actual = Buffer.from(sha256(token), "hex");
  const expected = Buffer.from(digest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type TokenRole = "viewer" | "controller";

/** 一次分享会话内的全部能力令牌状态。 */
export class CapabilityAuthority {
  readonly shareId: string;
  private viewerDigest: string | undefined;
  private claimDigest: string | undefined;
  private controllerDigest: string | undefined;
  private revoked = false;

  constructor(shareId: string) {
    this.shareId = shareId;
  }

  /**
   * 签发令牌组。返回可下发的明文令牌；服务端仅保留摘要。
   */
  issueTokens(): { viewerToken: string; claimToken: string } {
    const viewerToken = generateToken();
    this.viewerDigest = sha256(viewerToken);
    const claimToken = generateToken();
    this.claimDigest = sha256(claimToken);
    return { viewerToken, claimToken };
  }

  /** 校验读取令牌（viewer 或 controller 均可读取）。 */
  verifyViewerToken(token: string | undefined): TokenRole | null {
    if (!token || this.revoked) return null;
    if (digestEquals(token, this.controllerDigest)) return "controller";
    if (digestEquals(token, this.viewerDigest)) return "viewer";
    return null;
  }

  /** 校验控制令牌。 */
  verifyControllerToken(token: string | undefined): boolean {
    if (!token || this.revoked) return false;
    return digestEquals(token, this.controllerDigest);
  }

  /** 一次性 Claim Token 是否仍可兑换。 */
  get claimAvailable(): boolean {
    return !this.revoked && this.claimDigest !== undefined;
  }

  /** 校验一次性 Claim Token；命中即作废（一次性语义）。 */
  consumeClaimToken(token: string | undefined): boolean {
    if (!token || this.revoked) return false;
    if (!digestEquals(token, this.claimDigest)) return false;
    this.claimDigest = undefined;
    return true;
  }

  /** 为当前控制设备签发 Controller Token（替换旧的）。 */
  issueControllerToken(): string {
    const token = generateToken();
    this.controllerDigest = sha256(token);
    return token;
  }

  /** 校证当前 controller token 是否匹配指定值（用于恢复连接）。 */
  matchesControllerToken(token: string | undefined): boolean {
    return this.verifyControllerToken(token);
  }

  /** 撤销控制令牌（收回/撤销设备时）。 */
  revokeControllerToken(): void {
    this.controllerDigest = undefined;
  }

  /** 使全部令牌失效（停止分享）。 */
  revokeAll(): void {
    this.revoked = true;
    this.claimDigest = undefined;
    this.controllerDigest = undefined;
  }
}

/** 生成短随机 Share ID（仅用于展示标识，非机密）。 */
export function generateShareId(): string {
  return randomBytes(6).toString("base64url");
}
