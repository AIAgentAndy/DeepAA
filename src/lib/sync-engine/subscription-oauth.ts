/**
 * OpenAI / Anthropic 订阅账号 OAuth 用量查询的只读数据源。
 *
 * 订阅额度接口没有公开余额，只返回时间窗百分比（OpenAI wham/usage、
 * Anthropic api/oauth/usage）。本模块只做两件事：
 * 1. 只读发现本机 Codex / Claude CLI 已保存的 OAuth 凭据（绝不落盘、绝不刷新）；
 * 2. 把两个官方接口的响应解析成统一的 PlanQuotaSnapshotInput。
 */

import {execFile} from "node:child_process";
import {readFile} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import https from "node:https";
import {
  isOfficialUpstreamHost,
  resolveOfficialUpstreamProxy,
  type UpstreamProxyEndpoint,
} from "@/proxy/official-upstream";
import {createConnectTunnelHttpsAgent} from "@/proxy/upstream-proxy";
import type {PlanQuotaSnapshotInput} from "./types";

export interface CodexOAuthAuth {
  accessToken: string;
  accountId?: string;
}

/**
 * 订阅官方用量接口统一取数入口：网络层失败（断连/DNS/超时）折叠为稳定错误码
 * `PLAN_FETCH_FAILED_<底层码>`（ENOTFOUND/ETIMEDOUT/ECONNRESET/TIMEOUT…），
 * 不把裸 "fetch failed" 透传到同步失败提示（2026-10-08 用户确认）。
 *
 * 国际官方域（白名单与 3211 网关同一份常量）且探测到系统代理时，经 CONNECT
 * 隧道出站——Node 全局 fetch 不读系统代理，国内网络直连官方域超时的根因修复；
 * 非白名单域、无代理与注入 fetchImpl 的测试路径维持全局 fetch 原行为。
 */
export async function fetchOfficialUsage(
  url: string,
  init: RequestInit,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  try {
    if (!fetchImpl) {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" && isOfficialUpstreamHost(parsed.hostname)) {
        const proxy = await resolveOfficialUpstreamProxy(parsed.hostname);
        if (proxy) return await fetchOfficialUsageViaTunnel(parsed, init, proxy);
      }
    }
    return await (fetchImpl || fetch)(url, init);
  } catch (error) {
    const code = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
      ? "TIMEOUT"
      : readFetchErrorCode(error);
    throw new Error(`PLAN_FETCH_FAILED_${code}`);
  }
}

/** 用量响应体收集上限：官方窗口 JSON 为小体量，超限视为异常（OOM 红线）。 */
const OFFICIAL_USAGE_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/** 经 CONNECT 隧道完成 GET 并折叠为标准 Response；signal 中止与体积上限双兜底。 */
function fetchOfficialUsageViaTunnel(
  url: URL,
  init: RequestInit,
  proxy: UpstreamProxyEndpoint,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const agent = createConnectTunnelHttpsAgent(proxy, {keepAlive: false});
    const request = https.request(url, {
      method: "GET",
      headers: flattenRequestHeaders(init),
      agent,
    }, response => {
      const chunks: Buffer[] = [];
      let total = 0;
      let finished = false;
      const finish = (error?: Error): void => {
        if (finished) return;
        finished = true;
        agent.destroy();
        if (error) {
          reject(error);
          return;
        }
        const status = response.statusCode && response.statusCode >= 200 && response.statusCode <= 599
          ? response.statusCode
          : 502;
        resolve(new Response(Buffer.concat(chunks), {status, headers: flattenResponseHeaders(response.headers)}));
      };
      response.on("data", (chunk: Buffer) => {
        if (finished) return;
        total += chunk.length;
        if (total > OFFICIAL_USAGE_BODY_LIMIT_BYTES) {
          finish(new Error("PLAN_USAGE_BODY_TOO_LARGE"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => finish());
      response.once("error", finish);
    });
    request.once("error", error => {
      agent.destroy();
      reject(error);
    });
    const signal = init.signal;
    if (signal) {
      const abort = () => request.destroy(signal.reason instanceof Error
        ? signal.reason
        : new Error("Aborted"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, {once: true});
    }
    request.end();
  });
}

function flattenRequestHeaders(init: RequestInit): Record<string, string> {
  const headers = init.headers;
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : String(value)]),
  );
}

function flattenResponseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const flattened: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    flattened[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flattened;
}

function readFetchErrorCode(error: unknown): string {
  const cause = (error as {cause?: unknown}).cause;
  const code = (cause as {code?: unknown} | undefined)?.code;
  return typeof code === "string" && code !== "" ? code : "UNKNOWN";
}

/** 读取 Codex auth.json（只读）。auth_mode 必须为 chatgpt，否则视为未配置。 */
export async function readCodexOAuthAuth(
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
): Promise<CodexOAuthAuth | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8")) as {
      auth_mode?: string;
      tokens?: {access_token?: string; account_id?: string};
    };
    if (parsed.auth_mode !== "chatgpt" || !parsed.tokens?.access_token) return undefined;
    return {
      accessToken: parsed.tokens.access_token,
      accountId: parsed.tokens.account_id,
    };
  } catch {
    return undefined;
  }
}

/**
 * 读取 Claude OAuth 凭据（优先 macOS Keychain，其次凭据文件），返回 accessToken。
 * preferFile 用于测试或明确指定文件来源时跳过 Keychain，避免误读真实账号。
 */
export async function readClaudeOAuthCredentials(
  claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  options: {preferFile?: boolean} = {},
): Promise<string | undefined> {
  if (!options.preferFile && process.platform === "darwin") {
    const fromKeychain = await readClaudeKeychain();
    if (fromKeychain) return fromKeychain;
  }
  try {
    const parsed = JSON.parse(
      await readFile(join(claudeHome, ".credentials.json"), "utf8"),
    ) as Record<string, {accessToken?: string}>;
    const entry = parsed.claudeAiOauth || parsed["claude.ai_oauth"];
    return entry?.accessToken || undefined;
  } catch {
    return undefined;
  }
}

/** 从 macOS Keychain 读取 Claude Code-credentials（只读，无条目时静默返回 undefined）。 */
function readClaudeKeychain(): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      (error, stdout) => {
        if (error) return resolve(undefined);
        try {
          const parsed = JSON.parse(stdout.trim()) as Record<string, {accessToken?: string}>;
          const entry = parsed.claudeAiOauth || parsed["claude.ai_oauth"];
          resolve(entry?.accessToken || undefined);
        } catch {
          resolve(undefined);
        }
      },
    );
  });
}

const OPENAI_PLAN_LABEL = "OpenAI 订阅（ChatGPT/Codex）";
const ANTHROPIC_PLAN_LABEL = "Anthropic 订阅（Claude Max/Pro）";

function percentWindow(
  planName: string,
  windowLabel: string,
  used: number,
  resetAt?: string,
): PlanQuotaSnapshotInput {
  return {planName, windowLabel, used, total: 100, unit: "percent", resetAt, raw: {used, resetAt}};
}

/** 解析 ChatGPT backend wham/usage：按 limit_window_seconds 映射窗口。 */
export function parseOpenAiWhamUsage(payload: unknown): PlanQuotaSnapshotInput[] {
  const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const snapshots: PlanQuotaSnapshotInput[] = [];
  const pushWindow = (window: unknown, fallbackLabel: string, fixedLabel?: string): void => {
    const record = (window && typeof window === "object" ? window : {}) as Record<string, unknown>;
    const used = finite(record.used_percent);
    if (used === undefined) return;
    const seconds = finite(record.limit_window_seconds);
    const windowLabel = fixedLabel
      ?? (seconds === 2592000 ? "30d" : seconds === 604800 ? "weekly" : fallbackLabel);
    snapshots.push(percentWindow(OPENAI_PLAN_LABEL, windowLabel, used, epochResetAt(record.reset_at)));
  };
  const rateLimit = (body.rate_limit && typeof body.rate_limit === "object"
    ? body.rate_limit
    : {}) as Record<string, unknown>;
  pushWindow(rateLimit.primary_window, "5h");
  pushWindow(rateLimit.secondary_window, "weekly");
  const codeReview = (body.code_review_rate_limit && typeof body.code_review_rate_limit === "object"
    ? body.code_review_rate_limit
    : {}) as Record<string, unknown>;
  pushWindow(codeReview.primary_window, "code_review", "code_review");
  return snapshots;
}

/**
 * 解析 Anthropic api/oauth/usage：5h/7d（按 rate-limit 组跨模型聚合的共享池口径，
 * 2026-09-30 docs.claude.com/en/api/oauth 核对；接口另有按组的 seven_day_* 细分窗口）
 * + usage credits（官方现名，旧称 extra_usage；美分转美元）。
 */
export function parseAnthropicOAuthUsage(payload: unknown): PlanQuotaSnapshotInput[] {
  const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const snapshots: PlanQuotaSnapshotInput[] = [];
  const known: Record<string, string> = {
    five_hour: "5h",
    seven_day: "weekly",
    seven_day_opus: "weekly_opus",
    seven_day_sonnet: "weekly_sonnet",
  };
  for (const [key, windowLabel] of Object.entries(known)) {
    const window = body[key];
    if (!window || typeof window !== "object") continue;
    const record = window as Record<string, unknown>;
    const used = finite(record.utilization);
    if (used === undefined) continue;
    const resetAt = typeof record.resets_at === "string" ? record.resets_at : undefined;
    snapshots.push(percentWindow(ANTHROPIC_PLAN_LABEL, windowLabel, used, resetAt));
  }
  // 未知的 seven_day_* 模型级窗口继续保留，避免新版模型窗口被丢弃。
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith("seven_day_") || known[key]) continue;
    const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const used = finite(record.utilization);
    if (used !== undefined) {
      snapshots.push(percentWindow(
        ANTHROPIC_PLAN_LABEL,
        key,
        used,
        typeof record.resets_at === "string" ? record.resets_at : undefined,
      ));
    }
  }
  const extra = (body.extra_usage && typeof body.extra_usage === "object"
    ? body.extra_usage
    : {}) as Record<string, unknown>;
  if (extra.is_enabled === true) {
    const usedCredits = finite(extra.used_credits);
    const monthlyLimit = finite(extra.monthly_limit);
    if (usedCredits !== undefined || monthlyLimit !== undefined) {
      snapshots.push({
        planName: ANTHROPIC_PLAN_LABEL,
        windowLabel: "extra_usage",
        used: usedCredits === undefined ? undefined : usedCredits / 100,
        total: monthlyLimit === undefined ? undefined : monthlyLimit / 100,
        unit: "USD",
        raw: extra,
      });
    }
  }
  return snapshots;
}

function finite(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function epochResetAt(value: unknown): string | undefined {
  const seconds = finite(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}
