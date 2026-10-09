/**
 * 合成 v2 raw 捕获（双链路观测核心）：把 Agent 本地用量记录组装为与网关捕获
 * 契约级同构的 RawCapturedExchangeV2 行，落入 captures/v2/import-<agent>-*.jsonl，
 * 由既有 Worker 管线零分叉消费。一致性设计见 docs/Agent双链路观测总设计文档.md §5.5：
 * - 请求体保真（官方原始模型名；计价匹配大小写不敏感）；
 * - 响应体由结构化聚合结果组装为 anthropic 非流式 message JSON，usage 恒以
 *   客户端自报权威值为准（正文缺失时组装仅含 usage 的最小 body，账本永不缺数）；
 * - 身份头合成（x-zcode-trace-id / x-session-id / x-zcode-session-type），与网关
 *   链路共用 thread-identity 折叠。
 */

import {createHash} from "node:crypto";
import {randomUUID} from "node:crypto";
import {mkdir, open, writeFile, rename, type FileHandle} from "node:fs/promises";
import {dirname, join} from "node:path";
import {gzipSync} from "node:zlib";
import type {
  AgentLocalSourceAdapter,
  LocalExchangeDetail,
  LocalUsageRecord,
} from "./types";
import type {RawCapturedExchangeV2} from "@/lib/harness/types";

/** 合成行写入目标相对目录（与网关捕获同目录、独立前缀；发现器与文件名无关）。 */
export function importCaptureDirectory(dataDir: string): string {
  return join(dataDir, "captures", "v2");
}

export function createImportCaptureSessionId(agentId: string, now = Date.now()): string {
  return `import-${agentId}-${now}-${randomUUID().slice(0, 12)}`;
}

export interface SyntheticBuildInput {
  agentId: string;
  record: LocalUsageRecord;
  /** 归一后模型名（白名单已命中）。 */
  modelId: string;
  /** 绑定目标（默认目标推导结果）。 */
  target: {id: string; name: string; defaultCredentialId?: string};
  adapter: AgentLocalSourceAdapter;
  /** 同轮趁热读取的正文（可能 undefined：rollout 已被清理等）。 */
  detail?: LocalExchangeDetail;
}

export function buildSyntheticExchange(input: SyntheticBuildInput): RawCapturedExchangeV2 {
  const {record, modelId, target, adapter, detail} = input;
  const capturedAt = new Date(record.startedAt).toISOString();
  const completedAt = new Date(record.completedAt ?? record.startedAt).toISOString();
  // body.model 统一改写为归一模型名（与网关链路「body.model 记录真实请求模型」语义
  // 对齐）：官方显示名（GLM-5.3-Flash）与目录名（glm-5.3-flash）仅大小写差异，
  // 但套餐积分系数表/活动模型表按目录名精确匹配，改写保证计价链无断点。
  const requestRawBody = rewriteBodyModel(detail?.requestRawBody, modelId);
  // 真实用户输入回填（2026-09-16）：rollout 请求体不保留消息历史（messages 为空），
  // 从 zcode message/part 关联出的用户原文注入为单条 user 消息——「本 Turn 用户输入」
  // 与请求预览由此恢复真实内容；原 body 已有消息历史时（未来开关打开）不覆盖。
  const requestRawBodyWithUser = ensureUserMessage(requestRawBody, record.userText);
  const request = {
    headers: adapter.buildSyntheticRequestHeaders
      ? adapter.buildSyntheticRequestHeaders(record, detail)
      : buildSyntheticRequestHeaders(record, detail),
    ...(requestRawBodyWithUser !== undefined ? {rawBody: requestRawBodyWithUser} : {}),
    bodySizeBytes: byteLength(requestRawBodyWithUser),
    bodySha256: sha256(requestRawBodyWithUser),
  };
  const {status, statusText, diagnostics} = mapStatus(record);
  const responseRawBody = adapter.assembleChatResponseRawBody
    ? adapter.assembleChatResponseRawBody(record, detail, modelId)
    : assembleResponseRawBody(record, detail, modelId);
  const hasDetailBody = detail !== undefined
    && (detail.requestRawBody !== undefined || detail.response !== undefined);
  if (!hasDetailBody) {
    diagnostics.push({
      code: "missing_raw_body",
      severity: "info",
      message: "本地正文源不可得（可能已被 Agent 清理）；用量与账本不受影响。",
    });
  } else if (detail?.skeletonSource === "borrowed") {
    diagnostics.push({
      code: "request_skeleton_borrowed",
      severity: "info",
      message: "系统提示与工具定义来自本会话最近一次成功读取的骨架缓存（该请求自身的本地正文已不可得）。",
    });
  } else if (detail?.skeletonUnavailable === true) {
    // 该 Agent 的本地记录结构上不含系统提示/工具定义（codex rollout 等）——已知常态
    // 而非异常，不产生诊断（2026-10-09 用户确认）。
  } else if (
    requestRawBodyWithUser !== undefined
    && !requestBodyHasPromptSkeleton(requestRawBodyWithUser)
  ) {
    diagnostics.push({
      code: "request_skeleton_missing",
      severity: "warning",
      message: "请求体缺少系统提示/工具定义骨架：该步骤的完整上下文不完整。",
    });
  }
  if (detail !== undefined && responseOverrideIsEmpty(detail.response) && record.usage.outputTokens > 0) {
    diagnostics.push({
      code: "assistant_parts_incomplete",
      severity: "warning",
      message: "本地 assistant 正文为空但用量显示有输出：该步骤的记录可能尚未写完。",
    });
  }
  return {
    schemaVersion: 2,
    exchangeId: `import-${input.agentId}-${record.id}${record.attemptIndex > 0 ? `-${record.attemptIndex}` : ""}`,
    captureSessionId: "",
    sequence: 0,
    capturedAt,
    completedAt,
    durationMs: record.durationMs ?? 0,
    ...(record.firstTokenMs !== undefined ? {firstTokenMs: record.firstTokenMs} : {}),
    routing: {
      targetId: target.id,
      targetName: target.name,
      targetFormatHint: adapter.syntheticTargetFormatHint ?? "anthropic",
      localUrl: `/${input.agentId}${adapter.protocolPath}`,
      upstreamUrl: `${adapter.officialUpstreamBaseUrl}${adapter.protocolPath}`,
      localPath: `/${input.agentId}${adapter.protocolPath}`,
      upstreamPath: adapter.protocolPath,
      method: "POST",
      requestedModel: modelId,
      routeMode: "local_import",
      origin: "agent_local_import",
      ...(record.querySource !== undefined ? {clientQuerySource: record.querySource} : {}),
      ...(target.defaultCredentialId ? {clientCredentialId: target.defaultCredentialId} : {}),
      agent: input.agentId,
      wireApi: adapter.syntheticWireApi ?? "messages",
    },
    request,
    response: {
      status,
      statusText,
      headers: detail?.responseHeaders ?? {},
      rawBody: responseRawBody,
      bodySizeBytes: byteLength(responseRawBody),
      bodySha256: sha256(responseRawBody),
      isStreaming: false,
    },
    bodyStorage: {policy: "inline"},
    captureDiagnostics: diagnostics,
    security: {
      containsSensitiveHeaders: false,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}

/**
 * thread-identity 折叠所需头合成：x-zcode-trace-id 折叠 Session、x-session-id 分
 * Thread（subagent 挂根）、x-zcode-session-type 控制展示 id 回填——与网关链路
 * 完全同一套规则。用户代理保留本地原值（fingerprint 证据）。
 */
function buildSyntheticRequestHeaders(
  record: LocalUsageRecord,
  detail: LocalExchangeDetail | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...(detail?.requestHeaders ?? {}),
    "user-agent": detail?.requestHeaders?.["user-agent"] ?? "ZCode/unknown (local-import)",
    "anthropic-version": detail?.requestHeaders?.["anthropic-version"] ?? "2023-06-01",
  };
  if (record.traceId) headers["x-zcode-trace-id"] = record.traceId;
  headers["x-session-id"] = record.sessionId;
  headers["x-zcode-session-type"] = record.querySource === "subagent" ? "subagent" : "main";
  // 原生 turn 边界（2026-09-16 修正）：rollout 请求体在 modelIoFullRetentionEnabled=false
  // 下 messages 为空，内容推断永远检测不到新用户输入，全部步骤会塌进一个 turn；
  // zcode model_usage.turn_id 是官方 turn 语义，合成头后由 thread-identity/turn 链路精确分 turn。
  if (record.turnId) headers["x-zcode-turn-id"] = record.turnId;
  // 认证头按网关链路「raw 只记占位」语义合成：本地数据本就无真实密钥。
  headers.authorization = "Bearer deepaa-gateway";
  headers["x-api-key"] = "deepaa-gateway";
  return headers;
}

/**
 * 响应组装：结构化聚合结果 → anthropic 非流式 message JSON。usage 恒以客户端
 * 自报权威值（model_usage 五维）为准；正文缺失时组装仅含 usage 的最小 body，
 * 保证 tokenUsageFromExchange 提取路径与账本永不缺数。
 * 口径转换（2026-09-16 实测修正）：zcode 的 inputTokens 为 OpenAI/GLM 口径
 * （包含缓存读取，实测 input+output=provider_total），而 anthropic wire 的
 * input_tokens 与 cache_read_input_tokens 分列——必须相减，否则页面把缓存
 * 部分双计入「非缓存输入」，Token 与费用虚高约一倍。
 */
function assembleResponseRawBody(
  record: LocalUsageRecord,
  detail: LocalExchangeDetail | undefined,
  modelId: string,
): string {
  const nonCachedInput = Math.max(0, record.usage.inputTokens - record.usage.cacheReadTokens);
  const usage = {
    input_tokens: nonCachedInput,
    output_tokens: record.usage.outputTokens,
    cache_read_input_tokens: record.usage.cacheReadTokens,
    cache_creation_input_tokens: record.usage.cacheCreationTokens,
  };
  const content: Array<Record<string, unknown>> = [];
  const response = detail?.response;
  if (response?.reasoningText?.trim()) content.push({type: "thinking", thinking: response.reasoningText});
  if (response?.text) content.push({type: "text", text: response.text});
  for (const call of response?.toolCalls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id ?? `toolu_local_${record.id}`,
      name: call.name ?? "unknown",
      input: call.input ?? {},
    });
  }
  if (content.length === 0 && record.status === "completed") {
    content.push({type: "text", text: ""});
  }
  const body = {
    id: detail?.responseId ?? `msg_local_${record.id}`,
    type: "message",
    role: "assistant",
    model: modelId,
    content,
    stop_reason: mapFinishReason(record),
    stop_sequence: null,
    usage,
  };
  return JSON.stringify(body);
}

/**
 * 请求体是否带系统提示/工具定义骨架（anthropic/OpenAI 两种 wire 形态）。
 * 缺骨架的请求不参与线程排重基线推进（见 export-content-events 的降级判定）。
 */
function requestBodyHasPromptSkeleton(requestRawBody: string): boolean {
  try {
    const parsed = JSON.parse(requestRawBody) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    if (parsed.system !== undefined && parsed.system !== null) return true;
    // responses wire 的系统提示位是 instructions（codex 直连回放体，2026-10-09）：
    // 空字符串不算（等价于缺失）。
    if (typeof parsed.instructions === "string" && parsed.instructions !== "") return true;
    return Array.isArray(parsed.tools) && parsed.tools.length > 0;
  } catch {
    return false;
  }
}

/** 结构化响应是否为空（无文本、无推理、无工具调用）。 */
function responseOverrideIsEmpty(
  response: LocalExchangeDetail["response"],
): boolean {
  if (!response) return true;
  const hasText = typeof response.text === "string" && response.text.trim().length > 0;
  const hasReasoning = typeof response.reasoningText === "string"
    && response.reasoningText.trim().length > 0;
  const hasTools = Array.isArray(response.toolCalls) && response.toolCalls.length > 0;
  return !hasText && !hasReasoning && !hasTools;
}

function mapFinishReason(record: LocalUsageRecord): string | null {
  if (record.status === "cancelled") return null;
  if (record.status === "error") return "error";
  const reason = record.finishReason;
  if (reason === "stop" || reason === "end_turn") return "end_turn";
  if (reason === "tool-calls" || reason === "tool_use") return "tool_use";
  if (reason === "length" || reason === "max-tokens") return "max_tokens";
  return reason ?? "end_turn";
}

function mapStatus(record: LocalUsageRecord): {
  status: number;
  statusText: string;
  diagnostics: RawCapturedExchangeV2["captureDiagnostics"];
} {
  const diagnostics: RawCapturedExchangeV2["captureDiagnostics"] = [];
  if (record.status === "cancelled") {
    return {status: 499, statusText: "Client Closed Request", diagnostics};
  }
  if (record.status === "error") {
    diagnostics.push({
      code: "upstream_error",
      severity: "error",
      message: record.errorMessage ?? record.errorCode ?? "本地记录：请求失败。",
    });
    const httpMatch = /(?:^|[^0-9])([45]\d{2})(?:[^0-9]|$)/.exec(record.errorCode ?? "");
    return {status: httpMatch ? Number(httpMatch[1]) : 502, statusText: "Local Import Error", diagnostics};
  }
  return {status: 200, statusText: "OK", diagnostics};
}

/** 只改写 body 顶层 model 字段为归一名；解析失败时保持原样（走缺正文/缺模型降级）。 */
function rewriteBodyModel(requestRawBody: string | undefined, modelId: string): string | undefined {
  if (requestRawBody === undefined) return undefined;
  try {
    const parsed = JSON.parse(requestRawBody) as Record<string, unknown>;
    if (typeof parsed.model !== "string" || parsed.model === modelId) return requestRawBody;
    parsed.model = modelId;
    return JSON.stringify(parsed);
  } catch {
    return requestRawBody;
  }
}

/**
 * 真实用户输入回填：messages 为空/缺失时注入单条 user 文本消息（anthropic wire 形态）。
 * 注入的正文来自 Agent 本地 message/part（经 parent_user_message_id 关联），是
 * zcode 官方记录的真实输入原文；解析失败或无正文时保持原样（走缺正文降级）。
 */
function ensureUserMessage(requestRawBody: string | undefined, userText: string | undefined): string | undefined {
  if (requestRawBody === undefined || !userText?.trim()) return requestRawBody;
  try {
    const parsed = JSON.parse(requestRawBody) as Record<string, unknown>;
    const messages = parsed.messages;
    if (Array.isArray(messages) && messages.length > 0) return requestRawBody;
    parsed.messages = [{role: "user", content: [{type: "text", text: userText}]}];
    return JSON.stringify(parsed);
  } catch {
    return requestRawBody;
  }
}

function byteLength(text: string | undefined): number {
  return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
}

function sha256(text: string | undefined): string {
  return createHash("sha256").update(text ?? "", "utf8").digest("hex");
}

/** 单侧正文内联阈值：超过转外置 gzip blob（与代理 256KiB 策略对齐），查看路径按需流式读取。 */
export const SYNTHETIC_INLINE_THRESHOLD_BYTES = 256 * 1024;

/**
 * 大正文外置化（dsh 式按需查看的存储侧配套）：请求/响应 body 超 256KiB 时写入
 * blobs/<2ch>/<sha>.body.gz（与代理 external-blob 约定一致，Worker 读取路径零改动），
 * 合成行只留 rawBodyRef——交互内容页单侧 Raw 按需流式加载、用完即释放。
 */
export async function materializeLargeBodies(
  dataDir: string,
  exchanges: RawCapturedExchangeV2[],
): Promise<void> {
  for (const exchange of exchanges) {
    for (const side of ["request", "response"] as const) {
      const body = exchange[side];
      if (body.rawBodyRef !== undefined) continue;
      const text = body.rawBody;
      if (typeof text !== "string" || Buffer.byteLength(text, "utf8") <= SYNTHETIC_INLINE_THRESHOLD_BYTES) continue;
      const sha = sha256(text);
      const gz = gzipSync(Buffer.from(text, "utf8"));
      const externalPath = join("blobs", sha.slice(0, 2), `${sha}.body.gz`);
      const fullPath = join(dataDir, externalPath);
      const tmpPath = `${fullPath}.tmp-${randomUUID()}`;
      await mkdir(dirname(fullPath), {recursive: true});
      await writeFile(tmpPath, gz);
      await rename(tmpPath, fullPath);
      body.rawBody = undefined;
      body.rawBodyRef = {
        storage: "external-blob",
        encoding: "gzip",
        sha256: sha,
        sizeBytes: Buffer.byteLength(text, "utf8"),
        compressedSizeBytes: gz.length,
        externalPath,
      };
    }
    if (exchange.request.rawBodyRef !== undefined || exchange.response.rawBodyRef !== undefined) {
      exchange.bodyStorage = {
        policy: "external-blob",
        compression: "gzip",
        externalBlobDir: "blobs",
        thresholdBytes: SYNTHETIC_INLINE_THRESHOLD_BYTES,
      };
    }
  }
}

/**
 * 合成行追加写入（独立于代理 capture-writer：会话 ID 前缀与轮转策略不同，
 * 且不得触碰代理模块）。单文件超阈值即轮转新会话；追加原子性由单写者调度器
 * （单飞 in-flight）保证，整批失败时由调度器重试（exchangeId 幂等兜底）。
 */
export class ImportCaptureFileWriter {
  private currentFile?: {sessionId: string; filePath: string; bytes: number};
  private nextSequence = 0;

  constructor(
    private readonly dataDir: string,
    private readonly agentId: string,
    private readonly maxFileBytes = 64 * 1024 * 1024,
  ) {}

  async appendBatch(exchanges: RawCapturedExchangeV2[]): Promise<void> {
    if (exchanges.length === 0) return;
    const directory = importCaptureDirectory(this.dataDir);
    await mkdir(directory, {recursive: true});
    let handle: FileHandle | undefined;
    try {
      let file = this.currentFile;
      if (file === undefined || file.bytes >= this.maxFileBytes) {
        const sessionId = createImportCaptureSessionId(this.agentId);
        file = {sessionId, filePath: join(directory, `${sessionId}.jsonl`), bytes: 0};
        this.currentFile = file;
      }
      const lines = exchanges.map(exchange => {
        // captureSessionId/sequence 由写入器统一赋值：与落盘文件严格一致，
        // 轮转发生在 build 与 append 之间也不会产生错配。
        exchange.captureSessionId = file!.sessionId;
        exchange.sequence = this.nextSequence;
        this.nextSequence += 1;
        return Buffer.from(`${JSON.stringify(exchange)}\n`, "utf8");
      });
      const payload = Buffer.concat(lines);
      handle = await open(file.filePath, "a");
      await handle.write(payload, 0, payload.length, null);
      file.bytes += payload.length;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
    }
  }
}
