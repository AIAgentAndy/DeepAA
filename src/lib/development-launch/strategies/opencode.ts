import { buildGatewayModelId } from "@/proxy/gateway-prefix";
import {
  GATEWAY_PLACEHOLDER_TOKEN,
  OPENCODE_PROVIDER_PREFIX,
} from "@/lib/config-sync/core/placeholder-auth";
import type {ProxyConfig, ProxyTarget, WireApi} from "@/types";
import {modelWireApisForTarget} from "@/lib/config-sync/adapters/common";
import { launchCommandInTerminal } from "../terminal-launcher";
import {
  genericPreferencesNormalizer,
    preSyncManagedConfig,
  resolveOpenCodeConfig,
  validateText,
} from "./shared";
import type { StrategyCommandArgsInput } from "./types";
import {AGENT_LAUNCH_DECLARATIONS, normalizeResumeSessionIdByKind} from "./contracts";

/**
 * OpenCode 策略：终端 CLI 双形态（TUI / headless 一次性任务）；wire API 按
 * 显式偏好 > responses > chat_completions > messages 解析（决定 provider 条目）。
 */
export const opencodeLaunchStrategy: import("./types").AgentLaunchStrategy = {
  ...AGENT_LAUNCH_DECLARATIONS.opencode,

  resolveConfiguration: resolveOpenCodeConfig,

  resolveLaunchWireApi: (
    config: ProxyConfig,
    target: ProxyTarget,
    modelId: string,
  ): WireApi | undefined => {
    const wireApi = resolveOpenCodeLaunchWireApi(config, target, modelId);
    if (!wireApi) throw new Error("MODEL_WIRE_API_UNSUPPORTED");
    return wireApi;
  },

  normalizeResumeSessionId: value => normalizeResumeSessionIdByKind(value, AGENT_LAUNCH_DECLARATIONS.opencode.resumeIdKind),

  normalizePreferences: genericPreferencesNormalizer,

  buildCommandArgs: ({input, targetId, resolvedModel}: StrategyCommandArgsInput) => {
    const wireApi = input.opencodeWireApi;
    if (!wireApi) throw new Error("OPENCODE_WIRE_API_REQUIRED");
    if (!resolvedModel) throw new Error("MODEL_SELECTION_REQUIRED");
    const model = `${opencodeProviderId(wireApi)}/${buildGatewayModelId(targetId, resolvedModel)}`;
    if (input.launchMode === "headless") {
      if (typeof input.task !== "string" || !input.task.trim()) throw new Error("TASK_REQUIRED");
      const task = validateText(input.task, "TASK_REQUIRED", 4096);
      // headless 走 run 子命令：v1/v2 均支持 --model/-m（实测 v2.0.26）。
      return {args: ["run", task, "--dir", input.projectDir, "-m", model], environment: {}};
    }
    // TUI 形态：opencode v2 TUI 已移除 -m 旗标（实测 v2.0.26 Unrecognized
    // flag: -m 拒参退出），模型经 modelFromManagedConfig 声明走受管配置默认
    // （service 启动前预落库 + preSync 写入 model 字段），v1 同样读取该配置。
    // 主命令只接受位置参数作为项目目录，不支持 --dir；
    // 传 --dir 会被 yargs 判为未知选项并打印 help 而非启动 TUI。
    const args = [input.projectDir];
    if (input.resumeSessionId) {
      args.push("--session", input.resumeSessionId);
    }
    return {args, environment: {}};
  },

  execute: async ctx => {
    const syncWarnings = await preSyncManagedConfig(ctx.configOps, "opencode");
    await launchCommandInTerminal({adapter: ctx.platform, command: ctx.command});
    return {syncWarnings};
  },
};

/** OpenCode 启动 provider：显式偏好 > responses > chat_completions > messages。 */
function resolveOpenCodeLaunchWireApi(
  config: ProxyConfig,
  target: ProxyTarget,
  modelId: string,
): WireApi | undefined {
  const allowed = modelWireApisForTarget(target, modelId, "opencode");
  const explicit = config.agentConnections.opencode?.preferredWireApi;
  if (explicit && allowed.includes(explicit)) return explicit;
  return (["responses", "chat_completions", "messages"] as const)
    .find(wireApi => allowed.includes(wireApi));
}

function opencodeProviderId(wireApi: WireApi): string {
  const suffix = wireApi === "responses" ? "responses"
    : wireApi === "messages" ? "anthropic"
      : "chat";
  return `${OPENCODE_PROVIDER_PREFIX}-${suffix}`;
}
