/**
 * 主题管理：浅色 / 深色 / 跟随系统，持久化到 localStorage。
 * 初始 class 由 index.html 内联脚本设置，避免首帧闪烁。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "pi-remote-theme";

interface ThemeContextValue {
  theme: Theme;
  /** 实际生效的主题（system 已解析）。 */
  resolvedTheme: "light" | "dark";
  setTheme(theme: Theme): void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  resolvedTheme: "dark",
  setTheme: () => {},
});

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: Theme): "light" | "dark" {
  const resolved =
    theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  return resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" || saved === "system"
      ? saved
      : "system";
  });
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() =>
    applyTheme(theme),
  );

  useEffect(() => {
    setResolvedTheme(applyTheme(theme));
    if (theme !== "system") return;
    // 系统主题变化时跟随（仅 system 模式监听）。
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => setResolvedTheme(applyTheme("system"));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme): void => {
    localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
