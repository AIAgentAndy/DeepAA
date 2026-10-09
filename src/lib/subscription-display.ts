/**
 * 订阅通道（billingChannel=subscription）用户提示文案的唯一出处（2026-10-08 用户确认按预设分化）。
 *
 * 订阅目标与官方 CLI 一一对应：openai-subscription → Codex CLI、anthropic-subscription →
 * Claude Code CLI。提示必须按目标分化，不得再向单一订阅目标输出「codex login / claude 后
 * 输入 /login」合并文案误导另一家订阅的用户；仅识别不出归属的订阅目标（理论上仅手工编辑
 * 配置产生）才回退合并文案。消费面：接入向导 Agent 步、开发启动弹窗、套餐同步失败提示。
 */

import {agentLabel} from "@/lib/agent-registry";
import {resolveOfficialPresetForTarget} from "@/lib/provider-preset-capabilities";

export interface SubscriptionLoginHint {
  /** 官方 CLI 的用户可读名称，如 "Codex CLI"。 */
  readonly cliLabel: string;
  /** 重新登录命令本体，如 "codex login"。 */
  readonly reloginCommand: string;
  /** 含终端指引的完整重新登录步骤，如 "在终端执行 codex login"。 */
  readonly reloginSteps: string;
}

/** 与订阅预设结构同构的目标引用（ProxyTarget 的一个结构子集）。 */
type SubscriptionTargetRef = Parameters<typeof resolveOfficialPresetForTarget>[0];

const CODEX_HINT: SubscriptionLoginHint = {
  cliLabel: "Codex CLI",
  reloginCommand: "codex login",
  reloginSteps: "在终端执行 codex login",
};

const CLAUDE_HINT: SubscriptionLoginHint = {
  cliLabel: "Claude Code CLI",
  reloginCommand: "claude 后输入 /login",
  reloginSteps: "在终端进入 claude 后输入 /login",
};

const COMBINED_HINT: SubscriptionLoginHint = {
  cliLabel: "Codex / Claude 官方 CLI",
  reloginCommand: "codex login / claude 后输入 /login",
  reloginSteps: "在终端执行 codex login，或进入 claude 后输入 /login",
};

/**
 * 订阅预设 id（与套餐 providerType 同串）→ 登录指引声明表。新增订阅预设加一行即可，
 * 不得在控制流里写 agent 名分支（Agent 扩展面守卫 ratchet，
 * tests/agent-extension-guard.test.ts）。
 */
const PRESET_LOGIN_HINTS: Readonly<Record<string, SubscriptionLoginHint>> = {
  "openai-subscription": CODEX_HINT,
  "anthropic-subscription": CLAUDE_HINT,
};

/**
 * Agent id → 登录指引声明表。仅登记「官方 CLI 直连型订阅」的 Agent（登录与续期由其
 * 官方 CLI 维护）；zcode 等自带登录态的透传 Agent 不登记，由调用方走通用兜底文案。
 */
const AGENT_LOGIN_HINTS: Readonly<Record<string, SubscriptionLoginHint>> = {
  codex: CODEX_HINT,
  claude: CLAUDE_HINT,
};

/**
 * 按键解析订阅登录指引；key 兼容订阅预设 id（openai-subscription / anthropic-subscription）、
 * 套餐同步 providerType（与预设 id 同串）与 Agent id（codex / claude）。其余返回 undefined，
 * 由调用方决定回退。命中走声明表查询，不写 agent 名条件分支。
 */
export function subscriptionLoginHint(key: string | null | undefined): SubscriptionLoginHint | undefined {
  if (!key) return undefined;
  return PRESET_LOGIN_HINTS[key] ?? AGENT_LOGIN_HINTS[key];
}

/**
 * 订阅目标的登录指引：预设精确命中；无预设的自定义订阅目标按已配置的协议 URL 判定
 * （订阅透传门禁只放行 openai（responses→Codex）与 anthropic（messages→Claude）两类
 * binding）；双协议并存无法归一时回退合并文案。
 */
export function subscriptionLoginHintForTarget(target: SubscriptionTargetRef): SubscriptionLoginHint {
  const viaPreset = subscriptionLoginHint(resolveOfficialPresetForTarget(target)?.id);
  if (viaPreset) return viaPreset;
  if (target.openaiUrl && !target.anthropicUrl) return CODEX_HINT;
  if (target.anthropicUrl && !target.openaiUrl) return CLAUDE_HINT;
  return COMBINED_HINT;
}

/** 接入向导 Agent 选择步的订阅提示；向导自行追加「只选择本次需要接入的 Agent」等引导语。 */
export function subscriptionWizardNotice(target: SubscriptionTargetRef): string {
  const hint = subscriptionLoginHintForTarget(target);
  if (hint === CODEX_HINT) {
    // codex 因 ChatGPT 原生 wire 阻断（2026-10-09 实证）只能走「官方模式 + 直连导入」。
    return "OpenAI 订阅预设不支持经网关使用（ChatGPT 登录协议差异）：请在 Agent 接入页将 Codex 切换为「官方模式」原生使用，DeepAA 通过本机数据直连导入捕获用量。";
  }
  return `订阅预设模型经网关透传本机 ${hint.cliLabel} 登录态，无需系统密钥（默认目标可为任意供应商，中转站模型仍走密钥注入）；登录与续期由官方 CLI 维护（${hint.reloginCommand}）。`;
}

/**
 * 开发启动弹窗的订阅提示：启动哪个客户端就提示谁的登录。codex / claude 之外的 Agent
 * 理论上只有 zcode 能命中订阅目标（messages 透传门禁），按其自带登录态作通用表述。
 */
export function subscriptionLaunchNotice(agent: string): string {
  const hint = subscriptionLoginHint(agent);
  if (hint === CODEX_HINT) {
    return "OpenAI 订阅模型不支持经网关启动（ChatGPT 登录协议差异）：请将 Codex 切换为「官方模式」后直接使用官方客户端，DeepAA 自动导入本机用量。";
  }
  if (hint) {
    return `网关模型目录中的订阅预设模型透传本机 ${hint.cliLabel} 登录态，无需系统密钥；中转站模型仍走密钥注入。启动前请确认已登录（${hint.reloginSteps}），登录与续期由官方 CLI 自动维护。`;
  }
  return `订阅通道使用本机 ${agentLabel(agent)} 自带登录态透传，无需系统密钥；启动前请确认该客户端已登录，登录与续期由其官方客户端自动维护。`;
}

/** 套餐同步失败（SUBSCRIPTION_OAUTH_REJECTED，401/403 真过期）时的重新登录指引，按套餐 providerType 分化。 */
export function subscriptionReloginNotice(providerType: string | null | undefined): string {
  const hint = subscriptionLoginHint(providerType);
  return `订阅凭据已过期，请${hint ? hint.reloginSteps : COMBINED_HINT.reloginSteps}；重新登录后推理与用量同步会自动恢复，无需重新导入。`;
}

/**
 * 套餐同步失败 SUBSCRIPTION_OAUTH_NOT_FOUND（本机从未登录 / 凭据缺失 / API Key 模式）的
 * 登录指引。与「已过期」严格分化（2026-10-08 用户确认）：从未登录却说「已过期」会误导用户。
 */
export function subscriptionLoginMissingNotice(providerType: string | null | undefined): string {
  const hint = subscriptionLoginHint(providerType);
  return `未检测到本机 ${hint ? hint.cliLabel : COMBINED_HINT.cliLabel} 登录态（未登录或为 API Key 模式），请${hint ? hint.reloginSteps : COMBINED_HINT.reloginSteps}；登录后推理与用量同步自动生效，无需重新导入。`;
}

/** 套餐同步网络层失败（PLAN_FETCH_FAILED_*）：官方用量接口不可达时的可执行指引。 */
export function subscriptionNetworkNotice(providerType: string | null | undefined): string {
  const host = providerType === "openai-subscription" ? "chatgpt.com"
    : providerType === "anthropic-subscription" ? "api.anthropic.com"
    : "官方服务";
  return `无法连接官方用量接口 ${host}：请确认本机网络可访问该域名（必要时开启代理），再点击“同步套餐”重试。`;
}

// ———————— Codex CLI 形态联动（2026-10-09 用户确认，本期仅 codex，claude 不涉及） ————————

/** 启动弹窗对 Codex 的 CLI 形态要求：官方直连（openai-subscription 预设）或网关（其它供应商）。 */
export type CodexCliForm = "official" | "gateway";

/** 目标是否为 OpenAI 订阅预设（chatgpt 官方直连）；唯一触发「需要官方模式」的预设。 */
export function isOpenAiSubscriptionTarget(target: SubscriptionTargetRef): boolean {
  return resolveOfficialPresetForTarget(target)?.id === "openai-subscription";
}

/**
 * Codex 启动弹窗按所选供应商推导所需 CLI 形态：OpenAI 订阅预设因 ChatGPT 原生
 * wire（请求体无 model 字段）无法经网关路由，必须官方直连；其余供应商（中转站、
 * 按量等）走网关。启动弹窗据此展示当前形态并在形态不符时提供「确认切换并启动」。
 */
export function codexCliFormForTarget(target: SubscriptionTargetRef): CodexCliForm {
  return isOpenAiSubscriptionTarget(target) ? "official" : "gateway";
}
