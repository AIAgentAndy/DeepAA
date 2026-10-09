import type {
  ExportContentExchange,
  ExportContentItem,
} from "@/lib/export-content-client";
import type { ConversationCategory } from "@/lib/export-conversation";
import { formatLocalDateTime } from "@/lib/local-time";

/** 交互内容类别 → 用户可读标签（列表筛选、内容卡与导出文件共用一份）。 */
export const CONVERSATION_CATEGORY_LABELS: Record<ConversationCategory, string> = {
  system: "system（系统）",
  developer: "developer（开发者）",
  user_real: "user（真实输入）",
  user_injected: "user（Agent 注入）",
  tool_result: "tool_result（工具结果）",
  assistant: "assistant 文本",
  tool_use: "tool_use（工具调用）",
  reasoning: "reasoning（思考）",
  refusal: "refusal（拒绝）",
  control: "control（控制）",
  unknown_input: "unknown_input（未识别输入）",
  unknown_output: "unknown_output（未识别输出）",
};

export interface ExportDownloadSegment {
  exchange: ExportContentExchange;
  items: ExportContentItem[];
}

export interface ExportDownloadSource {
  /** 文档标题（如「本步新增 · aexch-xxx」）；JSONL 不使用。 */
  heading: string;
  segments: ExportDownloadSegment[];
  /** 时间格式化注入点（测试用）；缺省按全站时区偏好格式化。 */
  formatDateTime?: (value: string | Date) => string;
}

/**
 * 步骤正文导出的 Markdown 序列化：与「完整导出 Markdown」保持同一行分条形态
 * （`- [side/类别] 文本`），仅覆盖调用方已加载的有界内容，不触发新的 Raw 读取。
 */
export function buildConversationMarkdown(source: ExportDownloadSource): string {
  const formatDateTime = source.formatDateTime ?? formatLocalDateTime;
  const lines: string[] = [
    `# ${source.heading}`,
    "",
    `> 共 ${countDownloadItems(source)} 条 · ${formatDateTime(new Date())}`,
    "",
  ];
  for (const segment of source.segments) {
    const httpStatus = segment.exchange.httpStatus === undefined
      ? ""
      : ` · HTTP ${segment.exchange.httpStatus}`;
    lines.push(
      `## ${segment.exchange.exchangeId} · ${formatDateTime(segment.exchange.capturedAt)}${httpStatus}`,
      "",
    );
    for (const item of segment.items) {
      const toolSuffix = item.toolName ? ` · ${item.toolName}` : "";
      lines.push(`- [${item.side}/${CONVERSATION_CATEGORY_LABELS[item.category]}${toolSuffix}] ${item.text}`, "");
    }
  }
  return lines.join("\n");
}

/** JSONL 序列化：每行一个对话条目 JSON 对象，与「完整导出 JSONL」同一形态。 */
export function buildConversationJsonl(source: ExportDownloadSource): string {
  const items = source.segments.flatMap(segment => segment.items);
  if (items.length === 0) return "";
  return `${items.map(item => JSON.stringify(item)).join("\n")}\n`;
}

export function countDownloadItems(source: ExportDownloadSource): number {
  return source.segments.reduce((total, segment) => total + segment.items.length, 0);
}

/** 下载文件名收敛：与导出路由的 safeFilename 同一规则（保守白名单 + 折叠）。 */
export function safeDownloadFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "export";
}
