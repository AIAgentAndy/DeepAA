/**
 * Windows 控制台窗口回归测试（2026-10-09 Windows 真机实测事故）：
 * 守护化（无控制台）父进程派生的运行时孙进程必须 windowsHide:true——
 * 否则 Windows 会为 next-server 与代理各分配一个可见控制台窗口，
 * 用户关窗即杀进程（等价于服务停止）。daemonize 层已由 deepaa-service.test.ts
 * 锁定，本文件锁定 runDeepaa 运行时子进程这一层。
 */

import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {EventEmitter} from "node:events";
import {afterAll, describe, expect, test} from "vitest";
import {runDeepaa} from "../bin/deepaa.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "deepaa-runtime-spawn-"));
afterAll(async () => {
  await rm(sandbox, {recursive: true, force: true});
});

describe("runDeepaa 运行时子进程 spawn 选项", () => {
  test("web 与 proxy 子进程均要求 windowsHide:true（Windows 无控制台父进程防弹窗红线）", async () => {
    const calls: Array<{command: string; options: {windowsHide?: boolean}}> = [];
    const result = await runDeepaa({
      args: ["open"],
      env: {...process.env, DEEPAA_DATA_DIR: sandbox} as NodeJS.ProcessEnv,
      stdout: {write: () => true},
      stderr: {write: () => true},
      signalEmitter: new EventEmitter(),
      spawnProcess: ((command: string, args: string[], options: {windowsHide?: boolean}) => {
        calls.push({command, options});
        const child = new EventEmitter() as EventEmitter & {stdout?: undefined};
        setImmediate(() => child.emit("exit", 0));
        return child;
      }) as never,
    });
    expect(result.command).toBe("all");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.options.windowsHide).toBe(true);
    }
  });
});
