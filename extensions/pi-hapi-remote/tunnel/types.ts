/**
 * Tunnel Adapter 抽象：稳定的 Start/Stop 契约。
 * Session、授权与协议模块不得依赖具体隧道供应商。
 */

export interface TunnelStartOptions {
  /** 本地回环端口。 */
  localPort: number;
  /** 启动超时中止信号（由调用方管理）。 */
  signal: AbortSignal;
}

export interface TunnelHandle {
  /** 公网 HTTPS 入口。 */
  publicUrl: string;
}

export interface TunnelAdapter {
  /** 启动隧道并返回公网地址。失败时抛错（含超时）。 */
  start(options: TunnelStartOptions): Promise<TunnelHandle>;
  /** 确定性终止（幂等）。 */
  stop(): Promise<void>;
}
