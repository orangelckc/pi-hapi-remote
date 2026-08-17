/**
 * Markdown 渲染：react-markdown + GFM + 代码高亮。
 * 代码块支持语言标签、一键复制与超长折叠。
 */
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// 按需注册常用语言，控制 PWA 离线包体积。
const languages = {
  bash,
  c,
  cpp,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};
for (const [name, def] of Object.entries(languages)) {
  hljs.registerLanguage(name, def);
}

const aliases: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  html: "xml",
  yml: "yaml",
  md: "markdown",
};

/** 生成高亮 HTML；未注册语言返回转义后的纯文本。 */
function highlight(code: string, language: string): string {
  const name = aliases[language] ?? language;
  if (!hljs.getLanguage(name)) {
    return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    return code;
  }
}
import { cn } from "../../lib/utils.js";

const COLLAPSE_LINES = 28;
const COLLAPSE_HEIGHT = "22rem";

function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in (node as unknown as Record<string, unknown>)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return extractText((node as any).props?.children);
  }
  return "";
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 旧 WebView / 非 HTTPS 环境回退。
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}

export function CopyButton({ text, className }: { text: string; className?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async (): Promise<void> => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    }
  }, [text]);

  return (
    <button
      type="button"
      aria-label="复制"
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground",
        "transition-colors hover:text-foreground active:bg-black/20",
        className,
      )}
      onClick={() => void onCopy()}
    >
      {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      {copied ? "已复制" : "复制"}
    </button>
  );
}

function CodeBlock({
  language,
  code,
}: {
  language: string;
  code: string;
}): JSX.Element {
  const lineCount = code.split("\n").length;
  const collapsible = lineCount > COLLAPSE_LINES;
  const [expanded, setExpanded] = useState(false);
  const showCode = !collapsible || expanded;
  const highlighted = useMemo(() => highlight(code, language), [code, language]);

  return (
    <div className="group/code my-3 overflow-hidden rounded-lg border border-border/60 bg-[var(--code-bg)]">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-1">
        <span className="font-mono text-[11px] text-muted-foreground">
          {language || "text"} · {lineCount} 行
        </span>
        <CopyButton text={code} className="text-white/50 hover:text-white" />
      </div>
      <div className="relative">
        <pre
          className={cn(
            "overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed text-[var(--code-fg)]",
            !showCode && "max-h-[var(--code-collapse-h)] overflow-hidden",
          )}
          style={{ "--code-collapse-h": COLLAPSE_HEIGHT } as React.CSSProperties}
        >
          <code
            className="hljs"
            data-language={language}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        </pre>
        {collapsible && (
          <button
            type="button"
            className={cn(
              "absolute inset-x-0 flex items-center justify-center gap-1 py-2 text-xs text-muted-foreground",
              "bg-gradient-to-t from-[var(--code-bg)] via-[var(--code-bg)] to-transparent transition-colors hover:text-foreground",
              expanded ? "static from-transparent" : "bottom-0",
            )}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <>
                <ChevronUp className="size-3.5" /> 收起
              </>
            ) : (
              <>
                <ChevronDown className="size-3.5" /> 展开 {lineCount - COLLAPSE_LINES}+ 行
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

const markdownComponents = {
  pre: ({ children }: { children?: ReactNode }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const codeEl = Array.isArray(children) ? children[0] : (children as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const className: string = codeEl?.props?.className ?? "";
    const language = /language-(\S+)/.exec(className)?.[1] ?? "";
    // 原始文本用于高亮、复制与行数统计。
    const raw = extractText(codeEl?.props?.children).replace(/\n$/, "");
    return <CodeBlock language={language} code={raw} />;
  },
  code: ({ children, className }: { children?: ReactNode; className?: string }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) return <code className={className}>{children}</code>;
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-primary">
        {children}
      </code>
    );
  },
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
};

export const Markdown = memo(function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none dark:prose-invert",
        "prose-p:leading-relaxed prose-p:my-1.5 prose-pre:my-0 prose-pre:bg-transparent prose-pre:p-0",
        "prose-headings:mt-3 prose-headings:mb-1.5 prose-ul:my-1.5 prose-ol:my-1.5",
        "prose-li:my-0.5 prose-blockquote:my-2 prose-hr:my-3",
        "prose-table:text-[13px] prose-th:px-2 prose-td:px-2",
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
