/**
 * 批次 2 桌面图标测试（C8）：macOS .app 内容构造与安装/卸载（临时目录 + 注入
 * exec，不执行真实 sips/iconutil/powershell）；Windows 仅命令构造。
 */

import {mkdtemp, readFile, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, describe, expect, test} from "vitest";
import {
  APP_BUNDLE_ID,
  buildIcnsCommands,
  buildLauncherExecutableScript,
  buildLauncherExecutableScriptSilent,
  buildLauncherInfoPlist,
  installDesktopIcon,
  uninstallDesktopIcon,
} from "../bin/deepaa-icon.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "deepaa-icon-test-"));

afterAll(async () => {
  await rm(sandbox, {recursive: true, force: true});
});

const fakeExec = () => async () => ({code: 0, stdout: "", stderr: ""});

describe("C8 macOS .app 内容构造", () => {
  test("Info.plist：标识根 dev.deepaa.launcher、LSUIElement 无 Dock 残影", () => {
    const plist = buildLauncherInfoPlist({version: "1.0.0"});
    expect(plist).toContain(`<string>${APP_BUNDLE_ID}</string>`);
    expect(plist).toContain("<key>LSUIElement</key>");
    expect(plist).toContain("<string>1.0.0</string>");
    expect(plist).not.toContain("aiagentandy");
  });

  test("默认脚本：Terminal 执行 deepaa，结束后自动关闭该标签页（与手敲一致）", () => {
    const script = buildLauncherExecutableScript();
    expect(script).toContain('do script "deepaa"');
    expect(script).toContain("repeat while t is busy");
    expect(script).toContain("close t");
  });

  test("静默脚本：无终端、后台拉起 + 系统通知", () => {
    const script = buildLauncherExecutableScriptSilent();
    expect(script).toContain("deepaa");
    expect(script).toContain("display notification");
    expect(script).not.toContain("do script");
  });

  test("icns 命令组：10 档尺寸 sips + iconutil 收尾", () => {
    const commands = buildIcnsCommands({
      pngPath: "/tmp/logo.png",
      iconsetDir: "/tmp/DeepAA.iconset",
      icnsPath: "/tmp/DeepAA.icns",
    });
    expect(commands).toHaveLength(11);
    expect(commands.at(-1)!.command).toBe("/usr/bin/iconutil");
    expect(commands[0]!.args).toContain("16");
  });
});

describe("C8 安装 / 卸载（macOS，临时目录）", () => {
  test("install：写出可执行 .app 结构；图标源缺失时不阻断", async () => {
    const applicationsDir = join(sandbox, "Applications");
    const result = await installDesktopIcon({
      platform: "darwin",
      applicationsDir,
      rootDir: sandbox, // 无 src/app/icon.png → 走「缺省图标缺失」降级
      exec: fakeExec(),
    });
    expect(result.path).toBe(join(applicationsDir, "DeepAA.app"));
    expect(result.iconApplied).toBe(false);
    const script = await readFile(join(result.path, "Contents/MacOS/DeepAA"), "utf8");
    expect(script).toContain('do script "deepaa"');
    const info = await readFile(join(result.path, "Contents/Info.plist"), "utf8");
    expect(info).toContain(APP_BUNDLE_ID);
    // 可执行位：Windows 宿主文件系统无法保存 POSIX 执行位（chmod 为 no-op），
    // 仅在 POSIX 宿主上断言。
    const info2 = await stat(join(result.path, "Contents/MacOS/DeepAA"));
    if (process.platform !== "win32") {
      expect(info2.mode & 0o111).not.toBe(0);
    }
  });

  test("install --silent：静默形态脚本", async () => {
    const applicationsDir = join(sandbox, "Applications2");
    const result = await installDesktopIcon({
      platform: "darwin",
      applicationsDir,
      rootDir: sandbox,
      silent: true,
      exec: fakeExec(),
    });
    const script = await readFile(join(result.path, "Contents/MacOS/DeepAA"), "utf8");
    expect(script).toContain("display notification");
  });

  test("uninstall：移除 .app", async () => {
    const applicationsDir = join(sandbox, "Applications3");
    await installDesktopIcon({platform: "darwin", applicationsDir, rootDir: sandbox, exec: fakeExec()});
    const {removed} = await uninstallDesktopIcon({platform: "darwin", applicationsDir});
    await expect(stat(join(applicationsDir, "DeepAA.app"))).rejects.toThrow();
    expect(removed).toHaveLength(1);
  });
});
