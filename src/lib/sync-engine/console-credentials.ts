import {chmod, mkdir, readFile, rename, stat, writeFile} from "node:fs/promises";
import {basename, dirname, join} from "node:path";
import {randomUUID} from "node:crypto";

const MAX_ACCOUNT_BYTES = 1024 * 1024;

export interface ConsoleAccountSecret {
  targetId: string;
  providerType: string;
  consoleBaseUrl: string;
  username: string;
  password: string;
  /** 中转站（relay）首次同步识别出的底层类型；后续同步直接使用，不再循环探测。 */
  resolvedProvider?: "sub2api" | "newapi";
  /** 登录会话令牌（如 New API access_token），仅存本文件，不落 SQLite。 */
  sessionToken?: string;
  sessionExpiresAt?: string;
  updatedAt: string;
}

interface ConsoleCredentialsFile {
  version: 1;
  accounts: ConsoleAccountSecret[];
}

/**
 * 控制台登录凭据仓库：明文只落盘 ~/.deepaa/config/console-credentials.json（0600），
 * SQLite 只存脱敏引用与状态。web 进程独占读写；代理进程不读取本文件。
 */
export class ConsoleCredentialRepository {
  constructor(private readonly filePath: string) {}

  async upsert(account: ConsoleAccountSecret): Promise<void> {
    const file = await this.read();
    const index = file.accounts.findIndex(item => item.targetId === account.targetId);
    if (index >= 0) file.accounts[index] = account;
    else file.accounts.push(account);
    await this.write(file);
  }

  async find(targetId: string): Promise<ConsoleAccountSecret | undefined> {
    const file = await this.read();
    return file.accounts.find(item => item.targetId === targetId);
  }

  async remove(targetId: string): Promise<boolean> {
    const file = await this.read();
    const next = file.accounts.filter(item => item.targetId !== targetId);
    if (next.length === file.accounts.length) return false;
    await this.write({version: 1, accounts: next});
    return true;
  }

  async list(): Promise<ConsoleAccountSecret[]> {
    return (await this.read()).accounts;
  }

  private async read(): Promise<ConsoleCredentialsFile> {
    try {
      const info = await stat(this.filePath);
      if (info.size > MAX_ACCOUNT_BYTES) throw new Error("CONSOLE_CREDENTIALS_TOO_LARGE");
      const parsed = JSON.parse(await readFile(this.filePath, "utf-8")) as unknown;
      return normalizeFile(parsed);
    } catch (error) {
      if (isFileNotFound(error)) return {version: 1, accounts: []};
      throw error;
    }
  }

  private async write(file: ConsoleCredentialsFile): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, {recursive: true});
    const tempPath = join(directory, `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, {encoding: "utf-8", mode: 0o600});
    await chmod(tempPath, 0o600).catch(() => undefined);
    await rename(tempPath, this.filePath);
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }
}

export function normalizeConsoleAccountSecret(value: unknown): ConsoleAccountSecret {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_CONSOLE_ACCOUNT");
  }
  const raw = value as Record<string, unknown>;
  for (const key of ["targetId", "providerType", "consoleBaseUrl", "username", "password", "updatedAt"] as const) {
    if (typeof raw[key] !== "string" || !raw[key]) throw new Error("INVALID_CONSOLE_ACCOUNT");
  }
  return {
    targetId: raw.targetId as string,
    providerType: raw.providerType as string,
    consoleBaseUrl: raw.consoleBaseUrl as string,
    username: raw.username as string,
    password: raw.password as string,
    ...(raw.resolvedProvider === "sub2api" || raw.resolvedProvider === "newapi"
      ? {resolvedProvider: raw.resolvedProvider}
      : {}),
    ...(typeof raw.sessionToken === "string" && raw.sessionToken
      ? {sessionToken: raw.sessionToken as string}
      : {}),
    ...(typeof raw.sessionExpiresAt === "string" && raw.sessionExpiresAt
      ? {sessionExpiresAt: raw.sessionExpiresAt as string}
      : {}),
    updatedAt: raw.updatedAt as string,
  };
}

function normalizeFile(value: unknown): ConsoleCredentialsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_CONSOLE_CREDENTIALS");
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.accounts)) {
    throw new Error("INVALID_CONSOLE_CREDENTIALS");
  }
  return {version: 1, accounts: raw.accounts.map(normalizeConsoleAccountSecret)};
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** 默认控制台凭据文件路径：~/.deepaa/config/console-credentials.json。 */
export function defaultConsoleCredentialsPath(dataDir: string): string {
  return join(dataDir, "config", "console-credentials.json");
}
