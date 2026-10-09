import type { DevelopmentLaunchCommand } from "./launch-plan";
import type { DevelopmentPlatformAdapter } from "./platform";

/** 终端创建成功即返回，不持有或监听后续 CLI 进程。 */
export async function launchCommandInTerminal(input: {
  adapter: DevelopmentPlatformAdapter;
  command: DevelopmentLaunchCommand;
}): Promise<void> {
  await input.adapter.openTerminal({
    terminalId: input.command.terminal,
    projectDir: input.command.projectDir,
    executablePath: input.command.executablePath,
    args: input.command.args,
    environment: input.command.environment,
  });
}
