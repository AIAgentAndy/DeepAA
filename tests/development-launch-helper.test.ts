import { EventEmitter } from "events";
import { existsSync } from "fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { prepareTerminalLaunchPlan } from "../src/lib/development-launch/terminal-launch-plan.js";

const RESUME_SESSION_ID = "019fa355-e50d-7731-8a60-c29dbd506666";
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("development launch helper", () => {
  test("私有计划领取后先删除文件，再以原始 argv 启动 Codex", async () => {
    const fixture = await planFixture();
    expect((await stat(fixture.prepared.runtimeDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(fixture.prepared.planPath)).mode & 0o777).toBe(0o600);
    const helper = await import("../bin/development-launch.mjs");
    const launches: Array<{ command: string; args: string[] }> = [];

    await helper.runDevelopmentLaunchFromPlan(fixture.prepared.planPath, {
      tempRoot: fixture.tempRoot,
      spawnProcess(command: string, args: string[]) {
        expect(existsSync(fixture.prepared.planPath)).toBe(false);
        expect(existsSync(fixture.prepared.runtimeDirectory)).toBe(false);
        launches.push({ command, args });
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      },
    });

    expect(launches).toEqual([{
      command: "/usr/local/bin/codex",
      args: ["resume", "-m", "glm-5.2", RESUME_SESSION_ID],
    }]);
  });

  test("拒绝权限过宽的计划且错误不泄漏 Session ID", async () => {
    const fixture = await planFixture();
    await chmod(fixture.prepared.planPath, 0o644);
    const helper = await import("../bin/development-launch.mjs");

    let message = "";
    try {
      await helper.claimDevelopmentLaunchPlan(fixture.prepared.planPath, {
        tempRoot: fixture.tempRoot,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("DEVELOPMENT_LAUNCH_PLAN_NOT_PRIVATE");
    expect(message).not.toContain(RESUME_SESSION_ID);
  });

  test("真实子进程收到完整 Session ID 和有界环境覆盖", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "development-launch-process-test-"));
    tempRoots.push(tempRoot);
    const executableDirectory = join(tempRoot, "bin");
    const executablePath = join(executableDirectory, "codex");
    const outputPath = join(tempRoot, "argv.json");
    await mkdir(executableDirectory);
    await writeFile(
      executablePath,
      [
        "#!/usr/bin/env node",
        "const { writeFileSync } = require('node:fs');",
        "writeFileSync(process.env.DEEPAA_TEST_OUTPUT, JSON.stringify(process.argv.slice(2)));",
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );
    await chmod(executablePath, 0o700);
    const prepared = await prepareTerminalLaunchPlan({
      tempRoot,
      nodeExecutable: "/usr/local/bin/node",
      helperPath: "/app/bin/development-launch.mjs",
      request: {
        terminalId: "terminal.app",
        projectDir: tempRoot,
        executablePath,
        args: ["resume", RESUME_SESSION_ID],
        environment: { DEEPAA_TEST_OUTPUT: outputPath },
      },
    });
    const helper = await import("../bin/development-launch.mjs");

    await expect(helper.runDevelopmentLaunchFromPlan(prepared.planPath, { tempRoot }))
      .resolves.toBe(0);
    await expect(readFile(outputPath, "utf8"))
      .resolves.toBe(JSON.stringify(["resume", RESUME_SESSION_ID]));
    expect(existsSync(prepared.runtimeDirectory)).toBe(false);
  });

  test("拒绝未知字段和超过 64 KiB 的计划", async () => {
    const unknownField = await planFixture();
    const original = JSON.parse(
      await readFile(unknownField.prepared.planPath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      unknownField.prepared.planPath,
      JSON.stringify({ ...original, unexpected: true }),
      { encoding: "utf8", mode: 0o600 },
    );
    const helper = await import("../bin/development-launch.mjs");
    await expect(helper.claimDevelopmentLaunchPlan(
      unknownField.prepared.planPath,
      { tempRoot: unknownField.tempRoot },
    )).rejects.toThrow("DEVELOPMENT_LAUNCH_PLAN_INVALID");

    const oversized = await planFixture();
    await writeFile(
      oversized.prepared.planPath,
      "x".repeat(helper.MAX_LAUNCH_PLAN_BYTES + 1),
      { encoding: "utf8", mode: 0o600 },
    );
    await expect(helper.claimDevelopmentLaunchPlan(
      oversized.prepared.planPath,
      { tempRoot: oversized.tempRoot },
    )).rejects.toThrow("DEVELOPMENT_LAUNCH_PLAN_TOO_LARGE");
  });

  test("拒绝符号链接计划和非 Codex/Claude 可执行文件", async () => {
    const invalidExecutable = await planFixture("/usr/local/bin/bash");
    const helper = await import("../bin/development-launch.mjs");
    await expect(helper.claimDevelopmentLaunchPlan(
      invalidExecutable.prepared.planPath,
      { tempRoot: invalidExecutable.tempRoot },
    )).rejects.toThrow("DEVELOPMENT_LAUNCH_PLAN_INVALID");

    const linked = await planFixture();
    const content = await readFile(linked.prepared.planPath);
    const externalPath = join(linked.tempRoot, "external-plan.json");
    await writeFile(externalPath, content, { mode: 0o600 });
    await rm(linked.prepared.planPath);
    await import("fs/promises").then(({ symlink }) => (
      symlink(externalPath, linked.prepared.planPath)
    ));
    expect((await lstat(linked.prepared.planPath)).isSymbolicLink()).toBe(true);
    await expect(helper.claimDevelopmentLaunchPlan(
      linked.prepared.planPath,
      { tempRoot: linked.tempRoot },
    )).rejects.toThrow("DEVELOPMENT_LAUNCH_PLAN_INVALID");
  });
});

async function planFixture(executablePath = "/usr/local/bin/codex") {
  const tempRoot = await mkdtemp(join(tmpdir(), "development-launch-helper-test-"));
  tempRoots.push(tempRoot);
  const prepared = await prepareTerminalLaunchPlan({
    tempRoot,
    nodeExecutable: "/usr/local/bin/node",
    helperPath: "/app/bin/development-launch.mjs",
    request: {
      terminalId: "terminal.app",
      projectDir: "/Users/andy/Documents/UGit/AIAgentAndy/EffiRoom",
      executablePath,
      args: ["resume", "-m", "glm-5.2", RESUME_SESSION_ID],
      environment: {},
    },
  });
  return { tempRoot, prepared };
}
