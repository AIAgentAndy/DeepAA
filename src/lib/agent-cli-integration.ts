import type {AgentId} from "@/types";
import {AGENT_LAUNCH_DECLARATIONS} from "@/lib/development-launch/strategies/contracts";

/**
 * Web 侧 CLI 集成注册表（派生视图）：唯一事实来源已收敛到
 * development-launch/strategies（2026-09-14 策略化一期）。本模块保留旧导出
 * 形态供既有消费方（平台适配器、UI 弹窗）平滑迁移；新增 Agent 只在
 * strategies/<agent>.ts 落地，这里自动出现。
 */
export interface AgentCliIntegration {
  agent: AgentId;
  /** 可执行文件名称。 */
  executable: string;
  /**
   * 探测顺序：PATH 优先，随后是这些相对 home 的白名单安装路径；
   * 禁止扫描 npx cache，dsh 首期只认 PATH。
   */
  executableCandidates: readonly string[];
  /** 配置同步适配器键名，由适配器注册表保证存在。 */
  configAdapter: AgentId;
  /** 配置解析器键名（开发启动预检），由 config-resolver 保证存在。 */
  configResolver: AgentId;
  /** 支持的启动形态。 */
  launchModes: readonly ("tui" | "headless" | "web" | "app")[];
  /** 是否支持会话恢复。 */
  resume: boolean;
  /** 环境注入：全部为占位 token，绝不包含真实密钥。 */
  launchEnv: Readonly<Record<string, string>>;
}

export const AGENT_CLI_INTEGRATIONS: Readonly<Record<AgentId, AgentCliIntegration>> =
  Object.fromEntries(
    Object.values(AGENT_LAUNCH_DECLARATIONS).map(strategy => [
      strategy.agent,
      {
        agent: strategy.agent,
        executable: strategy.executable,
        executableCandidates: strategy.executableCandidates,
        configAdapter: strategy.configAdapter,
        configResolver: strategy.agent,
        launchModes: strategy.launchModes,
        resume: strategy.supportsResume,
        launchEnv: strategy.launchEnv,
      },
    ]),
  ) as Readonly<Record<AgentId, AgentCliIntegration>>;

export function agentCliIntegration(agent: AgentId): AgentCliIntegration {
  return AGENT_CLI_INTEGRATIONS[agent];
}
