import type {AgentId} from "@/types";
import type {AgentLaunchStrategy} from "./types";
import {codexLaunchStrategy} from "./codex";
import {claudeLaunchStrategy} from "./claude";
import {opencodeLaunchStrategy} from "./opencode";
import {dshLaunchStrategy} from "./dsh";
import {zcodeLaunchStrategy} from "./zcode";

/**
 * Agent 启动策略注册表：每个 Agent 的「CLI 面」单一事实来源。
 * `Record<AgentId, …>` 保证新增 Agent 漏注册即编译失败；新增 Agent =
 * 新增一个策略文件 + 这里一行注册，service/platform/launch-plan/UI 零改动。
 */
export const AGENT_LAUNCH_STRATEGIES: Readonly<Record<AgentId, AgentLaunchStrategy>> = {
  codex: codexLaunchStrategy,
  claude: claudeLaunchStrategy,
  opencode: opencodeLaunchStrategy,
  dsh: dshLaunchStrategy,
  zcode: zcodeLaunchStrategy,
};

export function agentLaunchStrategy(agent: AgentId): AgentLaunchStrategy {
  return AGENT_LAUNCH_STRATEGIES[agent];
}

/** 注册表驱动遍历（平台探测/能力组装用），与 KNOWN_AGENT_IDS 同序。 */
export function launchStrategyList(): readonly AgentLaunchStrategy[] {
  return Object.values(AGENT_LAUNCH_STRATEGIES);
}

/** Agent → CLI 可执行名映射（平台 PATH 探测用；派生自策略声明）。 */
export const LAUNCH_EXECUTABLE_BY_AGENT: Readonly<Record<string, string>> = Object.fromEntries(
  launchStrategyList().map(strategy => [strategy.agent, strategy.executable]),
);
