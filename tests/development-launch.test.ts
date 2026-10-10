import {describe, expect, test} from "vitest";
import {buildDevelopmentLaunchCommand} from "../src/lib/development-launch/launch-plan.js";
import type {WireApi} from "../src/types.js";

/**
 * OpenCode 开发启动命令构造测试。
 *
 * 守护两个关键契约（均为实测发现的问题）：
 * - TUI 形态：opencode 主命令（`opencode [project]`）不支持 --dir，目录必须用
 *   位置参数传递，否则 yargs 判为未知选项打印 help 并不启动 TUI。
 * - headless 形态：`opencode run` 子命令确实提供 --dir，命令形状保持合法。
 */
const baseInput = {
  cli: "opencode" as const,
  platform: "darwin" as const,
  targetId: "open.bigmodel.cn-api-paas-v4",
  targetName: "bigmodel",
  localBaseUrl: "http://127.0.0.1:8899",
  projectDir: "/Users/andy/projects/sample",
  executablePath: "/usr/bin/opencode",
  terminal: "iterm2",
  credentialHelperPath: "/usr/bin/security",
  nodeExecutable: "/usr/local/bin/node",
  resolvedModel: "glm-5.2",
  manualOverrides: {},
  opencodeWireApi: "chat_completions" as WireApi,
};

// buildGatewayModelId 以真实模型 ID 在前、路由 ID 为后缀；wireApi=chat_completions → provider 后缀 chat。
const expectedModel =
  "opencode-deepaa-gateway-chat/glm-5.2_open.bigmodel.cn-api-paas-v4";

describe("buildDevelopmentLaunchCommand (opencode)", () => {
  test("TUI 形态用位置参数传项目目录，不带 --dir", () => {
    const command = buildDevelopmentLaunchCommand({
      ...baseInput,
      launchMode: "tui",
    });
    // 项目目录必须是第一个位置参数；主命令没有 --dir 选项。
    expect(command.args[0]).toBe(baseInput.projectDir);
    expect(command.args).not.toContain("--dir");
    // opencode v2 TUI 已移除 -m 旗标（实测 v2.0.26 Unrecognized flag: -m 拒参
    // 退出）：模型走受管配置默认（modelFromManagedConfig：启动前预落库 +
    // preSync 写入 model 字段），v1 同样读取该配置字段。
    expect(command.args).toEqual([baseInput.projectDir]);
  });

  test("headless 形态保留 run 子命令的合法 --dir", () => {
    const command = buildDevelopmentLaunchCommand({
      ...baseInput,
      launchMode: "headless",
      task: "修复登录 bug",
    });
    expect(command.args).toEqual([
      "run",
      "修复登录 bug",
      "--dir",
      baseInput.projectDir,
      "-m",
      expectedModel,
    ]);
  });
});