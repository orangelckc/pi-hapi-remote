/**
 * 轻量运行时校验。
 *
 * 手写字段检查（不引入 schema 库），保证 shared 代码在浏览器与 Node
 * 两个运行时下零依赖可用。
 */
import {
  LIMITS,
  type DeviceInfo,
  type RemoteCommand,
  type RemoteCommandType,
} from "./protocol.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** 校验设备信息（控制申请 / Claim 兑换请求体）。 */
export function validateDeviceInfo(value: unknown): DeviceInfo | null {
  if (!isRecord(value)) return null;
  const { deviceId, deviceLabel } = value;
  if (!isString(deviceId) || deviceId.length === 0 || deviceId.length > 128) return null;
  if (!isString(deviceLabel) || deviceLabel.length === 0 || deviceLabel.length > 128) return null;
  return { deviceId, deviceLabel };
}

/** 命令类型白名单。satisfies 保证与 RemoteCommandType 严格互镜：
 * 协议新增命令类型而此处未同步时，编译期即报错。 */
const COMMAND_TYPES = {
  prompt: true,
  steer: true,
  follow_up: true,
  abort: true,
} as const satisfies Record<RemoteCommandType, true>;

function isCommandType(value: string): value is RemoteCommandType {
  return value in COMMAND_TYPES;
}

/** 校验远端命令。返回 null 表示请求体不合法。 */
export function validateRemoteCommand(value: unknown): RemoteCommand | null {
  if (!isRecord(value)) return null;
  const { id, type, text } = value;
  if (!isString(id) || id.length === 0 || id.length > 128) return null;
  if (!isString(type) || !isCommandType(type)) return null;

  if (type === "abort") {
    return { id, type: "abort" };
  }

  if (!isString(text) || text.length === 0) return null;
  if (text.length > LIMITS.maxTextLength) return null;
  return { id, type, text };
}
