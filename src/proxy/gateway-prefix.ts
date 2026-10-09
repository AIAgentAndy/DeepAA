/** 网关模型 ID 的分隔符：真实模型 ID 与供应商路由 ID 之间使用下划线。 */
export const GATEWAY_MODEL_SEPARATOR = "_";

/**
 * 供应商路由 ID 只允许小写字母、数字、点和连字符，绝不能包含下划线，
 * 否则无法与模型 ID 无歧义切分。配置侧 normalizeRoutePart 已保证该规则，
 * 这里作为网关侧的不可变校验。
 */
const GATEWAY_TARGET_ID_PATTERN = /^[a-z0-9.-]+$/u;

export function isValidGatewayTargetId(id: string): boolean {
  return GATEWAY_TARGET_ID_PATTERN.test(id);
}

/**
 * 生成网关模型 ID，格式为 `<真实模型ID>_<供应商路由ID>`，
 * 例如 deepseek-v4-flash_api.deepseek.com。
 * 模型名在前：CLI Agent 的模型下拉直接展示该串，重要的模型信息不被长路由 ID 挤出可视区。
 */
export function buildGatewayModelId(targetId: string, modelId: string): string {
  if (!isValidGatewayTargetId(targetId)) {
    throw new Error("Gateway target id must not contain underscores");
  }
  const normalizedModel = modelId.trim();
  if (!normalizedModel) throw new Error("Gateway model id is required");
  return `${normalizedModel}${GATEWAY_MODEL_SEPARATOR}${targetId}`;
}

/**
 * 解析网关模型 ID；格式非法或路由 ID 部分不合法时返回 null。
 * 路由 ID 不含下划线，因此以最后一个下划线为切分锚：
 * 真实模型 ID 可自由包含下划线、点、连字符而不产生歧义。
 */
export function parseGatewayModelId(model: string): {targetId: string; modelId: string} | null {
  const separatorIndex = model.lastIndexOf(GATEWAY_MODEL_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === model.length - 1) return null;
  const targetId = model.slice(separatorIndex + 1);
  if (!isValidGatewayTargetId(targetId)) return null;
  return {targetId, modelId: model.slice(0, separatorIndex)};
}

/** 判断一个模型串是否属于指定供应商的网关模型（归属分类与旧条目迁移共用）。 */
export function isGatewayModelForTarget(model: string, targetId: string): boolean {
  return parseGatewayModelId(model)?.targetId === targetId;
}

/** 把 body 中的 model 字段值替换为真实模型 ID，其余字节保持不变。 */
export function rewriteModelValue(source: string, modelValueToken: string, modelId: string): string {
  const start = source.indexOf(modelValueToken);
  if (start < 0) return source;
  return `${source.slice(0, start)}${JSON.stringify(modelId)}${source.slice(start + modelValueToken.length)}`;
}

/** model 值 JSON 字符串字面量（含首尾引号）在请求体缓冲区中的字节区间。 */
export interface ModelTokenMatch {
  /** 字符串字面量起始字节偏移（指向开头的引号）。 */
  start: number;
  /** 字符串字面量结束字节偏移（指向结尾引号的下一个字节）。 */
  end: number;
  /** 解析出的 model 字符串值。 */
  model: string;
}

const MODEL_KEY_BYTES = Buffer.from('"model"', "ascii");

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/**
 * 在原始字节缓冲区中定位 body 里的 model 字段值（JSON 字符串字面量）。
 * 全程只按 ASCII 字节扫描，不做 UTF-8 解码/重编码：TCP 分块边界即使切在
 * 多字节字符中间，也不会产生 U+FFFD 替换字符污染其余内容。
 * 值未闭合（缓冲区在字符串结束前截断）时返回 undefined，调用方应继续累计
 * 更多数据后重试；值非字符串、为空或解析失败时继续扫描后续 model 字段。
 */
export function findModelTokenBytes(buffer: Buffer): ModelTokenMatch | undefined {
  let pos = 0;
  while (pos < buffer.length) {
    const keyStart = buffer.indexOf(MODEL_KEY_BYTES, pos);
    if (keyStart < 0) return undefined;
    let cursor = keyStart + MODEL_KEY_BYTES.length;
    while (cursor < buffer.length && isJsonWhitespace(buffer[cursor]!)) cursor += 1;
    if (buffer[cursor] !== 0x3a) {
      pos = keyStart + 1;
      continue;
    }
    cursor += 1;
    while (cursor < buffer.length && isJsonWhitespace(buffer[cursor]!)) cursor += 1;
    if (buffer[cursor] !== 0x22) {
      pos = keyStart + 1;
      continue;
    }
    const start = cursor;
    cursor += 1;
    let closed = false;
    while (cursor < buffer.length) {
      const byte = buffer[cursor]!;
      if (byte === 0x5c) {
        // 跳过转义序列；\uXXXX 的十六进制数字也是普通 ASCII 字节，无需特殊处理。
        cursor += 2;
        continue;
      }
      if (byte === 0x22) {
        closed = true;
        break;
      }
      cursor += 1;
    }
    if (!closed) return undefined;
    const end = cursor + 1;
    const token = buffer.subarray(start, end).toString("utf8");
    let model: unknown;
    try {
      model = JSON.parse(token);
    } catch {
      pos = start + 1;
      continue;
    }
    if (typeof model !== "string" || !model.trim()) {
      pos = start + 1;
      continue;
    }
    return {start, end, model: model.trim()};
  }
  return undefined;
}

/**
 * 按字节区间替换 model 值并返回新缓冲区，区间之外的字节原样拷贝，
 * 全程不做 UTF-8 解码/重编码，保证转发供应商收到的请求体与客户端原始
 * 字节逐字节一致，只改变 model 字段本身。
 */
export function rewriteModelValueBytes(
  source: Buffer,
  match: ModelTokenMatch,
  modelId: string,
): Buffer {
  const replacement = Buffer.from(JSON.stringify(modelId), "ascii");
  const rewritten = Buffer.allocUnsafe(
    source.length - (match.end - match.start) + replacement.length,
  );
  source.copy(rewritten, 0, 0, match.start);
  replacement.copy(rewritten, match.start);
  source.copy(rewritten, match.start + replacement.length, match.end);
  return rewritten;
}

/** 计费相关的 service_tier 已知值；其余取值不参与乘数计价。 */
export type BillableServiceTier = "priority" | "flex" | "fast";

/**
 * 上下文压缩续接请求的消息头部标记（与 src/lib/harness/compaction-evidence.ts
 * 保持一致；代理构建不含业务派生模块，故在代理侧持副本，由守卫测试断言同步）。
 * 语义边界： harness 侧只在消息文本头部 200 字符内匹配；字节级搜索无法精确界定
 * 消息头部，但标记句式长且专用，误匹配概率可忽略，且后果只是一次无害的主模型
 * 恢复探测（见 model-failover.ts），因此代理侧直接在既有有界扫描窗口内匹配。
 */
export const COMPACTION_SUMMARY_MARKER_TEXTS: readonly string[] = [
  "This session is being continued from a previous conversation that ran out of context",
  "Another language model started to solve this problem",
];

const COMPACTION_MARKER_BUFFERS: readonly Buffer[] = COMPACTION_SUMMARY_MARKER_TEXTS.map(
  marker => Buffer.from(marker, "utf8"),
);

/**
 * 在请求体有界前缀字节中匹配压缩续接标记（ASCII 字节搜索，不做 UTF-8 解码）。
 * 仅在故障转移降级态下由转发层调用，用于选择「先探测主模型」的切回时机。
 */
export function hasCompactionSummaryMarkerBytes(buffer: Buffer): boolean {
  for (const marker of COMPACTION_MARKER_BUFFERS) {
    if (buffer.indexOf(marker) >= 0) return true;
  }
  return false;
}

/** dsh 官方压缩标记请求头（wire 显式标记，零推断；与 compaction-evidence.ts 同名常量）。 */
export const DSH_COMPACT_HEADER = "x-deepseek-harness-compact";

/** 判断请求头是否携带 dsh 官方压缩标记（Node http 已把请求头键小写）。 */
export function hasDshCompactionHeader(headers: Record<string, string | string[] | undefined>): boolean {
  const value = headers[DSH_COMPACT_HEADER];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" && text.trim() !== "" && text !== "0";
}

/**
 * 从请求体前缀字节中提取 service_tier 参数（仅计费相关取值）：
 * 与 model 改写同一批有界前缀内做字节级匹配，不引入额外缓冲或解码。
 */
export function extractServiceTierValue(source: Buffer | string): BillableServiceTier | undefined {
  const text = typeof source === "string" ? source : source.toString("latin1");
  const match = text.match(/"service_tier"\s*:\s*"([a-z_]+)"/u);
  const value = match?.[1];
  return value === "priority" || value === "flex" || value === "fast" ? value : undefined;
}
