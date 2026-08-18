/**
 * 协议桥：从 shared/protocol.ts 复用类型与常量。
 * （Vite 直接编译 workspace 共享源码，浏览器端零依赖。）
 */
export * from "../../shared/protocol.js";
export { EntryLog } from "../../shared/entry-log.js";
