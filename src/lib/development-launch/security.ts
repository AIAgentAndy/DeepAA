import { randomBytes } from "crypto";
import { isLoopbackHostname, isSameLocalEntrypoint } from "@/lib/local-endpoints";

// nonce 单次使用；TTL 覆盖长流程（向导多步、填表单）而不失时效性。
const DEFAULT_NONCE_TTL_MS = 30 * 60_000;
const MAX_NONCES = 1_000;
const MAX_JSON_BYTES = 64 * 1024;

export class DevelopmentLaunchError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    message = code,
  ) {
    super(message);
    this.name = "DevelopmentLaunchError";
  }
}

export class LaunchNonceStore {
  private readonly values = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_NONCE_TTL_MS;
    this.now = options.now || Date.now;
  }

  issue(): string {
    this.prune();
    if (this.values.size >= MAX_NONCES) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest) this.values.delete(oldest);
    }
    const nonce = randomBytes(32).toString("base64url");
    this.values.set(nonce, this.now() + this.ttlMs);
    return nonce;
  }

  consume(nonce: unknown): boolean {
    if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) return false;
    const expiresAt = this.values.get(nonce);
    this.values.delete(nonce);
    return expiresAt !== undefined && expiresAt > this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [nonce, expiresAt] of this.values) {
      if (expiresAt <= now) this.values.delete(nonce);
    }
  }
}

const sharedNonceStore = new LaunchNonceStore();

export function getLaunchNonceStore(): LaunchNonceStore {
  return sharedNonceStore;
}

export function assertLocalMutationRequest(request: Request): void {
  assertLocalRequestOrigin(request, true);
}

/** 配置文件等敏感只读接口也只允许当前 loopback 页面访问，但不要求 JSON Content-Type。 */
export function assertLocalReadRequest(request: Request): void {
  assertLocalRequestOrigin(request, false);
}

function assertLocalRequestOrigin(request: Request, requireJson: boolean): void {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  const fetchSite = request.headers.get("sec-fetch-site");
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!host || (requireJson && !contentType.startsWith("application/json"))) {
    throw new DevelopmentLaunchError("LOCAL_ORIGIN_REQUIRED", 403);
  }
  // 浏览器对同源 GET 通常不发送 Origin；Fetch Metadata 的 same-origin
  // 与 loopback Host/URL 组合已经足以确认这是当前本地页面的读取请求。
  if (!origin) {
    if (requireJson || fetchSite !== "same-origin" || !isLoopbackHostHeader(host, request.url)) {
      throw new DevelopmentLaunchError("LOCAL_ORIGIN_REQUIRED", 403);
    }
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new DevelopmentLaunchError("LOCAL_ORIGIN_REQUIRED", 403);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !isLoopbackHostname(parsed.hostname)
    || parsed.host.toLowerCase() !== host.toLowerCase()
    || fetchSite !== "same-origin"
  ) {
    throw new DevelopmentLaunchError("LOCAL_ORIGIN_REQUIRED", 403);
  }
}

function isLoopbackHostHeader(host: string, requestUrl: string): boolean {
  try {
    const parsedHost = new URL(`http://${host}`);
    const parsedRequest = new URL(requestUrl);
    // Next 16 生产服务会把路由处理器的 request.url 主机名规范化为 localhost，
    // 与实际 Host 头（127.0.0.1 等回环别名）字面不同但同机等价；与 raw-stream-gateway
    // 的 assertRawStreamRequest 共用 local-endpoints 的同一份「同机等价」判定，
    // 非回环主机（DNS rebinding / 跨站伪造）与端口不符仍然拒绝。
    return parsedHost.host.toLowerCase() === host.toLowerCase()
      && isLoopbackHostname(parsedHost.hostname)
      && isLoopbackHostname(parsedRequest.hostname)
      && isSameLocalEntrypoint(parsedHost, parsedRequest);
  } catch {
    return false;
  }
}

export async function readBoundedJson(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new DevelopmentLaunchError("REQUEST_TOO_LARGE", 413);
  }
  const raw = await readBoundedRequestText(request);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new DevelopmentLaunchError("INVALID_JSON", 400);
  }
}

async function readBoundedRequestText(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DevelopmentLaunchError("REQUEST_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf-8");
}

export function requireLaunchNonce(body: Record<string, unknown>): void {
  if (!sharedNonceStore.consume(body.nonce)) {
    throw new DevelopmentLaunchError("LAUNCH_NONCE_INVALID", 403);
  }
}

export function developmentLaunchErrorResponse(error: unknown): Response {
  const normalized = normalizeDevelopmentLaunchError(error);
  return Response.json({ error: normalized.code, message: userMessage(normalized.code, normalized.message) }, {
    status: normalized.status,
  });
}

function normalizeDevelopmentLaunchError(error: unknown): DevelopmentLaunchError {
  if (error instanceof DevelopmentLaunchError) return error;
  // 保留原始错误信息（detail）：未知错误不再只显示笼统的「本地开发环境操作失败」。
  const detail = error instanceof Error ? error.message : String(error);
  const rawCode = error instanceof Error ? error.message.split(":", 1)[0] : "";
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(rawCode)
    ? rawCode
    : "DEVELOPMENT_LAUNCH_FAILED";
  const status = code === "TARGET_NOT_FOUND" || code === "CREDENTIAL_NOT_FOUND"
    ? 404
    : code === "CONFIG_REVISION_CONFLICT" ? 409 : 400;
  return new DevelopmentLaunchError(code, status, detail);
}

function userMessage(code: string, detail?: string): string {
  const messages: Record<string, string> = {
    UNSUPPORTED_PLATFORM: "当前版本仅支持 macOS 和 Windows",
    LOCAL_ORIGIN_REQUIRED: "仅允许从当前本地页面执行此操作",
    AGENT_NOT_CONNECTED: "请先在供应商管理页接入该 Agent",
    AGENT_TARGET_NOT_BOUND: "该供应商尚未接入当前 Agent，请先建立供应商绑定",
    LAUNCH_NONCE_INVALID: "操作凭证已失效，请重试",
    INVALID_REQUEST: "请求参数无效，请检查后重试",
    PROTOCOL_NOT_CONFIGURED: "该供应商未配置对应协议的网关 URL，请先在供应商管理页配置",
    INVALID_JSON: "请求内容不是有效 JSON",
    REQUEST_TOO_LARGE: "请求内容超过大小上限",
    TARGET_NOT_FOUND: "供应商不存在，请刷新配置",
    TARGET_DISABLED: "请先启用并保存供应商",
    INVALID_LOCAL_BASE_URL: "供应商的本地地址无效",
    INVALID_PROJECT_DIR: "请选择有效的项目目录",
    DIRECTORY_PICKER_BUSY: "目录选择器已打开，请先完成当前选择",
    DIRECTORY_PICKER_FAILED: "系统目录选择器打开失败",
    DIRECTORY_PICKER_NOT_SHOWN: "目录选择窗口 30 秒内未能弹出，已自动取消，请重试",
    INVALID_OVERRIDE: "高级设置包含无效参数，请检查后重试",
    INVALID_RESUME_SESSION_ID: "Session ID 必须是规范 UUID，或留空以新建会话",
    MODEL_REQUIRED: "模型不能为空，请重新选择",
    MODEL_PRICE_MAPPING_REQUIRED: "所选模型缺少价格中心映射，不能启动",
    MODEL_PRICE_ENTRY_NOT_FOUND: "所选模型引用的价格中心条目已不存在，请重新选择价格映射",
    MODEL_PRICE_VENDOR_MISMATCH: "所选模型的价格中心供应商与供应商映射不一致，请重新选择",
    MODEL_PRICE_RUNTIME_MISMATCH: "所选价格中心条目的模型 ID 与 Agent 可见模型不一致，请重新选择",
    MODEL_PRICE_MISSING: "所选价格中心条目缺少有效输入或输出价格，请先补齐价格",
    PRICING_VENDOR_REQUIRED: "请先为供应商配置模型供应商",
    PRICING_CATALOG_UNAVAILABLE: "模型价格目录读取失败，请稍后重试",
    MODEL_SELECTION_REQUIRED: "请选择模型",
    MODEL_NOT_SUPPORTED_BY_TARGET: "所选模型不属于该供应商或不适用当前 Agent，请重新选择",
    MODEL_WIRE_API_UNSUPPORTED: "所选模型不支持当前 Agent 需要的接口协议，请在模型下拉中选择受支持的模型",
    INVALID_LAUNCH_PREFERENCE: "高级设置包含无效参数，请检查后重试",
    OPENCODE_WIRE_API_REQUIRED: "无法确定 OpenCode 的接口协议，请检查模型的协议能力",
    TASK_REQUIRED: "请填写一次性任务内容",
    RESUME_NOT_SUPPORTED: "该 Agent 不支持恢复历史会话，请留空新建会话",
    DSH_DESKTOP_APP_NOT_FOUND: "未检测到 DeepSeek Harness 桌面客户端，请先安装或改用 Web 方式启动",
    PROXY_CONFIG_NOT_APPLIED: "代理配置尚未生效，请稍后重试或重启本地服务",
    CLAUDE_SETTINGS_REQUIRED: "Claude 临时配置缺失，请重试启动",
    CODEX_CONFIG_TOO_LARGE: "Codex 配置文件超出可安全处理的大小，请检查 ~/.codex/config.toml",
    CODEX_CONFIG_WRITE_INVALID: "Codex 配置写入自校验失败，已取消本次写入以防损坏配置，请检查 ~/.codex/config.toml",
    COMMAND_TIMEOUT: "系统命令执行超时，请重试",
    COMMAND_NOT_READY: "系统命令未能就绪，已自动取消，请重试",
    COMMAND_OUTPUT_TOO_LARGE: "系统命令输出超出限制，请重试",
    CREDENTIAL_LAST_REQUIRED: "每个供应商至少保留一条密钥，不能删除最后一条",
    CREDENTIAL_METADATA_TOO_LARGE: "密钥元数据超出存储上限，请精简后重试",
    CREDENTIAL_NOT_ALLOWED_FOR_AGENT: "所选密钥不适用于当前 Agent，请重新选择",
    INVALID_CREDENTIAL_METADATA: "密钥元数据无效，请重试",
    INVALID_RATE_MULTIPLIER: "密钥倍率数值无效，请输入正数",
    INVALID_LAUNCH_ARGUMENT: "启动参数无效，请检查后重试",
    INVALID_LAUNCH_ENVIRONMENT: "启动环境变量无效，请检查后重试",
    TARGET_REQUIRED: "请先选择供应商",
    PRICING_ENTRY_ID_CONFLICT: "价格中心存在重复条目 ID，请先修复价格中心后再继续",
    PRICING_VENDOR_MODEL_CONFLICT: "价格中心存在同一供应商与模型的冲突价格，请先修复价格中心后再继续",
    PRICE_CENTER_INVALID: "价格中心数据无效，请先修复价格中心后再继续",
    PRICE_CENTER_ENTRY_CONFLICT: "价格中心条目存在冲突，请先修复价格中心后再继续",
    MODEL_NOT_AVAILABLE_FOR_VENDOR: "所选模型不属于当前供应商的模型供应商",
    MODEL_SELECTION_STALE: "供应商或模型目录已更新，请重新选择模型",
    CREDENTIAL_REQUIRED: "请选择可用密钥",
    CREDENTIAL_NOT_FOUND: "密钥不存在或不属于当前供应商",
    CREDENTIAL_LABEL_REQUIRED: "请输入 1 至 80 个字符的密钥名称",
    CREDENTIAL_SECRET_REQUIRED: "请输入有效密钥内容",
    CREDENTIAL_LIMIT_EXCEEDED: "保存的开发密钥数量已达上限",
    CLI_NOT_FOUND: "未检测到对应的命令行工具",
    TERMINAL_NOT_FOUND: "未检测到可用终端",
    CREDENTIAL_STORE_UNAVAILABLE: "系统凭据库不可用",
    CREDENTIAL_WRITE_FAILED: "密钥写入系统凭据库失败",
    CREDENTIAL_READ_FAILED: "密钥无法从系统凭据库读取",
    CREDENTIAL_DELETE_FAILED: "密钥从系统凭据库删除失败",
    CREDENTIAL_OAUTH_EXPIRED: "Codex OAuth 登录已过期，请执行 codex login 重新登录（订阅通道无需重新导入）",
    TERMINAL_LAUNCH_FAILED: "终端启动失败，请检查系统权限",
    LAUNCH_IN_PROGRESS: "已有启动操作正在进行",
    MODEL_DISCOVER_HTTP_404: "该地址的模型接口不存在，请确认上游 URL 是否正确",
    MODEL_DISCOVER_ENDPOINT_NOT_FOUND: "未找到可用的模型接口，请确认上游 URL 是否支持 /v1/models 或 /models",
    MODEL_DISCOVER_RESPONSE_INVALID: "上游模型接口返回格式无法识别，请确认填写的是 OpenAI 兼容 API 地址而不是控制台网页地址",
    MODEL_DISCOVER_AUTH_REQUIRED: "模型接口需要密钥鉴权，请添加一条密钥后重试",
    MODEL_DISCOVER_AUTH_INVALID: "密钥无法通过该地址的鉴权，请检查密钥是否有效",
    PRESET_MODEL_DISCOVERY_UNSUPPORTED: "官方预设的模型由预设目录维护，无需探测上游模型；如需调整请返回基础配置修改预设模型",
    PROTOCOL_URL_REQUIRED: "请先配置该供应商的上游 URL",
    PROVIDER_PRESET_NOT_FOUND: "供应商预设不存在或已下线",
    PROVIDER_PRESET_URL_MISMATCH: "官方预设 URL 已被修改，请切换为非官方预设后按自定义供应商流程保存",
    PRESET_WIRE_API_UNSUPPORTED: "当前官方预设的 OpenAI 接口不支持 Codex Responses，请改用 Claude Code 或等待供应商开放 Responses",
    DUPLICATE_TARGET_ID: "路由 ID 已被其它供应商使用，请修改后重试",
    DUPLICATE_TARGET_URL: "该上游 URL 已由其它供应商接管，不能重复创建",
    ROUTE_ID_DERIVATION_CONFLICT: "自动生成的路由 ID 候选已用尽且均被占用，请在自定义设置中手动修改路由 ID",
    INVALID_TARGET_ID: "路由 ID 只能包含小写字母、数字、点和连字符，且不能含下划线",
    CONFIG_REVISION_CONFLICT: "代理配置已被其他操作更新，请刷新后重试",
    CONFIG_IMPORT_MODEL_SELECTION_REQUIRED: "请至少选择一个可计价模型后再导入",
    CONFIG_IMPORT_MODEL_SELECTION_STALE: "导入模型目录已发生变化，请重新扫描后确认",
    CONFIG_IMPORT_DEFAULT_MODEL_REQUIRED: "所选模型无法覆盖本次导入 Agent 的默认模型，请重新选择",
    CONFIG_IMPORT_NO_PRICED_MODELS: "官方预设没有可计价模型，暂时无法导入",
    PROVIDER_CATALOG_UNAVAILABLE: "供应商模型目录读取失败，请稍后重试",
    PLAN_CREDENTIAL_REQUIRED: "请选择一条属于当前供应商的套餐同步密钥",
    PLAN_CREDENTIAL_TARGET_MISMATCH: "所选套餐同步密钥不存在或不属于当前供应商",
    PLAN_PROVIDER_UNSUPPORTED: "当前套餐适配器不受支持",
    PLAN_SYNC_NOT_CONFIGURED: "请先配置套餐同步",
    VOLCENGINE_AK_SK_REQUIRED: "火山方舟套餐同步需要同时填写 AccessKey ID 和 SecretAccessKey",
  };
  // 未知错误带上原始原因，避免用户只看到笼统文案而无法定位问题。
  return messages[code] || (detail ? `操作失败：${detail}` : "本地开发环境操作失败");
}
