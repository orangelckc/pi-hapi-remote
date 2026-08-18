/**
 * 开发预览页（仅 DEV 构建可达）：以静态适配器满足 RemoteChatView
 * 接口，用模拟数据离线验证消息渲染、主题与交互。
 * 生产构建中该文件会被裁剪。
 */
import { useMemo, useState } from "react";
import type { ConnectionState } from "../app/connection.js";
import type { RemoteChatView } from "../app/useRemoteChat.js";
import type { RemoteEntry } from "../protocol.js";
import {
  entriesToUIMessages,
  createMessageCache,
} from "../chat/ui-messages.js";
import { ChatView } from "../components/chat/ChatView.js";

const now = Date.now();

const previewEntries: RemoteEntry[] = [
  {
    kind: "user_message",
    id: "u1",
    text: "帮我分析一下这段代码的性能问题，并给出优化建议",
    timestamp: now - 300_000,
  },
  {
    kind: "assistant_message",
    id: "a1",
    text: "我先读取相关文件，然后逐段分析。",
    thinking:
      "用户想要性能分析。先定位代码文件，看看数据结构与循环嵌套……\n需要关注：\n1. 时间复杂度\n2. 内存分配\n3. IO 次数",
    thinkingTruncated: false,
    modelLabel: "claude-sonnet-4-5",
    timestamp: now - 299_000,
  },
  {
    kind: "tool_call",
    id: "t1",
    toolName: "read",
    argsPreview: '{"path":"src/app/largeModule.ts"}',
    status: "complete",
    resultText: "（文件内容 128 行）\nexport function process(items: Item[]) {\n  const out = [];\n  for (const it of items) {\n    for (const sub of it.children) {\n      out.push(flatten(sub));\n    }\n  }\n  return out;\n}",
    resultTruncated: false,
    timestamp: now - 298_000,
    completedAt: now - 297_500,
  },
  {
    kind: "tool_call",
    id: "t2",
    toolName: "bash",
    argsPreview: 'grep -rn "process(" src --include="*.ts" | wc -l',
    status: "running",
    timestamp: now - 297_000,
  },
  {
    kind: "notice",
    id: "n1",
    text: "上下文接近上限，已自动压缩早期会话",
    timestamp: now - 296_000,
  },
  {
    kind: "assistant_message",
    id: "a2",
    text: `## 分析结论

\`process\` 存在 **三层嵌套展开**，每次调用都重新分配数组：

- 时间复杂度 $O(n \\cdot m)$，大列表下成为热点
- 每个元素走一次 \`flatten\`，无 memo

优化建议：

1. 用扁平游标替代递归展开
2. 预分配 \`out\` 容量（\`items.length\` 估计值）
3. 热路径内联 \`flatten\`

示例：

\`\`\`typescript
export function process(items: Item[]): Out[] {
  const out = new Array<Out>(items.length * 4);
  let i = 0;
  for (const it of items) {
    for (const sub of it.children) {
      out[i++] = sub as Out; // 直接下写，避免中间数组
    }
  }
  return out.slice(0, i);
}
\`\`\`

| 方案 | 耗时 | 内存 |
| --- | --- | --- |
| 优化前 | 420ms | 38MB |
| 优化后 | 96ms | 12MB |

更多细节参考 [V8 优化指南](https://v8.dev/docs/optimization)。`,
    modelLabel: "claude-sonnet-4-5",
    timestamp: now - 295_000,
  },
  {
    kind: "user_message",
    id: "u2",
    text: "第二个 grep 命令报错了",
    timestamp: now - 200_000,
  },
  {
    kind: "tool_call",
    id: "t3",
    toolName: "bash",
    argsPreview: 'grep -rn "process(" /src --include="*.ts"',
    status: "error",
    resultText: "grep: /src: No such file or directory",
    resultTruncated: false,
    timestamp: now - 199_000,
    completedAt: now - 198_800,
  },
  {
    kind: "assistant_message",
    id: "a3",
    text: "",
    error: "Provider 请求超时（120s），已自动重试一次仍失败。可稍后重发。",
    timestamp: now - 198_000,
  },
  {
    kind: "assistant_message",
    id: "a4",
    text: "",
    thinking: "重试中……先确认 grep 的路径参数是否应该是相对路径。",
    timestamp: now - 100_000,
  },
];

function makeState(isStreaming: boolean): ConnectionState {
  return {
    phase: "connected",
    isStreaming,
    controllerDeviceId: "dev-1",
    controllerLabel: "iPhone of btrl",
    localHasControl: false,
    session: { id: "s1", name: "性能优化会话", cwdLabel: "~/work/api" },
    entries: previewEntries,
  };
}

export function PreviewPage(): JSX.Element {
  const [amController, setAmController] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const cache = useMemo(() => createMessageCache(), []);
  const messages = useMemo(
    () => entriesToUIMessages(previewEntries, cache),
    [cache],
  );

  const view: RemoteChatView = {
    state: makeState(isStreaming),
    messages,
    amController,
    sending: false,
    sendError: null,
    send: (text) => console.log("[preview] send:", text),
    abort: () => setIsStreaming((v) => !v),
    releaseControl: async () => {
      console.log("[preview] release control");
    },
    reset: async () => {},
  };

  return (
    <div className="h-full">
      <ChatView view={view} />
      <button
        type="button"
        onClick={() => setAmController((v) => !v)}
        className="fixed left-2 z-50 rounded-full bg-card px-2 py-1 text-[10px] text-muted-foreground shadow"
        style={{ top: "calc(50% + 2rem)" }}
      >
        {amController ? "控制中" : "只读"}
      </button>
      <button
        type="button"
        onClick={() => setIsStreaming((v) => !v)}
        className="fixed left-2 z-50 rounded-full bg-card px-2 py-1 text-[10px] text-muted-foreground shadow"
        style={{ top: "calc(50% + 4rem)" }}
      >
        {isStreaming ? "流式中" : "空闲"}
      </button>
    </div>
  );
}
