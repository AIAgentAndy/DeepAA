import { spawn } from "child_process";
import { resolve } from "path";

interface CommandInput {
  command: string;
  args: string[];
  stdin?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type CommandRunner = (input: CommandInput) => Promise<CommandResult>;

interface CredentialStoreOptions {
  nodeExecutable?: string;
  helperPath?: string;
  run?: CommandRunner;
}

export function buildCredentialAuthCommand(input: {
  nodeExecutable?: string;
  helperPath?: string;
  credentialId: string;
}): { command: string; args: string[] } {
  return {
    command: input.nodeExecutable || process.execPath,
    args: [
      input.helperPath || resolve(process.cwd(), "bin", "credential-helper.mjs"),
      "get",
      input.credentialId,
    ],
  };
}

export class SystemCredentialStore {
  private readonly nodeExecutable: string;
  private readonly helperPath: string;
  private readonly run: CommandRunner;

  constructor(options: CredentialStoreOptions = {}) {
    this.nodeExecutable = options.nodeExecutable || process.execPath;
    this.helperPath = options.helperPath || resolve(process.cwd(), "bin", "credential-helper.mjs");
    this.run = options.run || runCommand;
  }

  async put(credentialId: string, label: string, secret: string): Promise<void> {
    const result = await this.run({
      command: this.nodeExecutable,
      args: [this.helperPath, "put", credentialId, label],
      stdin: secret,
    });
    ensureSuccess(result, "CREDENTIAL_WRITE_FAILED");
  }

  async get(credentialId: string): Promise<string> {
    const result = await this.run({
      command: this.nodeExecutable,
      args: [this.helperPath, "get", credentialId],
    });
    ensureSuccess(result, "CREDENTIAL_READ_FAILED");
    const secret = result.stdout.replace(/[\r\n]+$/, "");
    if (!secret) throw new Error("CREDENTIAL_READ_FAILED");
    return secret;
  }

  async delete(credentialId: string): Promise<void> {
    const result = await this.run({
      command: this.nodeExecutable,
      args: [this.helperPath, "delete", credentialId],
    });
    ensureSuccess(result, "CREDENTIAL_DELETE_FAILED");
  }

  async isAvailable(): Promise<boolean> {
    const result = await this.run({
      command: this.nodeExecutable,
      args: [this.helperPath, "check"],
    });
    return result.exitCode === 0;
  }
}

function ensureSuccess(result: CommandResult, code: string): void {
  if (result.exitCode !== 0) throw new Error(code);
}

async function runCommand(input: CommandInput): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    // stdin 的 EPIPE（子进程提前退出后写入）若无监听会成为未捕获异常、
    // 直接击穿 API 路由的 try/catch——Windows 实测事故（2026-10-09）：前端只看到
    // 「Unexpected end of JSON input」空响应。吞掉流错误，失败仍经 close 退出码上报。
    child.stdin.on("error", () => undefined);
    child.once("error", reject);
    child.once("close", code => resolvePromise({ stdout, stderr, exitCode: code ?? 1 }));
    if (input.stdin !== undefined) child.stdin.end(`${input.stdin}\n`);
    else child.stdin.end();
  });
}

