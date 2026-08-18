/**
 * 全屏覆盖层：欢迎页、分享结束、凭证失效、渲染崩溃。
 */
import { Component, type ReactNode } from "react";
import { AlertTriangle, CircleSlash2, KeyRound, TerminalSquare } from "lucide-react";
import { Button } from "./ui/button.js";
import { Card, CardContent } from "./ui/card.js";

/**
 * 顶层渲染错误边界：未捕获的渲染异常不再卸载整树（黑屏），
 * 而是显示可恢复的错误界面。
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="w-full max-w-sm text-center">
          <CardContent className="flex flex-col items-center gap-2 pt-6">
            <AlertTriangle className="size-10 text-danger" strokeWidth={1.5} />
            <h2 className="text-lg font-semibold">界面渲染出错</h2>
            <p className="break-words font-mono text-xs text-muted-foreground">
              {this.state.error.message}
            </p>
            <Button className="mt-2" onClick={() => window.location.reload()}>
              重新加载
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
}

export function Welcome(): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-md text-center">
        <CardContent className="flex flex-col items-center gap-2 pt-6">
          <TerminalSquare className="size-11 text-primary" strokeWidth={1.5} />
          <h1 className="text-xl font-bold">Pi Remote</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            在运行 Pi 的电脑上执行
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[13px] text-primary">
              /remote start
            </code>
            开启当前会话分享，然后扫描控制二维码或打开只读链接。
          </p>
          <ul className="mb-2 mt-2 list-disc space-y-1.5 pl-5 text-left text-[13px] text-muted-foreground">
            <li>控制二维码为一次性授权，第一个扫描的设备直接获得控制权。</li>
            <li>只读链接仅可观察会话进度，需本机批准后才能控制。</li>
            <li>纯静态客户端，会话内容不经过任何第三方服务器。</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

export function EndedOverlay({ onClear }: { onClear(): void }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm text-center">
        <CardContent className="flex flex-col items-center gap-2 pt-6">
          <CircleSlash2 className="size-10 text-muted-foreground" strokeWidth={1.5} />
          <h2 className="text-lg font-semibold">分享已结束</h2>
          <p className="text-sm text-muted-foreground">
            本机已停止分享，或 Session 已切换。连接凭证已自动清除。
          </p>
          <Button className="mt-2" onClick={() => void onClear()}>
            返回首页
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export function InvalidOverlay({ onClear }: { onClear(): void }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm text-center">
        <CardContent className="flex flex-col items-center gap-2 pt-6">
          <KeyRound className="size-10 text-warn" strokeWidth={1.5} />
          <h2 className="text-lg font-semibold">凭证已失效</h2>
          <p className="text-sm text-muted-foreground">
            此分享可能已停止或令牌已被撤销。请向本机用户获取新的分享链接。
          </p>
          <Button className="mt-2" onClick={() => void onClear()}>
            返回首页
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
