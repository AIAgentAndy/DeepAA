import { buildGatewayModelId } from "@/proxy/gateway-prefix";
import {
  GATEWAY_PLACEHOLDER_TOKEN,
  GATEWAY_PROVIDER_ID,
} from "@/lib/config-sync/core/placeholder-auth";
import type {CliSyncWarning} from "@/lib/config-sync/core/types";
import { launchCommandInTerminal } from "../terminal-launcher";
import {
  genericPreferencesNormalizer,
  ensureCodexConfigParsable,
  ensureCodexGatewayPlaceholderAuth,
  preSyncManagedConfig,
  removeCodexPlaceholderAuth,
  resolveCodexConfig,
    validateLocalBaseUrl,
  writeCodexDefaultModel,
} from "./shared";
import type { StrategyCommandArgsInput } from "./types";
import {AGENT_LAUNCH_DECLARATIONS, normalizeResumeSessionIdByKind} from "./contracts";

/**
 * Codex 策略：终端 CLI（Responses）+ 桌面客户端模式（terminal=codex-client）。
 * 客户端模式：目录选填、跳过系统终端；先同步受管配置（弹窗偏好 → 目录条目），
 * 再写 ~/.codex/config.toml 默认模型，最后拉起客户端。
 */
export const codexLaunchStrategy: import("./types").AgentLaunchStrategy = {
  ...AGENT_LAUNCH_DECLARATIONS.codex,

  resolveConfiguration: resolveCodexConfig,

  normalizeResumeSessionId: value => normalizeResumeSessionIdByKind(value, AGENT_LAUNCH_DECLARATIONS.codex.resumeIdKind),

  normalizePreferences: genericPreferencesNormalizer,

  buildCommandArgs: ({input, targetId, resolvedModel}: StrategyCommandArgsInput) => {
    const args = input.resumeSessionId ? ["resume"] : [];
    args.push("-C", input.projectDir);
    // 官方直连形态（2026-10-09 用户确认）：CLI 形态为官方模式时原生启动——不注入
    // 任何网关 provider/模型参数（OpenAI 订阅的 ChatGPT 原生 wire 无法经网关路由），
    // 模型在 Codex 客户端内选择。sandbox 是 Codex 原生顶层键，仍可携带。
    if (input.officialFormLaunch) {
      appendCodexConfig(args, "sandbox_mode", input.manualOverrides.sandboxMode);
      if (input.resumeSessionId) args.push(input.resumeSessionId);
      return {args, environment: {}};
    }
    if (!resolvedModel) throw new Error("MODEL_SELECTION_REQUIRED");
    const gatewayBaseUrl = new URL(validateLocalBaseUrl(input.localBaseUrl)).origin;
    const model = buildGatewayModelId(targetId, resolvedModel);
    args.push(
      "-m",
      model,
      "-c",
      `model_provider=${JSON.stringify(GATEWAY_PROVIDER_ID)}`,
      "-c",
      `model_providers.${GATEWAY_PROVIDER_ID}.name=${
        JSON.stringify(input.subscriptionPassthrough ? "OpenAI" : "DeepAA 网关")
      }`,
      "-c",
      `model_providers.${GATEWAY_PROVIDER_ID}.base_url=${JSON.stringify(`${gatewayBaseUrl}/codex/v1`)}`,
      "-c",
      `model_providers.${GATEWAY_PROVIDER_ID}.wire_api=${JSON.stringify("responses")}`,
    );
    args.push(...(input.subscriptionPassthrough
      ? [
          // 订阅透传：要求 Codex 携带本机 ChatGPT OAuth 登录态，name 保留官方
          // is_openai 特性门，并显式禁用本地网关不支持的 websocket 传输。
          "-c",
          `model_providers.${GATEWAY_PROVIDER_ID}.supports_websockets=${JSON.stringify(false)}`,
          "-c",
          `model_providers.${GATEWAY_PROVIDER_ID}.requires_openai_auth=${JSON.stringify(true)}`,
        ]
      : [
          "-c",
          `model_providers.${GATEWAY_PROVIDER_ID}.experimental_bearer_token=${JSON.stringify(GATEWAY_PLACEHOLDER_TOKEN)}`,
        ]));
    const overrides = input.manualOverrides;
    // 2026-10-02 用户确认（D1）：-c model_context_window / model_auto_compact_token_limit /
    // model_reasoning_effort 对已在模型目录中声明的网关模型不生效（条目级能力位优先），
    // 实测无效故移除；这三类参数改经 launchPreferences → config-sync 写目录条目。
    appendCodexConfig(args, "sandbox_mode", overrides.sandboxMode);
    if (input.resumeSessionId) args.push(input.resumeSessionId);
    return {args, environment: {}};
  },

  execute: async ctx => {
    // 配置健康自愈（2026-10-11）：codex 对 config.toml 是整体反序列化，坏文件
    // 会让三个形态全部回退默认配置，且 config-sync 依赖 parse 无法自修复——
    // 任何形态启动前先确保可解析（健康时一次 parse 开销，无写盘）。
    const configWarning = await ensureCodexConfigParsable(ctx.homeDir);
    // 官方直连形态：受管层已由 CLI 形态切换清空，启动绝不写任何网关键——含
    // writeCodexDefaultModel（否则 config.toml 顶层指向刚被删除的 deepaa_gateway
    // provider，形成既非官方也非网关的撕裂态）；也不做 preSync（清理层幂等，
    // 启动路径无谓触碰磁盘）。桌面客户端与终端 CLI 均原生拉起。
    if (ctx.officialFormLaunch) {
      if (ctx.isClientTerminal) {
        // 官方模式需要真实 ChatGPT 登录：清理网关形态遗留的占位 auth.json
        //（仅内容仍是本占位时删，真实登录绝不触碰），客户端才会引导真登录。
        const authRemoved = await removeCodexPlaceholderAuth(ctx.homeDir);
        ctx.launchers.codexClient(ctx.executablePath, ctx.projectDir);
        return {syncWarnings: [
          ...(configWarning ? [configWarning] : []),
          ...(authRemoved ? [{
            targetId: "",
            code: "CODEX_PLACEHOLDER_AUTH_REMOVED",
            message: "已清理网关模式的占位登录，请在 Codex 客户端内登录 ChatGPT 以使用官方模式",
          } as CliSyncWarning] : []),
        ]};
      }
      await launchCommandInTerminal({adapter: ctx.platform, command: ctx.command});
      return {syncWarnings: configWarning ? [configWarning] : []};
    }
    if (ctx.isClientTerminal) {
      // 客户端模式同样先同步受管配置：弹窗偏好（目录条目级窗口/压缩阈值/推理档）
      // 必须在拉起客户端前落盘，新会话才能读到；同步会把 config.toml 顶层 model
      // 指回当前持久化默认（新默认在启动后才落库），故随后再覆写为本次所选模型。
      const syncWarnings = await preSyncManagedConfig(ctx.configOps, "codex");
      await writeCodexDefaultModel(ctx.homeDir, ctx.target, ctx.resolvedModel!, ctx.manualOverrides);
      // 网关形态占位登录（2026-10-11 用户确认）：客户端登录门只看 auth.json
      // 存在性、不校验内容，预填占位让网关用户免 ChatGPT 登录直进；模型流量
      // 走 deepaa_gateway 的占位 bearer token，与 auth.json 内容无关。
      const authPrefilled = await ensureCodexGatewayPlaceholderAuth(ctx.homeDir);
      ctx.launchers.codexClient(ctx.executablePath, ctx.projectDir);
      return {syncWarnings: [
        ...syncWarnings,
        ...(configWarning ? [configWarning] : []),
        ...(authPrefilled ? [{
          targetId: "",
          code: "CODEX_PLACEHOLDER_AUTH_PREFILLED",
          message: "已预填网关占位登录，Codex 客户端可直接进入，无需 ChatGPT 登录",
        } as CliSyncWarning] : []),
      ]};
    }
    const syncWarnings = await preSyncManagedConfig(ctx.configOps, "codex");
    await launchCommandInTerminal({adapter: ctx.platform, command: ctx.command});
    return {syncWarnings: [...syncWarnings, ...(configWarning ? [configWarning] : [])]};
  },
};

function appendCodexConfig(
  args: string[],
  key: string,
  value: string | number | undefined,
): void {
  if (value === undefined) return;
  args.push("-c", `${key}=${typeof value === "number" ? value : JSON.stringify(value)}`);
}
