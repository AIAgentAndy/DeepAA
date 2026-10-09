import { randomUUID } from "crypto";
import { chmod, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import type { TerminalLaunchRequest } from "./platform";

export const TERMINAL_LAUNCH_PLAN_FILE = "terminal-launch.json";

export interface PreparedTerminalLaunchPlan {
  helperRequest: TerminalLaunchRequest;
  planPath: string;
  runtimeDirectory: string;
}

/**
 * Terminal.app 超长命令只把结构化参数短暂写入私有运行目录，真实密钥不进入该计划。
 * 固定启动器领取后会先删除计划，再启动最终 CLI。
 */
export async function prepareTerminalLaunchPlan(input: {
  tempRoot: string;
  nodeExecutable: string;
  helperPath: string;
  request: TerminalLaunchRequest;
}): Promise<PreparedTerminalLaunchPlan> {
  await mkdir(input.tempRoot, { recursive: true, mode: 0o700 });
  const runtimeDirectory = join(
    input.tempRoot,
    `launch_terminal_${randomUUID().replaceAll("-", "")}`,
  );
  await mkdir(runtimeDirectory, { mode: 0o700 });
  await chmod(runtimeDirectory, 0o700);
  const planPath = join(runtimeDirectory, TERMINAL_LAUNCH_PLAN_FILE);
  try {
    await writeFile(planPath, `${JSON.stringify({
      version: 1,
      projectDir: input.request.projectDir,
      executablePath: input.request.executablePath,
      args: input.request.args,
      environment: input.request.environment,
    })}\n`, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(planPath, 0o600);
    return {
      planPath,
      runtimeDirectory,
      helperRequest: {
        terminalId: "terminal.app",
        projectDir: "/",
        executablePath: input.nodeExecutable,
        args: [input.helperPath, planPath],
        environment: {},
      },
    };
  } catch (error) {
    await cleanupTerminalLaunchPlan(runtimeDirectory);
    throw error;
  }
}

export async function cleanupTerminalLaunchPlan(runtimeDirectory: string): Promise<void> {
  await rm(runtimeDirectory, { recursive: true, force: true });
}
