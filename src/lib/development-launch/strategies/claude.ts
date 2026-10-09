import { buildGatewayModelId } from "@/proxy/gateway-prefix";
import { launchCommandInTerminal } from "../terminal-launcher";
import {
  genericPreferencesNormalizer,
  preSyncManagedConfig,
  resolveClaudeConfig,
    validateText,
} from "./shared";
import type { StrategyCommandArgsInput } from "./types";
import {AGENT_LAUNCH_DECLARATIONS, normalizeResumeSessionIdByKind} from "./contracts";

/**
 * Claude Code 策略：终端 CLI（Messages）；唯一需要私有临时 settings 的 Agent
 * （写不含密钥的 claude-settings.json 并以 --settings 注入）。
 */
export const claudeLaunchStrategy: import("./types").AgentLaunchStrategy = {
  ...AGENT_LAUNCH_DECLARATIONS.claude,

  resolveConfiguration: resolveClaudeConfig,

  normalizeResumeSessionId: value => normalizeResumeSessionIdByKind(value, AGENT_LAUNCH_DECLARATIONS.claude.resumeIdKind),

  normalizePreferences: genericPreferencesNormalizer,

  buildCommandArgs: ({input, targetId, resolvedModel}: StrategyCommandArgsInput) => {
    const {manualOverrides, resumeSessionId} = input;
    if (!input.settingsPath) throw new Error("CLAUDE_SETTINGS_REQUIRED");
    if (!resolvedModel) throw new Error("MODEL_SELECTION_REQUIRED");
    const environment: Record<string, string> = {};
    const args = resumeSessionId ? ["--resume", resumeSessionId] : [];
    args.push(
      "--setting-sources",
      "user,project,local",
      "--settings",
      validateText(input.settingsPath, "CLAUDE_SETTINGS_REQUIRED", 4096),
    );
    args.push("--model", buildGatewayModelId(targetId, resolvedModel));
    if (manualOverrides.effortLevel) args.push("--effort", manualOverrides.effortLevel);
    if (manualOverrides.permissionMode) {
      args.push("--permission-mode", manualOverrides.permissionMode);
    }
    if (manualOverrides.claudeAutoCompactTokens !== undefined) {
      args.push("--autocompact", String(manualOverrides.claudeAutoCompactTokens));
    }
    if (manualOverrides.claudeMaxContextTokens !== undefined) {
      environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(
        manualOverrides.claudeMaxContextTokens,
      );
    }
    return {args, environment};
  },

  execute: async ctx => {
    const syncWarnings = await preSyncManagedConfig(ctx.configOps, "claude");
    await launchCommandInTerminal({adapter: ctx.platform, command: ctx.command});
    return {syncWarnings};
  },
};
