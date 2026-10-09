#!/usr/bin/env node

/**
 * DeepAA 桌面启动图标（批次 2 · C8，2026-10-05 用户确认）：
 * - macOS：在应用程序目录生成 `DeepAA.app`——点击后在系统默认终端执行 `deepaa`
 *   （与手敲完全一致），命令结束后自动关闭该终端标签页；`--silent` 变体改为
 *   静默拉起 + 系统通知（无终端窗口）。本地生成 ⇒ 无下载隔离标记 ⇒ 无需签名/公证。
 * - Windows：开始菜单生成 `DeepAA.lnk`（`cmd /c deepaa`，启动器退出后窗口自动
 *   关闭；WindowStyle=7 最小化）。仅命令构造，真实行为待 Windows 环境验收。
 * - 入侵性：仅用户主动 `deepaa icon install` 才存在；无自启、无常驻进程、无系统
 *   权限申请；卸载 = 删除文件（`deepaa icon uninstall`）。
 */

import {spawn} from "node:child_process";
import {chmod, copyFile, mkdir, rm, stat, writeFile} from "node:fs/promises";
import {homedir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

export const MACOS_APP_NAME = "DeepAA.app";
export const APP_BUNDLE_ID = "dev.deepaa.launcher";

export function iconPaths(options = {}) {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const globalDir = platform === "win32"
    ? join(homeDir, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs")
    : join(homeDir, "Applications");
  const applicationsDir = options.applicationsDir ?? globalDir;
  return {
    applicationsDir,
    appBundle: join(applicationsDir, MACOS_APP_NAME),
    shortcut: join(applicationsDir, "DeepAA.lnk"),
  };
}

// ---------------------------------------------------------------------------
// macOS .app 内容构造（纯函数，测试可断言）
// ---------------------------------------------------------------------------

export function buildLauncherInfoPlist(options = {}) {
  const version = options.version ?? "1.0.0";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>DeepAA</string>
  <key>CFBundleDisplayName</key>
  <string>DeepAA</string>
  <key>CFBundleIdentifier</key>
  <string>${APP_BUNDLE_ID}</string>
  <key>CFBundleExecutable</key>
  <string>DeepAA</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleIconFile</key>
  <string>DeepAA</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
</dict>
</plist>
`;
}

/** 终端可见形态（默认）：Terminal 执行 deepaa，命令结束后自动关闭该标签页。 */
export function buildLauncherExecutableScript() {
  return `#!/bin/bash
# DeepAA 启动器：在系统默认终端运行 deepaa（与手敲一致），结束后自动关闭本标签页。
exec /usr/bin/osascript <<'OSA'
tell application "Terminal"
  activate
  set t to do script "deepaa"
  repeat while t is busy
    delay 0.3
  end repeat
  close t
end tell
OSA
`;
}

/** 静默形态（--silent）：无终端窗口，拉起后以系统通知反馈，浏览器即所见。 */
export function buildLauncherExecutableScriptSilent() {
  return `#!/bin/bash
# DeepAA 启动器（静默）：后台拉起 deepaa，浏览器打开控制台，弹一条系统通知。
"${commandDiscoverLine()}"
deepaa >/dev/null 2>&1 &
disown
/usr/bin/osascript -e 'display notification "DeepAA 控制台已打开" with title "DeepAA"' >/dev/null 2>&1 || true
`;
}

function commandDiscoverLine() {
  // npm 全局 bin 常见于 PATH；启动器由用户会话触发，登录项 PATH 语义即可覆盖。
  return "# deepaa 依赖 PATH（npm 全局 bin）";
}

// ---------------------------------------------------------------------------
// .icns 生成（macOS 内置 sips + iconutil；命令构造可测）
// ---------------------------------------------------------------------------

export function buildIcnsCommands(options) {
  const {pngPath, iconsetDir, icnsPath} = options;
  const sizes = [
    ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
  ];
  const commands = [];
  for (const [name, size] of sizes) {
    commands.push({command: "/usr/bin/sips", args: ["-z", String(size), String(size), pngPath, "--out", join(iconsetDir, name)]});
  }
  commands.push({command: "/usr/bin/iconutil", args: ["-c", "icns", iconsetDir, "-o", icnsPath]});
  return commands;
}

// ---------------------------------------------------------------------------
// install / uninstall
// ---------------------------------------------------------------------------

export async function installDesktopIcon(options = {}) {
  const platform = options.platform ?? process.platform;
  const rootDir = options.rootDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const paths = iconPaths(options);
  const silent = options.silent === true;
  const exec = options.exec ?? defaultExec;
  if (platform === "win32") {
    await mkdir(paths.applicationsDir, {recursive: true});
    const {buildWindowsShortcutCommand} = await import("./deepaa-service.mjs");
    const command = buildWindowsShortcutCommand({shortcutPath: paths.shortcut, iconPath: options.iconPath});
    const result = await exec(command.command, command.args);
    if (result.code !== 0) {
      throw new Error(`创建开始菜单快捷方式失败：${result.stderr || result.stdout}`);
    }
    return {platform: "win32", path: paths.shortcut, silent};
  }
  if (platform !== "darwin") {
    throw new Error("当前平台不支持桌面图标（仅 macOS / Windows）");
  }
  const contents = join(paths.appBundle, "Contents");
  await mkdir(join(contents, "MacOS"), {recursive: true});
  await mkdir(join(contents, "Resources"), {recursive: true});
  await writeFile(join(contents, "Info.plist"), buildLauncherInfoPlist({version: options.version}), "utf8");
  const scriptPath = join(contents, "MacOS", "DeepAA");
  await writeFile(scriptPath, silent ? buildLauncherExecutableScriptSilent() : buildLauncherExecutableScript(), "utf8");
  await chmod(scriptPath, 0o755);
  // 图标：优先 --icon <png>；缺省用随包分发的 src/app/icon.png；缺失时跳过（通用灰色图标）。
  const iconSource = options.iconPath ?? join(rootDir, "src", "app", "icon.png");
  let iconApplied = false;
  try {
    await stat(iconSource);
    const iconsetDir = join(paths.appBundle, "Contents", "Resources", "DeepAA.iconset");
    await mkdir(iconsetDir, {recursive: true});
    for (const command of buildIcnsCommands({
      pngPath: iconSource,
      iconsetDir,
      icnsPath: join(contents, "Resources", "DeepAA.icns"),
    })) {
      const result = await exec(command.command, command.args);
      if (result.code !== 0) throw new Error(`${command.command} 失败：${result.stderr || result.stdout}`);
    }
    await rm(iconsetDir, {recursive: true, force: true});
    iconApplied = true;
  } catch (error) {
    if (options.iconPath) throw error instanceof Error ? error : new Error(String(error));
    // 缺省图标源缺失（异常安装形态）：保留无图标的可用 .app，不阻断安装。
    iconApplied = false;
  }
  return {platform: "darwin", path: paths.appBundle, silent, iconApplied};
}

export async function uninstallDesktopIcon(options = {}) {
  const platform = options.platform ?? process.platform;
  const paths = iconPaths(options);
  if (platform === "win32") {
    await rm(paths.shortcut, {force: true});
    return {removed: [paths.shortcut]};
  }
  await rm(paths.appBundle, {recursive: true, force: true});
  return {removed: [paths.appBundle]};
}

function defaultExec(command, args) {
  return new Promise(resolvePromise => {
    const child = spawn(command, args, {windowsHide: true});
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.once("error", error => resolvePromise({code: 1, stdout, stderr: String(error)}));
    child.once("close", code => resolvePromise({code: code ?? 1, stdout, stderr}));
  });
}
