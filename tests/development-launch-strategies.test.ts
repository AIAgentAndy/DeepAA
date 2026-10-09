import { describe, expect, test } from "vitest";
import {
  AGENT_LAUNCH_STRATEGIES,
  agentLaunchStrategy,
  LAUNCH_EXECUTABLE_BY_AGENT,
  launchStrategyList,
} from "../src/lib/development-launch/strategies";
import {AGENT_REGISTRY} from "../src/lib/agent-registry";
import {AGENT_CLI_INTEGRATIONS} from "../src/lib/agent-cli-integration";
import {buildDevelopmentLaunchCommand} from "../src/lib/development-launch/launch-plan";
import type {AgentLaunchStrategy} from "../src/lib/development-launch/strategies/types";

/**
 * Agent 启动策略注册表契约测试（docs/上线前架构升级改造.md §10.2）。
 *
 * 「假想 Agent 接入演练」的可执行形态：新增 Agent 的全部接入物就是一个通过本
 * 契约校验的策略对象（+ 注册一行）。这里对注册表做结构不变量与行为抽查，
 * 证明通用链路只消费策略声明；配合扩展面守卫（通用链路文件 0 分派）共同
 * 锁定「新增 Agent 不改公共代码」的验收标准。
 */

const UUID = "01234567-89ab-cdef-0123-456789abcdef";

function commandInputFor(agent: string) {
  return {
    cli: agent as never,
    platform: "darwin" as const,
    targetId: "target-x",
    targetName: "Target X",
    localBaseUrl: "http://127.0.0.1:3211",
    projectDir: "/tmp/project",
    executablePath: "/usr/local/bin/x",
    terminal: "terminal",
    credentialHelperPath: "/bin/credential-helper.mjs",
    nodeExecutable: process.execPath,
    resolvedModel: "model-x",
    manualOverrides: {},
  };
}

describe("Agent 启动策略注册表契约", () => {
  test("注册表与 Agent 注册表一一对应（漏注册即失败）", () => {
    expect([...Object.keys(AGENT_LAUNCH_STRATEGIES)].sort()).toEqual(
      [...AGENT_REGISTRY.map(item => item.id)].sort(),
    );
    expect(launchStrategyList()).toHaveLength(AGENT_REGISTRY.length);
  });

  test("每个策略满足结构不变量（新增 Agent 的接入验收清单）", () => {
    for (const strategy of launchStrategyList()) {
      expect(strategy.agent, "agent id").toBeTruthy();
      expect(strategy.executable, `${strategy.agent} executable`).toMatch(/^[a-z0-9][\w.-]*$/);
      expect(strategy.launchModes.length, `${strategy.agent} launchModes`).toBeGreaterThan(0);
      expect(["terminal-cli", "desktop-app", "web-service"]).toContain(strategy.form);
      expect(["required", "optional"]).toContain(strategy.requiresProjectDir);
      expect(["standard", "none"]).toContain(strategy.terminalPolicy);
      // 不变量：非终端形态没有标准终端；固定形态必须声明；恢复关闭时非空 ID 拒绝。
      if (strategy.form !== "terminal-cli") {
        expect(strategy.requiresProjectDir).toBe("optional");
      }
      if (strategy.terminalPolicy === "none") {
        expect(strategy.fixedTerminalId, `${strategy.agent} fixedTerminalId`).toBeTruthy();
      }
      if (strategy.fixedLaunchMode) {
        expect(strategy.launchModes).toContain(strategy.fixedLaunchMode);
      }
      // 行为钩子全部可调用（新增 Agent 策略漏实现会在消费点直接炸）。
      expect(typeof strategy.resolveConfiguration).toBe("function");
      expect(typeof strategy.normalizeResumeSessionId).toBe("function");
      expect(typeof strategy.normalizePreferences).toBe("function");
      expect(typeof strategy.buildCommandArgs).toBe("function");
      expect(typeof strategy.execute).toBe("function");
      // 会话恢复归一化契约：空值放行、垃圾值拒绝、不支持时非空拒绝。
      expect(strategy.normalizeResumeSessionId(undefined)).toBeUndefined();
      expect(strategy.normalizeResumeSessionId("  ")).toBeUndefined();
      if (!strategy.supportsResume) {
        expect(() => strategy.normalizeResumeSessionId(UUID)).toThrow("RESUME_NOT_SUPPORTED");
      } else {
        // 以「-」开头的值既不是 UUID、也不满足任何会话名称形态，应被拒绝。
        expect(() => strategy.normalizeResumeSessionId("-not-a-session")).toThrow("INVALID_RESUME_SESSION_ID");
      }
      // 偏好归一化契约：undefined 放行、全空对象归 undefined。
      expect(strategy.normalizePreferences(undefined)).toBeUndefined();
    }
  });

  test("关键 Agent 差异声明保持既有语义", () => {
    expect(agentLaunchStrategy("codex").clientTerminalId).toBe("codex-client");
    expect(agentLaunchStrategy("claude").requiresTempSettings).toBe(true);
    expect(launchStrategyList().filter(item => item.requiresTempSettings)).toHaveLength(1);
    // dsh 双形态（2026-10-05）：web = 终端常驻 dsh web；app = DeepSeek Harness
    // 桌面客户端。无 fixedLaunchMode（弹窗选择，客户端已安装默认 app）。
    expect(agentLaunchStrategy("dsh").launchModes).toEqual(["web", "app"]);
    expect(agentLaunchStrategy("dsh").fixedLaunchMode).toBeUndefined();
    expect(agentLaunchStrategy("dsh").alreadyRunningResponseKey).toBe("dshAlreadyRunning");
    expect(agentLaunchStrategy("zcode").form).toBe("desktop-app");
    expect(agentLaunchStrategy("zcode").alreadyRunningResponseKey).toBe("zcodeAlreadyRunning");
    expect(agentLaunchStrategy("opencode").consumesLaunchPreferences).toBe(true);
    expect(agentLaunchStrategy("opencode").consumesHeadlessTask).toBe(true);
  });

  test("派生视图一致：可执行名映射与 CLI 集成注册表", () => {
    for (const strategy of launchStrategyList()) {
      expect(LAUNCH_EXECUTABLE_BY_AGENT[strategy.agent]).toBe(strategy.executable);
      const integration = AGENT_CLI_INTEGRATIONS[strategy.agent];
      expect(integration.executable).toBe(strategy.executable);
      expect(integration.resume).toBe(strategy.supportsResume);
      expect(integration.launchEnv).toEqual(strategy.launchEnv);
    }
  });

  test("codex 订阅透传与按量 args 构造等价（关键差异抽查）", () => {
    const codex = agentLaunchStrategy("codex");
    const payg = codex.buildCommandArgs({
      input: {...commandInputFor("codex"), manualOverrides: {}} as never,
      targetId: "target-x",
      resolvedModel: "model-x",
    });
    expect(payg.args.join(" ")).toContain("experimental_bearer_token");
    expect(payg.args.join(" ")).not.toContain("requires_openai_auth");
    const subscription = codex.buildCommandArgs({
      input: {
        ...commandInputFor("codex"),
        subscriptionPassthrough: true,
        manualOverrides: {},
      } as never,
      targetId: "target-x",
      resolvedModel: "model-x",
    });
    expect(subscription.args.join(" ")).toContain("requires_openai_auth");
    expect(subscription.args.join(" ")).toContain("supports_websockets");
    expect(subscription.args.join(" ")).not.toContain("experimental_bearer_token");
  });

  test("dsh 通道 args 与偏好值域", () => {
    const dsh = agentLaunchStrategy("dsh");
    expect(dsh.buildCommandArgs({
      input: {...commandInputFor("dsh"), dshChannel: "path"} as never,
      targetId: "t",
      resolvedModel: "m",
    }).args).toEqual(["web"]);
    expect(dsh.buildCommandArgs({
      input: {...commandInputFor("dsh"), dshChannel: "npx"} as never,
      targetId: "t",
      resolvedModel: "m",
    }).args).toEqual(["@deepseek-ai/dsh", "web"]);
    expect(dsh.normalizePreferences({reasoningEffort: "max"})).toEqual({reasoningEffort: "max"});
    expect(() => dsh.normalizePreferences({reasoningEffort: "ultra"})).toThrow("INVALID_LAUNCH_PREFERENCE");
    expect(dsh.normalizePreferences({permissionMode: "read-only"})).toEqual({permissionMode: "read-only"});
    expect(() => dsh.normalizePreferences({permissionMode: "root"})).toThrow("INVALID_LAUNCH_PREFERENCE");
    // 非 dsh 策略不消费权限预设。
    expect(() => agentLaunchStrategy("claude").normalizePreferences({permissionMode: "read-only"}))
      .toThrow("INVALID_LAUNCH_PREFERENCE");
  });

  test("claude 是唯一临时 settings 策略：命令组装含 --settings", () => {
    const command = buildDevelopmentLaunchCommand({
      ...commandInputFor("claude"),
      cli: "claude",
      settingsPath: "/tmp/claude-settings.json",
      manualOverrides: {},
    } as never);
    expect(command.args).toContain("--settings");
    expect(command.environment).toEqual({});
  });

  test("resume 归一化按策略值域分发", () => {
    expect(agentLaunchStrategy("codex").normalizeResumeSessionId(UUID)).toBe(UUID);
    expect(agentLaunchStrategy("codex").normalizeResumeSessionId("我的会话标题")).toBe("我的会话标题");
    expect(agentLaunchStrategy("claude").normalizeResumeSessionId(UUID.toUpperCase())).toBe(UUID.toLowerCase());
    expect(() => agentLaunchStrategy("claude").normalizeResumeSessionId("我的会话标题"))
      .toThrow("INVALID_RESUME_SESSION_ID");
    expect(agentLaunchStrategy("opencode").normalizeResumeSessionId("ses_abcdefgh1234")).toBe("ses_abcdefgh1234");
  });

  test("通用链路只经策略分发（扩展面守卫快照）", () => {
    // service / platform / launch-plan / resume-session / config-resolver 分派归零
    // 由 tests/agent-extension-guard.test.ts 的 ratchet 基线强制；此处仅断言
    // 策略注册表是唯一事实来源的派生一致性，避免双源漂移。
    const strategies: readonly AgentLaunchStrategy[] = launchStrategyList();
    expect(new Set(strategies.map(item => item.agent)).size).toBe(strategies.length);
  });
});

  test("dsh 双形态 execute：app 拉起桌面客户端不走终端，web 保持终端常驻语义", async () => {
    const dsh = agentLaunchStrategy("dsh");
    // app 形态不产生终端命令（execute 直接拉起 App，仅满足契约）。
    expect(dsh.buildCommandArgs({
      input: {...commandInputFor("dsh"), dshChannel: "npx", launchMode: "app"} as never,
      targetId: "t",
      resolvedModel: "m",
    }).args).toEqual([]);
    // web 形态（含 launchMode 显式 web）命令不变。
    expect(dsh.buildCommandArgs({
      input: {...commandInputFor("dsh"), dshChannel: "npx", launchMode: "web"} as never,
      targetId: "t",
      resolvedModel: "m",
    }).args).toEqual(["@deepseek-ai/dsh", "web"]);

    const configOps = {reload: async () => {}, getConfig: () => ({}), syncer: async () => {}};
    const launchCalls: string[] = [];
    const terminalCalls: string[] = [];
    const baseCtx = {
      homeDir: "/Users/test",
      target: {id: "t", name: "T"} as never,
      resolvedModel: "m",
      manualOverrides: {} as never,
      executablePath: "/usr/local/bin/dsh",
      projectDir: undefined,
      requestedTerminal: undefined,
      isClientTerminal: false,
      alreadyRunning: false,
      command: {launchId: "l", args: ["web"]} as never,
      configOps,
      launchers: {
        codexClient: () => {},
        zcodeApp: () => {},
        dshDesktopApp: (appPath: string) => launchCalls.push(appPath),
      },
      platform: {
        platform: "darwin" as const,
        // dsh app 分支唯一的平台依赖：安装位置探测。
        detectDshDesktopApp: async () => "/Applications/DeepSeek Harness.app",
        openTerminal: async () => terminalCalls.push("terminal"),
      } as never,
    };

    // app 形态：探测 → launcher 拉起，不触发终端。
    await dsh.execute({...baseCtx, launchMode: "app"} as never);
    expect(launchCalls).toEqual(["/Applications/DeepSeek Harness.app"]);
    expect(terminalCalls).toEqual([]);
    // app 形态但客户端未安装：稳定错误码阻断（不回退终端）。
    await expect(dsh.execute({
      ...baseCtx,
      launchMode: "app",
      platform: {...baseCtx.platform, detectDshDesktopApp: async () => null},
    } as never)).rejects.toThrow("DSH_DESKTOP_APP_NOT_FOUND");
    // web 形态：走终端启动（launchCommandInTerminal 注入的 platform.openTerminal）。
    await dsh.execute({...baseCtx, launchMode: "web"} as never);
    expect(terminalCalls).toEqual(["terminal"]);
    expect(launchCalls).toEqual(["/Applications/DeepSeek Harness.app"]);
  });
