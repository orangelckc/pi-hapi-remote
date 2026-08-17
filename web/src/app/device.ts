/**
 * 设备身份：稳定的设备 ID（localStorage）与从 User-Agent 提取的设备标签。
 */

const DEVICE_ID_KEY = "pi-hapi-remote:device-id";

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function getDeviceLabel(): string {
  const ua = navigator.userAgent;
  const isIPhone = /iPhone/i.test(ua);
  const isIPad = /iPad/i.test(ua) || (/Macintosh/.test(ua) && "ontouchend" in document);
  const isAndroid = /Android/i.test(ua);
  const isMobile = isIPhone || isIPad || isAndroid;

  let os = "未知设备";
  if (isIPhone) os = "iPhone";
  else if (isIPad) os = "iPad";
  else if (isAndroid) os = "Android";
  else if (/Macintosh|Mac OS X/i.test(ua)) os = "macOS";
  else if (/Windows/i.test(ua)) os = "Windows";
  else if (/Linux/i.test(ua)) os = "Linux";

  let browser = "浏览器";
  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = "Chrome";
  else if (/Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = "Safari";

  const kind = isMobile ? "手机" : "桌面";
  return `${os} · ${browser}（${kind}）`;
}
