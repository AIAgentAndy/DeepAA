import type {DevelopmentCli} from "./types";
import {agentLaunchDeclarations, normalizeResumeSessionIdByKind} from "./strategies/contracts";

/**
 * 原生 Session ID 只允许规范值域；空值表示显式新建会话。
 * 该值只参与本次启动请求，不承担 DeepAA 内部 Session 标识职责。
 * 归一化逻辑由各 Agent 启动策略声明（codex 接受 UUID 或会话名称、claude 只接受
 * UUID、opencode 接受 ses_ 前缀、dsh/zcode 不开放恢复）；本函数保留旧签名供
 * 既有调用方使用。
 */
export function normalizeResumeSessionId(
  value: unknown,
  cli: DevelopmentCli = "codex",
): string | undefined {
  return normalizeResumeSessionIdByKind(value, agentLaunchDeclarations(cli).resumeIdKind);
}
