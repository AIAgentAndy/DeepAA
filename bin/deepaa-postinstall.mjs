#!/usr/bin/env node

/**
 * npm 安装即完成（F1，2026-10-05 用户确认）：`npm install -g deepaa`、`npm link`
 * 与版本升级时自动执行——尽力安装桌面图标 + 打印欢迎提示（启动命令 / 桌面图标 /
 * deepaa service install 说明 / deepaa help）。
 *
 * 安装后自动启动（2026-10-08 用户确认）：全局安装时静默触发一次智能启动
 * （detached spawn `deepaa`，检测端口、补缺服务、开浏览器、退出）。门禁矩阵：
 * 仅 darwin/win32、非 CI、DEEPAA_NO_LAUNCH≠1、且 npm_config_global/npm_config_link
 * 为 true（本地 pnpm install 装依赖不触发，避免开发机被打扰）。
 *
 * 红线：任何失败（平台不支持/权限/工具缺失/启动失败）绝不中断安装——图标有首次运行
 * `deepaa` 的自动补齐兜底（F3），启动有用户手动 `deepaa` 兜底。
 * Linux/CI 平台直接跳过（产品仅支持 macOS/Windows）。
 * 逃生口：环境变量 DEEPAA_SKIP_POSTINSTALL=1 跳过（CI/打包场景）。
 */

import {spawn} from "node:child_process";
import {homedir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

/** 欢迎文案（2026-10-05 用户定稿；2026-10-08 增加自动启动形态）。图标生成失败时仅在快捷入口下补一行说明。 */
export function buildPostinstallWelcome(options = {}) {
  const lines = [
    "DeepAA 安装成功！",
    "",
  ];
  if (options.autoLaunch === true) {
    lines.push(
      "正在自动启动 DeepAA，浏览器即将打开控制台：http://127.0.0.1:3210",
      "→ 若浏览器未自动打开，运行 deepaa 手动启动",
    );
  } else {
    lines.push(
      "启动命令：deepaa",
      "→ 自动启动服务，并打开控制台：http://127.0.0.1:3210",
    );
  }
  lines.push(
    "",
    "快捷入口",
    "macOS：应用程序 → DeepAA",
    "Windows：开始菜单 → DeepAA",
    "→ 点击即可启动并打开控制台",
  );
  if (options.iconInstalled === false) {
    lines.push("→ 本次图标生成失败：首次运行 deepaa 时会自动补齐");
  }
  lines.push(
    "",
    "开机自启 / 崩溃自动恢复（可选）",
    "deepaa service install",
    "→ 注册为当前用户的后台服务",
    "→ 登录系统后自动运行，异常退出后自动恢复",
    "",
    "查看全部命令",
    "deepaa help",
  );
  return lines.join("\n");
}

/** 自动启动门禁（2026-10-08 用户确认矩阵）。 */
export function shouldAutoLaunch(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== "darwin" && platform !== "win32") return false;
  if (env.DEEPAA_NO_LAUNCH === "1") return false;
  if (env.CI) return false;
  // 仅全局安装 / npm link 触发：本地 pnpm install（无 npm_config_global）不启动。
  return env.npm_config_global === "true" || env.npm_config_link === "true";
}

export async function runPostinstall(options = {}) {
  if (process.env.DEEPAA_SKIP_POSTINSTALL === "1") return {skipped: true};
  const platform = options.platform ?? process.platform;
  const output = options.output ?? (text => console.log(text));
  if (platform !== "darwin" && platform !== "win32") {
    return {skipped: true, reason: `unsupported platform: ${platform}`};
  }
  let iconInstalled;
  try {
    const {installDesktopIcon} = await import("./deepaa-icon.mjs");
    await installDesktopIcon({
      platform,
      homeDir: options.homeDir ?? homedir(),
      ...(options.exec !== undefined ? {exec: options.exec} : {}),
      ...(options.applicationsDir !== undefined ? {applicationsDir: options.applicationsDir} : {}),
    });
    // 成功即视为已安装（macOS 图标源缺失时也是可用的通用图标 .app）。
    iconInstalled = true;
  } catch {
    iconInstalled = false;
  }
  const autoLaunch = options.autoLaunch ?? shouldAutoLaunch({platform, ...(options.env !== undefined ? {env: options.env} : {})});
  output(buildPostinstallWelcome({iconInstalled, autoLaunch}));
  if (autoLaunch) {
    try {
      const spawnProcess = options.spawnProcess ?? spawn;
      const launcherPath = join(dirname(fileURLToPath(import.meta.url)), "deepaa.mjs");
      const child = spawnProcess(options.nodeExecutable ?? process.execPath, [launcherPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      // spawn 的异步失败（如 ENOENT）经 error 事件到达：无监听会抛未捕获异常，
      // 必须吞掉——自动启动失败绝不影响安装。
      child.once("error", () => {});
      child.unref?.();
    } catch {
      /* 同上：启动失败绝不中断安装 */
    }
  }
  return {skipped: false, iconInstalled, autoLaunch};
}

const currentFile = await import("node:url").then(url => url.fileURLToPath(import.meta.url));
const invoked = await import("node:path").then(path => path.resolve(process.argv[1] ?? "") === path.resolve(currentFile));
if (invoked) {
  runPostinstall().catch(() => {
    /* 安装提示永不失败 */
  });
}
