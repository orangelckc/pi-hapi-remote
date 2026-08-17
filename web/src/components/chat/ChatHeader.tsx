/**
 * 顶部状态栏：会话信息、连接状态、控制权徽标、移交控制权与主题切换。
 */
import { memo, useState } from "react";
import { ArrowLeftFromLine, Check, Loader2, Monitor, Moon, Sun, X } from "lucide-react";
import type { ConnectionState } from "../../app/connection.js";
import { useTheme, type Theme } from "../../app/theme.js";
import { cn } from "../../lib/utils.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.js";

const themeOptions: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

function ThemeMenu(): JSX.Element {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="切换主题" className="border-transparent">
          {theme === "dark" ? (
            <Moon className="size-4" />
          ) : theme === "light" ? (
            <Sun className="size-4" />
          ) : (
            <Monitor className="size-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>外观</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {themeOptions.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem key={value} onSelect={() => setTheme(value)}>
            <Icon className={cn(theme === value && "text-primary")} />
            <span className={cn(theme === value && "font-semibold text-primary")}>
              {label}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ChatHeaderProps {
  state: ConnectionState;
  amController: boolean;
  /** 移交控制权给本机（仅控制者可见入口）。 */
  onRelease(): Promise<void>;
}

export const ChatHeader = memo(function ChatHeader({
  state,
  amController,
  onRelease,
}: ChatHeaderProps): JSX.Element {
  const connected = state.phase === "connected";
  const reconnecting = state.phase === "reconnecting";
  const [confirming, setConfirming] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);

  const release = async (): Promise<void> => {
    setReleasing(true);
    setReleaseError(null);
    try {
      await onRelease();
      // 成功后 control_state 事件会把界面切回只读，无需本地处理。
      setConfirming(false);
    } catch (err) {
      setReleaseError(err instanceof Error ? err.message : "移交失败");
    } finally {
      setReleasing(false);
    }
  };

  return (
    <>
    <header className="sticky top-0 z-20 flex shrink-0 items-center gap-2.5 border-b border-border/70 bg-background/85 px-4 pb-2.5 pt-[calc(0.625rem+env(safe-area-inset-top,0px))] backdrop-blur-md">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold leading-tight">
          {state.session?.name || state.session?.cwdLabel || "Pi 会话"}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              connected && "bg-ok",
              reconnecting && "animate-pulse bg-warn",
              !connected && !reconnecting && "bg-danger",
            )}
          />
          <span className="truncate">
            {state.session?.cwdLabel ? `${state.session.cwdLabel} · ` : ""}
            {reconnecting ? "连接中断，正在重连…" : connected ? "已连接" : "未连接"}
            {state.isStreaming && " · Agent 运行中"}
          </span>
        </div>
      </div>

      {amController && (
        <>
          <Badge variant="ok" className="hidden xs:inline-flex">我在控制</Badge>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="移交控制权给本机"
            title="移交控制权给本机"
            disabled={releasing}
            onClick={() => {
              setReleaseError(null);
              setConfirming((v) => !v);
            }}
          >
            {releasing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowLeftFromLine className="size-4" />
            )}
          </Button>
        </>
      )}
      {!amController && state.controllerDeviceId !== undefined && (
        <Badge variant="warn" className="hidden xs:inline-flex">
          {state.controllerLabel ?? "远端设备"} 控制中
        </Badge>
      )}
      <ThemeMenu />
    </header>
      {confirming && amController && (
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-b border-warn/20 bg-warn/10 px-4 py-2 text-xs text-warn">
          <span>移交后本机恢复控制，重新接管需本机批准。</span>
          <div className="flex items-center gap-1.5">
            <Button variant="secondary" size="sm" disabled={releasing} onClick={() => setConfirming(false)}>
              <X className="size-3" />取消
            </Button>
            <Button size="sm" disabled={releasing} onClick={() => void release()}>
              {releasing ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
              确认移交
            </Button>
          </div>
          {releaseError && <span className="w-full text-center text-danger">{releaseError}</span>}
        </div>
      )}
    </>
  );
});
