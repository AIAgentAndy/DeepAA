import {posix, resolve, win32} from "node:path";
import {describe, expect, test} from "vitest";
import {resolveDeepaaDataDir} from "../src/lib/data-paths.js";
import {resolveLauncherDataDir} from "../bin/deepaa.mjs";

describe("Deepaa 数据目录", () => {
  test("绝对 DEEPAA_DATA_DIR 始终优先", () => {
    expect(resolveDeepaaDataDir("/ignored", {
      env: {DEEPAA_DATA_DIR: "/var/tmp/inspector-data"},
      platform: "darwin",
      homeDir: "/Users/tester",
      sourceCheckout: false,
    })).toBe("/var/tmp/inspector-data");
  });

  test("拒绝依赖当前工作目录解释的相对显式路径", () => {
    expect(() => resolveDeepaaDataDir("/project", {
      env: {DEEPAA_DATA_DIR: "../shared-data"},
      sourceCheckout: true,
    })).toThrow("必须是绝对路径");
  });

  test("源码模式默认使用用户目录，与安装模式行为一致", () => {
    expect(resolveDeepaaDataDir("/repo/deepaa", {
      env: {},
      platform: "darwin",
      homeDir: "/Users/tester",
    })).toBe("/Users/tester/.deepaa");
    expect(resolveLauncherDataDir({
      rootDir: "/repo/deepaa",
      cwd: "/tmp/arbitrary-cwd",
      env: {},
      platform: "darwin",
      homeDir: "/Users/tester",
    })).toBe("/Users/tester/.deepaa");
  });

  test("显式 sourceCheckout 时回退使用项目根 data 而不是调用方 cwd", () => {
    expect(resolveDeepaaDataDir("/repo/deepaa", {
      env: {},
      sourceCheckout: true,
    })).toBe(resolve("/repo/deepaa/data"));
    // resolveLauncherDataDir 被 platform:"darwin" 钉死为 posix 语义，
    // 期望值也必须按 posix 计算，否则在 Windows 宿主上会被补上盘符。
    expect(resolveLauncherDataDir({
      rootDir: "/repo/deepaa",
      cwd: "/tmp/arbitrary-cwd",
      env: {},
      sourceCheckout: true,
      platform: "darwin",
      homeDir: "/Users/tester",
    })).toBe(posix.resolve("/repo/deepaa/data"));
  });

  test("macOS 安装模式使用 ~/.deepaa", () => {
    expect(resolveDeepaaDataDir("/read-only/package", {
      env: {},
      platform: "darwin",
      homeDir: "/Users/tester",
      sourceCheckout: false,
    })).toBe("/Users/tester/.deepaa");
  });

  test("Windows 安装模式使用 ~/.deepaa", () => {
    expect(resolveDeepaaDataDir("C:\\read-only\\package", {
      env: {LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local"},
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      sourceCheckout: false,
    })).toBe(win32.join("C:\\Users\\tester", ".deepaa"));
  });

  test("Linux 安装模式使用 ~/.deepaa", () => {
    expect(resolveDeepaaDataDir("/read-only/package", {
      env: {},
      platform: "linux",
      homeDir: "/home/tester",
      sourceCheckout: false,
    })).toBe("/home/tester/.deepaa");
  });

  test("启动器向代理和 Web 注入同一个绝对目录", async () => {
    const {buildDeepaaChildEnvironment} = await import("../bin/deepaa.mjs");
    const dataDir = "/tmp/deepaa-shared";
    const environments = buildDeepaaChildEnvironment({
      baseEnv: {DEEPAA_DATA_DIR: dataDir},
      dataDir,
      production: true,
    });

    expect(environments.proxy.DEEPAA_DATA_DIR).toBe(dataDir);
    expect(environments.web.DEEPAA_DATA_DIR).toBe(dataDir);
    expect(environments.proxy).not.toBe(environments.web);
  });
});
