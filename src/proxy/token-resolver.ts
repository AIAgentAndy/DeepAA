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
 * Node http 的 header 合法字符集取反（[^\t\x20-\x7e\x80-\xff]）：token 原样拼进
 * Authorization 头，含这些字符时 http.request 同步抛错（2026-10-13 事故）。
 * 在解析层提前拒绝，错误信息可定位到密钥内容，而不是 Node 的笼统 header 报错；
 * 也是存量脏密钥（保存校验上线前已入系统凭据库）的运行时兜底。
 */
const HEADER_INVALID_FOR_TOKEN = /[^\t\u0020-\u007e\u0080-\u00ff]/;

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
    if (HEADER_INVALID_FOR_TOKEN.test(token)) {
      throw new Error("CREDENTIAL_TOKEN_INVALID_CHARS");
    }
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
    // 恒经 process.execPath 启动 helper（Windows 无法直接执行带 shebang 的
    // .mjs，spawn EFTYPE）。禁止 `process.platform === "win32"` 分支：Next
    // Turbopack 生产构建按「构建机」平台常数折叠并消除死分支（2026-10-13
    // 事故），本文件同时进入 web 与 proxy 两份构建产物，任何一侧折叠都致命。
    const child = spawn(
      process.execPath,
      [helperPath, ...args],
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
