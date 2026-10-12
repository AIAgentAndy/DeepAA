import {afterEach, beforeEach, describe, expect, test, vi} from "vitest";
import {homedir} from "node:os";

/**
 * 桌面客户端拉起器的进程目录（cwd）语义守护（2026-10-12 事故）：
 * spawn 缺省继承 web 进程 cwd——安装模式下 bin/deepaa.mjs 固定以 npm 包根目录
 * 为子进程 cwd，codex `app` 无路径参数时把继承的目录当工作区打开并弹
 * 「信任此文件夹」。拉起器必须：未选目录时显式以用户主目录为 cwd；
 * 选了目录时工作区参数与 cwd 都用用户所选目录。
 */
const {spawnMock} = vi.hoisted(() => ({spawnMock: vi.fn()}));

vi.mock("node:child_process", () => ({spawn: spawnMock}));

import {
  launchCodexClientApp,
  launchDshDesktopApp,
  launchZcodeDesktopApp,
} from "../src/lib/development-launch/strategies/shared.js";

const realPlatform = process.platform;

function fakeChild() {
  return {on: vi.fn(), unref: vi.fn()};
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(fakeChild);
});

afterEach(() => {
  Object.defineProperty(process, "platform", {value: realPlatform});
});

describe("桌面客户端拉起器的 cwd 语义", () => {
  test("codex 客户端未选目录：args 不带路径、cwd 显式为用户主目录", () => {
    launchCodexClientApp("/usr/local/bin/codex");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [executable, args, options] = spawnMock.mock.calls[0];
    expect(executable).toBe("/usr/local/bin/codex");
    expect(args).toEqual(["app"]);
    expect(options).toMatchObject({cwd: homedir(), detached: true, stdio: "ignore"});
  });

  test("codex 客户端选了目录：工作区参数与 cwd 必须都是用户所选目录", () => {
    launchCodexClientApp("/usr/local/bin/codex", "/Users/andy/projects/demo");
    const [, args, options] = spawnMock.mock.calls[0];
    expect(args).toEqual(["app", "/Users/andy/projects/demo"]);
    expect(options.cwd).toBe("/Users/andy/projects/demo");
    expect(options.cwd).not.toBe(homedir());
  });

  test("zcode（Windows）未选工作区：直接 spawn exe 时 cwd 显式为用户主目录", () => {
    Object.defineProperty(process, "platform", {value: "win32"});
    launchZcodeDesktopApp("C:\\Program Files\\ZCode\\ZCode.exe", undefined);
    const [executable, args, options] = spawnMock.mock.calls[0];
    expect(executable).toBe("C:\\Program Files\\ZCode\\ZCode.exe");
    expect(args).toEqual([]);
    expect(options).toMatchObject({cwd: homedir(), detached: true, stdio: "ignore"});
  });

  test("dsh（Windows）桌面客户端：直接 spawn exe 时 cwd 显式为用户主目录", () => {
    Object.defineProperty(process, "platform", {value: "win32"});
    launchDshDesktopApp("C:\\Users\\andy\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe");
    const [executable, args, options] = spawnMock.mock.calls[0];
    expect(executable).toContain("DeepSeek Harness");
    expect(args).toEqual([]);
    expect(options).toMatchObject({cwd: homedir(), detached: true, stdio: "ignore"});
  });
});
