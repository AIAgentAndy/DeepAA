import type { ConversationCategory } from "./export-conversation";

export type ExportBodySide = "request" | "response";

export class InvalidExportBodySideError extends Error {
  constructor(readonly value: string) {
    super(`交互内容方向无效：${value}`);
    this.name = "InvalidExportBodySideError";
  }
}

export interface ExportConversationQueryInput {
  target?: string | string[];
  agent?: string | string[];
  session?: string;
  /** 业务 Thread：Session 内的一条 Agent 执行线程；内部映射为 AgentThread.id。 */
  thread?: string;
  /** 业务 Turn：一次用户任务轮次；当前内部映射为 AgentTurn.id。 */
  turn?: string;
  /** 业务 Step：一次模型请求/响应；统一使用内部 AgentStep.id。 */
  step?: string;
  start?: string;
  end?: string;
  scope?: "all" | "upto" | "step";
  side?: ExportBodySide;
  categories?: ConversationCategory[];
  maxExchanges?: number;
  maxBytes?: number;
  cursor?: string;
  direction?: "older" | "newer";
  page?: number;
  exchangeLimit?: number;
  pageMaxBytes?: number;
  includeInherited?: boolean;
}

export function parseExportBodySide(
  value: string | null,
): ExportBodySide | undefined {
  if (value === null || value === "") return undefined;
  if (value === "request" || value === "response") return value;
  throw new InvalidExportBodySideError(value);
}

/**
 * 构造导出页与内嵌页签共用的稳定查询串。
 * 参数顺序保持固定，方便测试、复制链接和比较当前检查范围。
 */
export function buildExportConversationQuery(input: ExportConversationQueryInput): string {
  const params = new URLSearchParams();
  setJoined(params, "target", input.target);
  setJoined(params, "agent", input.agent);
  setString(params, "session", input.session);
  setString(params, "thread", input.thread);
  setString(params, "turn", input.turn);
  setString(params, "step", input.step);
  setString(params, "start", input.start);
  setString(params, "end", input.end);
  params.set("scope", input.scope || "all");
  if (input.side === "request" || input.side === "response") {
    params.set("side", input.side);
  }
  if (input.cursor?.trim()) {
    params.set("cursor", input.cursor.trim());
  }
  if (input.direction === "older" || input.direction === "newer") {
    params.set("direction", input.direction);
  }
  if (Number.isSafeInteger(input.page) && input.page! > 0) {
    params.set("page", String(input.page));
  }
  if (input.categories !== undefined) {
    params.set("categories", input.categories.join(","));
  }
  if (input.exchangeLimit !== undefined && Number.isFinite(input.exchangeLimit) && input.exchangeLimit > 0) {
    params.set("exchangeLimit", String(Math.floor(input.exchangeLimit)));
  }
  if (input.pageMaxBytes !== undefined && Number.isFinite(input.pageMaxBytes) && input.pageMaxBytes > 0) {
    params.set("pageMaxBytes", String(Math.floor(input.pageMaxBytes)));
  }
  if (input.maxExchanges !== undefined && Number.isFinite(input.maxExchanges) && input.maxExchanges > 0) {
    params.set("maxExchanges", String(Math.floor(input.maxExchanges)));
  }
  if (input.maxBytes !== undefined && Number.isFinite(input.maxBytes) && input.maxBytes > 0) {
    params.set("maxBytes", String(Math.floor(input.maxBytes)));
  }
  if (input.includeInherited === true) {
    params.set("includeInherited", "true");
  }
  return params.toString();
}

function setString(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) params.set(key, trimmed);
}

function setJoined(params: URLSearchParams, key: string, value: string | string[] | undefined): void {
  const items = Array.isArray(value) ? value : value ? value.split(",") : [];
  const normalized = items.map(item => item.trim()).filter(Boolean);
  if (normalized.length > 0) params.set(key, normalized.join(","));
}
