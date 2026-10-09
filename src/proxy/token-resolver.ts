import {spawn} from "node:child_process";

export interface GatewayTokenResolverOptions {
  credentialHelperPath: string;
  cacheTtlMs?: number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * 按供应商凭据 ID 从系统凭据库解析真实 token。
 * 只 spawn 现有 credential-helper 子进程，不导入任何凭据库模块，
 * 结果只在内存缓存，绝不落盘。
 */
export class GatewayTokenResolver {
  private readonly helperPath: string;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CachedToken>();

  constructor(options: GatewayTokenResolverOptions) {
    this.helperPath = options.credentialHelperPath;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
  }

  async resolve(credentialId: string): Promise<string> {
    const cached = this.cache.get(credentialId);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const token = await runHelper(this.helperPath, ["get", credentialId]);
    if (!token) throw new Error("CREDENTIAL_READ_FAILED");
    this.cache.set(credentialId, {token, expiresAt: Date.now() + this.cacheTtlMs});
    return token;
  }

  /** 只做存在性预检，不输出密钥内容。 */
  async exists(credentialId: string): Promise<boolean> {
    return runHelper(this.helperPath, ["exists", credentialId], {checkOnly: true}).then(
      () => true,
      () => false,
    );
  }
}

function runHelper(
  helperPath: string,
  args: string[],
  options: {checkOnly?: boolean} = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    // Windows 无法直接执行带 shebang 的 .mjs 脚本（spawn EFTYPE），统一经 process.execPath 启动。
    const win32 = process.platform === "win32";
    const child = spawn(
      win32 ? process.execPath : helperPath,
      win32 ? [helperPath, ...args] : args,
      {
        stdio: ["ignore", options.checkOnly ? "ignore" : "pipe", "ignore"],
      },
    );
    let stdout = "";
    if (!options.checkOnly) child.stdout?.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) {
        reject(new Error(`CREDENTIAL_HELPER_EXIT_${String(code)}`));
        return;
      }
      resolvePromise(stdout.replace(/[\r\n]+$/u, ""));
    });
  });
}
