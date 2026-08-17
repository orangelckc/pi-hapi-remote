/**
 * 欢迎页：未携带连接载荷且无已存连接时展示。
 */
export function Welcome(): JSX.Element {
  return (
    <div className="overlay-center">
      <div className="card welcome">
        <div className="welcome-logo">⌘</div>
        <h1>Pi Remote</h1>
        <p>
          在运行 Pi 的电脑上执行
          <code className="inline-code">/remote start</code>
          开启当前会话分享，然后扫描控制二维码或打开只读链接。
        </p>
        <ul className="welcome-tips">
          <li>控制二维码为一次性授权，第一个扫描的设备直接获得控制权。</li>
          <li>只读链接仅可观察会话进度，需本机批准后才能控制。</li>
          <li>本应用为纯静态客户端，会话内容不经过任何第三方服务器。</li>
        </ul>
      </div>
    </div>
  );
}
