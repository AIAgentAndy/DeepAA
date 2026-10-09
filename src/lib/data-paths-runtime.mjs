import {homedir} from "node:os";
import {posix, win32} from "node:path";

/**
 * @typedef {Object} ResolveDataDirOptions
 * @property {Record<string, string | undefined>} [env]
 * @property {NodeJS.Platform} [platform]
 * @property {string} [homeDir]
 * @property {boolean} [sourceCheckout]
 */

/**
 * 统一解析运行数据目录；安装模式永远不把可变数据写进包目录。
 * 所有平台默认使用用户主目录下的 ~/.deepaa（与 Codex ~/.codex、Claude Code ~/.claude 保持一致），
 * 可用 DEEPAA_DATA_DIR 覆盖；显式 sourceCheckout 才回退项目根 data/。
 *
 * @param {string} [projectRoot]
 * @param {ResolveDataDirOptions} [options]
 * @returns {string}
 */
export function resolveDeepaaDataDir(projectRoot = process.cwd(), options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const configured = env.DEEPAA_DATA_DIR?.trim();
  if (configured) {
    if (!pathApi.isAbsolute(configured)) {
      throw new Error("DEEPAA_DATA_DIR 必须是绝对路径");
    }
    return pathApi.normalize(configured);
  }

  if (options.sourceCheckout === true) {
    return pathApi.resolve(/* turbopackIgnore: true */ projectRoot, "data");
  }

  const userHome = options.homeDir || homedir();
  if (platform === "darwin") {
    return posix.join(userHome, ".deepaa");
  }
  if (platform === "win32") {
    return win32.join(userHome, ".deepaa");
  }
  return posix.join(userHome, ".deepaa");
}
