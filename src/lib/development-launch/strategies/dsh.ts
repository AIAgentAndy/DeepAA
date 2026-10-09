import type {ProxyTarget, WireApi} from "@/types";
import {modelWireApisForTarget} from "@/lib/config-sync/adapters/common";
import { launchCommandInTerminal } from "../terminal-launcher";
import {
  dshPreferencesNormalizer,
  preSyncManagedConfig,
  resolveDshConfig,
  } from "./shared";
import type { StrategyExecutable, StrategyExecutableContext } from "./types";
import {AGENT_LAUNCH_DECLARATIONS, normalizeResumeSessionIdByKind} from "./contracts";

/** dsh Web UI 常驻服务端口：已在监听时不再重复启动（否则上游 EADDRINUSE 崩溃）。 */
const DSH_WEB_PORT = 3080;

/**
 * dsh 策略：双形态常驻服务——web = 终端 `dsh web`（3080，已在监听不重复启动）；
 * app = DeepSeek Harness 桌面客户端（拉起/聚焦，不走终端）。启动通道
 * 只读探测「PATH dsh → npx 缓存 → npx 免装」，不执行任何安装动作。
 */
export const dshLaunchStrategy: import("./types").AgentLaunchStrategy = {
  ...AGENT_LAUNCH_DECLARATIONS.dsh,

  resolveExecutable: async (ctx: StrategyExecutableContext): Promise<StrategyExecutable> => {
    const dshLaunch = await ctx.platform.resolveDshLaunch?.() ?? null;
    if (!dshLaunch) throw new Error("CLI_NOT_FOUND");
    return {
      executablePath: dshLaunch.executablePath,
      channel: dshLaunch.channel,
      alreadyRunning: await ctx.portProbe(DSH_WEB_PORT),
    };
  },

  resolveLaunchWireApi: (_config, target: ProxyTarget, modelId: string): WireApi | undefined => {
    // dsh 三协议路由（2026-10-06 官方核实 pi-ai KnownApi）；启动解析按 defaultBinding
    // 偏好：chat_completions > responses > messages。
    const allowed = modelWireApisForTarget(target, modelId, "dsh");
    const resolved = (["chat_completions", "responses", "messages"] as const)
      .find(wireApi => allowed.includes(wireApi));
    if (!resolved) throw new Error("MODEL_WIRE_API_UNSUPPORTED");
    return resolved;
  },

  resolveConfiguration: resolveDshConfig,

  normalizeResumeSessionId: value => normalizeResumeSessionIdByKind(value, AGENT_LAUNCH_DECLARATIONS.dsh.resumeIdKind),

  normalizePreferences: dshPreferencesNormalizer,

  buildCommandArgs: ({input: commandInput}) => {
    // app 形态不产生终端命令：启动动作由 execute 直接拉起桌面客户端，此处仅满足契约。
    if (commandInput.launchMode === "app") {
      return {args: [], environment: {}};
    }
    // dsh web 形态；npx 通道不带 --no-install：首次自动下载到
    // npx 缓存，之后直接走缓存。
    const channel = commandInput.dshChannel ?? "path";
    return {
      args: channel === "path" ? ["web"] : ["@deepseek-ai/dsh", "web"],
      environment: {},
    };
  },

  execute: async ctx => {
    const syncWarnings = await preSyncManagedConfig(ctx.configOps, "dsh");
    if (ctx.launchMode === "app") {
      // 桌面客户端形态：探测安装位置后拉起/聚焦（open -a 对已运行 App 是激活
      // 而非重启；Windows 由 Electron 单实例锁转发）。不走终端、不占 3080。
      const appPath = await ctx.platform.detectDshDesktopApp?.();
      if (!appPath) throw new Error("DSH_DESKTOP_APP_NOT_FOUND");
      ctx.launchers.dshDesktopApp(appPath);
      return {syncWarnings};
    }
    // Web 服务已在运行时跳过终端启动（前端依据 dshAlreadyRunning 打开新标签页）。
    if (!ctx.alreadyRunning) {
      await launchCommandInTerminal({adapter: ctx.platform, command: ctx.command});
    }
    return {syncWarnings};
  },
};

export {DSH_WEB_PORT};
