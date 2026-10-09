/**
 * F1 postinstall 测试（2026-10-05 用户确认）：npm 安装即自动装图标 + 欢迎提示。
 * 核心红线：图标安装任何失败绝不中断安装；平台不支持跳过；逃生口环境变量。
 * 2026-10-08 追加：安装后自动启动（门禁矩阵 + 静默失败不中断）。
 */

import {readFile} from "node:fs/promises";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, describe, expect, test} from "vitest";
import {buildPostinstallWelcome, runPostinstall, shouldAutoLaunch} from "../bin/deepaa-postinstall.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "deepaa-postinstall-test-"));
afterAll(async () => {
  await rm(sandbox, {recursive: true, force: true});
});

describe("F1 欢迎文案（2026-10-05 用户定稿格式）", () => {
  test("标准形态：五个板块逐行锁定（双平台同一文案）", () => {
    const text = buildPostinstallWelcome({iconInstalled: true});
    const expected = [
      "DeepAA 安装成功！",
      "",
      "启动命令：deepaa",
      "→ 自动启动服务，并打开控制台：http://127.0.0.1:3210",
      "",
      "快捷入口",
      "macOS：应用程序 → DeepAA",
      "Windows：开始菜单 → DeepAA",
      "→ 点击即可启动并打开控制台",
      "",
      "开机自启 / 崩溃自动恢复（可选）",
      "deepaa service install",
      "→ 注册为当前用户的后台服务",
      "→ 登录系统后自动运行，异常退出后自动恢复",
      "",
      "查看全部命令",
      "deepaa help",
    ].join("\n");
    expect(text).toBe(expected);
  });

  test("图标失败形态：仅快捷入口下多一行补注，其余逐字不变", () => {
    const success = buildPostinstallWelcome({iconInstalled: true});
    const failed = buildPostinstallWelcome({iconInstalled: false});
    expect(failed).toContain("→ 本次图标生成失败：首次运行 deepaa 时会自动补齐");
    // 除补注行外与标准形态完全一致（去掉补注行后逐字相等）。
    expect(failed.replace("→ 本次图标生成失败：首次运行 deepaa 时会自动补齐\n", "")).toBe(success);
  });

  test("自动启动形态：首板块替换为「正在自动启动」+ 手动兜底，其余板块不变", () => {
    const standard = buildPostinstallWelcome({iconInstalled: true});
    const launching = buildPostinstallWelcome({iconInstalled: true, autoLaunch: true});
    expect(launching).toContain("正在自动启动 DeepAA，浏览器即将打开控制台：http://127.0.0.1:3210");
    expect(launching).toContain("→ 若浏览器未自动打开，运行 deepaa 手动启动");
    expect(launching).not.toContain("启动命令：deepaa\n");
    // 快捷入口与 service install 板块不受影响。
    expect(launching).toContain("deepaa service install");
    expect(launching.split("快捷入口")[1]).toBe(standard.split("快捷入口")[1]);
  });
});

describe("自动启动门禁矩阵（2026-10-08 用户确认）", () => {
  const base = {platform: "darwin", env: {}};

  test("仅全局安装 / npm link 触发；本地 pnpm install 不触发", () => {
    expect(shouldAutoLaunch({...base, env: {npm_config_global: "true"}})).toBe(true);
    expect(shouldAutoLaunch({...base, env: {npm_config_link: "true"}})).toBe(true);
    expect(shouldAutoLaunch({...base, env: {}})).toBe(false);
  });

  test("DEEPAA_NO_LAUNCH=1 / CI / 非 darwin-win32 平台一律不触发", () => {
    expect(shouldAutoLaunch({...base, env: {npm_config_global: "true", DEEPAA_NO_LAUNCH: "1"}})).toBe(false);
    expect(shouldAutoLaunch({...base, env: {npm_config_global: "true", CI: "true"}})).toBe(false);
    expect(shouldAutoLaunch({platform: "linux", env: {npm_config_global: "true"}})).toBe(false);
  });
});

describe("F1 runPostinstall 行为", () => {
  test("成功路径：调用图标安装并输出欢迎信息（默认不自动启动）", async () => {
    const lines: string[] = [];
    const spawnCalls: unknown[][] = [];
    const result = await runPostinstall({
      platform: "darwin",
      homeDir: sandbox,
      applicationsDir: join(sandbox, "Applications"),
      exec: async () => ({code: 0, stdout: "", stderr: ""}),
      output: text => lines.push(text),
      env: {},
      spawnProcess: ((command: string, args: unknown[], opts: unknown) => {
        spawnCalls.push([command, args, opts]);
        return {once() {}, unref() {}};
      }) as never,
    });
    expect(result).toEqual({skipped: false, iconInstalled: true, autoLaunch: false});
    expect(lines.join("\n")).toContain("deepaa service install");
    expect(lines.join("\n")).toContain("启动命令：deepaa");
    expect(spawnCalls).toEqual([]);
  });

  test("全局安装：输出自动启动文案并 detached 静默 spawn deepaa.mjs", async () => {
    const lines: string[] = [];
    const spawnCalls: {command: string; args: string[]; options: Record<string, unknown>}[] = [];
    const result = await runPostinstall({
      platform: "darwin",
      homeDir: sandbox,
      applicationsDir: join(sandbox, "Applications"),
      exec: async () => ({code: 0, stdout: "", stderr: ""}),
      output: text => lines.push(text),
      env: {npm_config_global: "true"},
      spawnProcess: ((command: string, args: string[], options: Record<string, unknown>) => {
        spawnCalls.push({command, args, options});
        return {once() {}, unref() {}};
      }) as never,
    });
    expect(result).toEqual({skipped: false, iconInstalled: true, autoLaunch: true});
    expect(lines.join("\n")).toContain("正在自动启动 DeepAA");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args[0]).toMatch(/deepaa\.mjs$/);
    expect(spawnCalls[0].options).toMatchObject({detached: true, stdio: "ignore"});
  });

  test("自动启动 spawn 抛错/异步 error：绝不中断安装（正常返回）", async () => {
    const result = await runPostinstall({
      platform: "darwin",
      homeDir: sandbox,
      applicationsDir: join(sandbox, "Applications"),
      exec: async () => ({code: 0, stdout: "", stderr: ""}),
      output: () => {},
      env: {npm_config_global: "true"},
      spawnProcess: (() => {
        throw new Error("spawn ENOENT");
      }) as never,
    });
    expect(result).toEqual({skipped: false, iconInstalled: true, autoLaunch: true});
  });

  test("DEEPAA_NO_LAUNCH=1：全局安装也只打印手动启动文案，不 spawn", async () => {
    const lines: string[] = [];
    const spawnCalls: unknown[] = [];
    const result = await runPostinstall({
      platform: "darwin",
      homeDir: sandbox,
      applicationsDir: join(sandbox, "Applications"),
      exec: async () => ({code: 0, stdout: "", stderr: ""}),
      output: text => lines.push(text),
      env: {npm_config_global: "true", DEEPAA_NO_LAUNCH: "1"},
      spawnProcess: (() => {
        spawnCalls.push(1);
        return {once() {}, unref() {}};
      }) as never,
    });
    expect(result).toEqual({skipped: false, iconInstalled: true, autoLaunch: false});
    expect(lines.join("\n")).toContain("启动命令：deepaa");
    expect(spawnCalls).toEqual([]);
  });

  test("图标安装抛错：绝不中断（降级文案，正常返回）", async () => {
    const lines: string[] = [];
    const result = await runPostinstall({
      platform: "darwin",
      applicationsDir: join("/definitely/not/writable", "x"),
      exec: async () => ({code: 0, stdout: "", stderr: ""}),
      output: text => lines.push(text),
      env: {},
    });
    expect(result).toEqual({skipped: false, iconInstalled: false, autoLaunch: false});
    expect(lines.join("\n")).toContain("→ 本次图标生成失败：首次运行 deepaa 时会自动补齐");
  });

  test("Linux/CI 平台直接跳过；DEEPAA_SKIP_POSTINSTALL=1 逃生口", async () => {
    const skipped = await runPostinstall({platform: "linux", output: () => {}});
    expect(skipped.skipped).toBe(true);
    const previous = process.env.DEEPAA_SKIP_POSTINSTALL;
    process.env.DEEPAA_SKIP_POSTINSTALL = "1";
    try {
      const escaped = await runPostinstall({platform: "darwin", output: () => {}});
      expect(escaped).toEqual({skipped: true});
    } finally {
      if (previous === undefined) delete process.env.DEEPAA_SKIP_POSTINSTALL;
      else process.env.DEEPAA_SKIP_POSTINSTALL = previous;
    }
  });

  test("package.json 已挂 postinstall 且脚本随 bin 分发", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(packageJson.scripts.postinstall).toBe("node ./bin/deepaa-postinstall.mjs");
    expect(packageJson.files).toContain("bin");
  });
});
