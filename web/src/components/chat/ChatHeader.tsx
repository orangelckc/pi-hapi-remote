/**
 * 顶部状态栏：会话信息、连接状态、控制权徽标与主题切换。
 */
import { memo } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import type { ConnectionState } from "../../app/connection.js";
import { useTheme, type Theme } from "../../app/theme.js";
import { cn } from "../../lib/utils.js";
import { Badge } from "../ui/badge.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.js";
import { Button } from "../ui/button.js";

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
}

export const ChatHeader = memo(function ChatHeader({
  state,
  amController,
}: ChatHeaderProps): JSX.Element {
  const connected = state.phase === "connected";
  const reconnecting = state.phase === "reconnecting";

  return (
    <header className="sticky top-0 z-20 flex shrink-0 items-center gap-2.5 border-b border-border/70 bg-background/85 px-4 pb-2.5 backdrop-blur-md pt-[calc(0.625rem+env(safe-area-inset-top,0px))]">
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

      {state.controllerDeviceId !== undefined &&
        (amController ? (
          <Badge variant="ok" className="hidden xs:inline-flex">我在控制</Badge>
        ) : (
          <Badge variant="warn" className="hidden xs:inline-flex">
            {state.controllerLabel ?? "远端设备"} 控制中
          </Badge>
        ))}
      <ThemeMenu />
    </header>
  );
});
