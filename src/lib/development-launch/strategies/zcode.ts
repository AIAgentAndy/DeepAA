import type {ProxyTarget, WireApi} from "@/types";
import {modelWireApisForTarget} from "@/lib/config-sync/adapters/common";
import {
  genericPreferencesNormalizer,
  preSyncManagedConfig,
  resolveZcodeConfig,
  } from "./shared";
import type { StrategyExecutable, StrategyExecutableContext } from "./types";
import {AGENT_LAUNCH_DECLARATIONS, normalizeResumeSessionIdByKind} from "./contracts";

/**
 * ZCode 策略：Electron 桌面 App 形态（zcode-cli 由 App 内嵌拉起，不在 PATH）。
 * 可执行 = 平台探测的安装位置；已运行时不重复拉起（尽力切换焦点）；
 * 选填工作区目录经 zcode://workspace/open 深链打开。
 */
export const zcodeLaunchStrategy: import("./types").AgentLaunchStrategy = {
  ...AGENT_LAUNCH_DECLARATIONS.zcode,

  resolveExecutable: async (ctx: StrategyExecutableContext): Promise<StrategyExecutable> => {
    const capabilities = await ctx.capabilities();
    const appPath = capabilities.agents.zcode?.appPath ?? null;
    if (!appPath) throw new Error("CLI_NOT_FOUND");
    return {
      executablePath: appPath,
      alreadyRunning: Boolean(appPath && await ctx.platform.isZcodeAppRunning?.()),
    };
  },

  resolveLaunchWireApi: (_config, target: ProxyTarget, modelId: string): WireApi | undefined => {
    // ZCode 官方支持三协议（2026-10-06 App 包内 schema 实证），适配器按协议分路由
    // 注入；启动解析按 defaultBinding 偏好：messages > responses > chat_completions。
    const allowed = modelWireApisForTarget(target, modelId, "zcode");
    const resolved = (["messages", "responses", "chat_completions"] as const)
      .find(wireApi => allowed.includes(wireApi));
    if (!resolved) throw new Error("MODEL_WIRE_API_UNSUPPORTED");
    return resolved;
  },

  resolveConfiguration: resolveZcodeConfig,

  normalizeResumeSessionId: value => normalizeResumeSessionIdByKind(value, AGENT_LAUNCH_DECLARATIONS.zcode.resumeIdKind),

  normalizePreferences: genericPreferencesNormalizer,

  buildCommandArgs: () => ({
    // App 形态不产生终端命令：启动动作由 execute 直接拉起 App，此处仅满足契约。
    args: [],
    environment: {},
  }),

  execute: async ctx => {
    // 先刷新受管 provider 配置再拉起/激活 App；同步前必须重读磁盘配置：
    // 单例 store 的内存视图可能早于最近一次保存，陈旧视图会让 fail-safe
    // 误判甚至触发清理层。
    const syncWarnings = await preSyncManagedConfig(ctx.configOps, "zcode");
    if (ctx.alreadyRunning) {
      // 已运行：选了工作区则直接发深链（App 会聚焦并打开该工作区）；
      // 未选工作区仅尽力切换焦点，不重复拉起。
      if (ctx.projectDir) {
        ctx.launchers.zcodeApp(ctx.executablePath, ctx.projectDir);
      } else {
        await ctx.platform.activateZcodeApp?.(ctx.executablePath).catch(() => false);
      }
      return {syncWarnings};
    }
    if (!ctx.projectDir) {
      ctx.launchers.zcodeApp(ctx.executablePath, undefined);
      return {syncWarnings};
    }
    // 冷启动 + 工作区：先拉起 App，等待运行就绪后再发深链，消除冷启动时
    // App 尚未注册 URL 处理导致的深链丢失；平台无运行探测或等待超时（5s）
    // 时仍发一次深链兜底（macOS 深链本身支持冷启动拉起）。
    ctx.launchers.zcodeApp(ctx.executablePath, undefined);
    const probe = ctx.platform.isZcodeAppRunning?.bind(ctx.platform);
    if (probe) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !(await probe().catch(() => false))) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    ctx.launchers.zcodeApp(ctx.executablePath, ctx.projectDir);
    return {syncWarnings};
  },
};
