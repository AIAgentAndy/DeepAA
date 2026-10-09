import { randomUUID } from "crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { normalizeAgentScope } from "@/types";
import { SyncStore } from "@/lib/sync-engine/store";
import type { DevelopmentCredentialMetadata } from "./types";

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_CREDENTIALS = 200;

interface MetadataFile {
  version: 1;
  credentials: DevelopmentCredentialMetadata[];
}

interface CreateCredentialMetadataInput {
  id?: string;
  targetId: string;
  label: string;
  platform: NodeJS.Platform;
  secret: string;
  rateMultiplier?: number;
  agentScope?: string[];
  now?: string;
}

interface CreateOAuthCredentialMetadataInput {
  id?: string;
  targetId: string;
  label: string;
  platform: NodeJS.Platform;
  accessToken: string;
  refreshTokenCredentialId?: string;
  provider: "openai";
  expiresAt: string;
  accountId?: string;
  rateMultiplier?: number;
  agentScope?: string[];
  now?: string;
}

export function createCredentialMetadata(
  input: CreateCredentialMetadataInput,
): DevelopmentCredentialMetadata {
  const id = input.id || `cred_${randomUUID().replaceAll("-", "")}`;
  const now = input.now || new Date().toISOString();
  const label = input.label.trim();
  if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error("CREDENTIAL_LABEL_REQUIRED");
  }
  if (!input.secret) throw new Error("CREDENTIAL_SECRET_REQUIRED");
  if (input.platform !== "darwin" && input.platform !== "win32") {
    throw new Error("UNSUPPORTED_PLATFORM");
  }
  const rateMultiplier = normalizeRateMultiplier(input.rateMultiplier);
  const agentScope = normalizeAgentScope(input.agentScope);
  return {
    id,
    targetId: input.targetId,
    label,
    kind: "api_key",
    store: input.platform === "darwin" ? "macos-keychain" : "windows-credential-manager",
    account: id,
    // 指纹记录密钥前 4 位 + 后 4 位（如 sk-a1****z9），与中转站/官方隐码习惯一致，便于肉眼辨认。
    fingerprintSuffix: fingerprintForSecret(input.secret),
    ...(rateMultiplier === undefined ? {} : {rateMultiplier}),
    // 显式记录用户勾选的 Agent：没有「全部」值域，未选择即为空数组。
    agentScope,
    createdAt: now,
    updatedAt: now,
  };
}

/** 创建 OAuth 脱敏元数据；真实 token 由调用方单独写入系统凭据库。 */
export function createOAuthCredentialMetadata(
  input: CreateOAuthCredentialMetadataInput,
): DevelopmentCredentialMetadata {
  const id = input.id || `cred_${randomUUID().replaceAll("-", "")}`;
  const now = input.now || new Date().toISOString();
  const label = input.label.trim();
  if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw new Error("CREDENTIAL_LABEL_REQUIRED");
  }
  if (!input.accessToken) throw new Error("CREDENTIAL_SECRET_REQUIRED");
  if (input.platform !== "darwin" && input.platform !== "win32") throw new Error("UNSUPPORTED_PLATFORM");
  const expiresAt = normalizeIsoTimestamp(input.expiresAt);
  const refreshTokenCredentialId = input.refreshTokenCredentialId
    ? normalizeCredentialReference(input.refreshTokenCredentialId)
    : undefined;
  const rateMultiplier = normalizeRateMultiplier(input.rateMultiplier);
  const agentScope = normalizeAgentScope(input.agentScope);
  return {
    id,
    targetId: input.targetId,
    label,
    kind: "oauth",
    store: input.platform === "darwin" ? "macos-keychain" : "windows-credential-manager",
    account: id,
    fingerprintSuffix: fingerprintForSecret(input.accessToken),
    oauth: {
      provider: input.provider,
      expiresAt,
      accessTokenCredentialId: id,
      ...(refreshTokenCredentialId ? {refreshTokenCredentialId} : {}),
      ...(input.accountId?.trim() ? {accountId: input.accountId.trim().slice(0, 256)} : {}),
    },
    ...(rateMultiplier === undefined ? {} : {rateMultiplier}),
    agentScope,
    createdAt: now,
    updatedAt: now,
  };
}

/** OAuth 删除/回滚需要同时清理 access 与 refresh 引用。 */
export function credentialSecretIds(metadata: DevelopmentCredentialMetadata): string[] {
  if (metadata.kind !== "oauth" || !metadata.oauth) return [metadata.id];
  return [...new Set([
    metadata.oauth.accessTokenCredentialId,
    ...(metadata.oauth.refreshTokenCredentialId ? [metadata.oauth.refreshTokenCredentialId] : []),
  ])];
}

/** 密钥指纹：前 4 位 + **** + 后 4 位；过短密钥整体隐藏。 */
export function fingerprintForSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) return "****";
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

export function normalizeRateMultiplier(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("INVALID_RATE_MULTIPLIER");
  return Math.round(parsed * 1000) / 1000;
}

export class CredentialMetadataRepository {
  constructor(private readonly filePath: string) {}

  async list(targetId?: string): Promise<DevelopmentCredentialMetadata[]> {
    const file = await this.read();
    return file.credentials
      .filter(item => !targetId || item.targetId === targetId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async find(id: string): Promise<DevelopmentCredentialMetadata | undefined> {
    return (await this.read()).credentials.find(item => item.id === id);
  }

  async upsert(metadata: DevelopmentCredentialMetadata): Promise<void> {
    const file = await this.read();
    const index = file.credentials.findIndex(item => item.id === metadata.id);
    if (index >= 0) file.credentials[index] = metadata;
    else file.credentials.push(metadata);
    if (file.credentials.length > MAX_CREDENTIALS) throw new Error("CREDENTIAL_LIMIT_EXCEEDED");
    await this.write(file);
  }

  async remove(id: string): Promise<boolean> {
    const file = await this.read();
    const next = file.credentials.filter(item => item.id !== id);
    if (next.length === file.credentials.length) return false;
    await this.write({ ...file, credentials: next });
    return true;
  }

  /** 更新密钥名称（远程同步对齐时写回）；名称相同则不写，保留其它字段并刷新 updatedAt。 */
  async updateLabel(id: string, label: string): Promise<boolean> {
    const file = await this.read();
    const index = file.credentials.findIndex(item => item.id === id);
    if (index < 0) return false;
    const current = file.credentials[index]!;
    if (current.label === label) return true;
    file.credentials[index] = {...current, label, updatedAt: new Date().toISOString()};
    await this.write(file);
    return true;
  }

  /** 更新密钥倍率（控制台同步对齐时写回元数据），保留其它字段并刷新 updatedAt。 */
  /** 清除密钥倍率（远端无倍率时回退 1 的级联动作）；保留其它字段。 */
  async clearRateMultiplier(id: string): Promise<boolean> {
    const file = await this.read();
    const index = file.credentials.findIndex(item => item.id === id);
    if (index < 0) return false;
    file.credentials[index] = {...file.credentials[index]!};
    delete file.credentials[index]!.rateMultiplier;
    file.credentials[index]!.updatedAt = new Date().toISOString();
    await this.write(file);
    return true;
  }

  /** 收回密钥的全部 Agent 适用（远端无倍率级联）；保留其它字段。 */
  async clearAgentScope(id: string): Promise<boolean> {
    const file = await this.read();
    const index = file.credentials.findIndex(item => item.id === id);
    if (index < 0) return false;
    file.credentials[index] = {...file.credentials[index]!, agentScope: [], updatedAt: new Date().toISOString()};
    await this.write(file);
    return true;
  }

  async updateRateMultiplier(id: string, rateMultiplier: number): Promise<boolean> {
    const file = await this.read();
    const index = file.credentials.findIndex(item => item.id === id);
    if (index < 0) return false;
    file.credentials[index] = {
      ...file.credentials[index]!,
      rateMultiplier,
      updatedAt: new Date().toISOString(),
    };
    await this.write(file);
    return true;
  }

  private async read(): Promise<MetadataFile> {
    try {
      const metadata = await stat(this.filePath);
      if (metadata.size > MAX_METADATA_BYTES) throw new Error("CREDENTIAL_METADATA_TOO_LARGE");
      const parsed = JSON.parse(await readFile(this.filePath, "utf-8")) as unknown;
      return normalizeMetadataFile(parsed);
    } catch (error) {
      if (isFileNotFound(error)) return { version: 1, credentials: [] };
      throw error;
    }
  }

  private async write(file: MetadataFile): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const tempPath = join(directory, `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    await chmod(tempPath, 0o600).catch(() => undefined);
    await rename(tempPath, this.filePath);
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }
}

/**
 * 按凭据 ID 读取价格倍率（计费读取链）：
 * 1. 手动 rateMultiplier（元数据文件，用户显式覆盖优先）；
 * 2. 同步引擎自动倍率快照（SQLite credential_rate_snapshots，source=auto_group）；
 * 3. 无倍率回退 1（2026-09-01 移除供应商级倍率概念，倍率只有密钥一层）。
 * db 缺省时保持旧行为（只读手动值），保证无 SQLite 环境不改变语义。
 */
export async function readCredentialRateMultiplier(
  filePath: string,
  credentialId: string | undefined,
  db?: DeepaaDatabase,
): Promise<number | undefined> {
  if (!credentialId) return undefined;
  const metadata = await readCredentialMetadataFile(filePath);
  const credential = metadata?.credentials.find(item => item.id === credentialId);
  if (credential?.rateMultiplier !== undefined) return credential.rateMultiplier;
  if (db) {
    const latest = new SyncStore(db).latestRate(credentialId);
    if (latest) return latest.ratio;
  }
  return credential?.rateMultiplier;
}

let cachedMetadataFile: MetadataFile | undefined;
let cachedMetadataSignature = "";

async function readCredentialMetadataFile(filePath: string): Promise<MetadataFile | undefined> {
  try {
    const metadata = await stat(filePath);
    const signature = `${metadata.size}:${metadata.mtimeMs}`;
    if (cachedMetadataFile && cachedMetadataSignature === signature) return cachedMetadataFile;
    if (metadata.size > MAX_METADATA_BYTES) return undefined;
    const parsed = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
    const normalized = normalizeMetadataFile(parsed);
    cachedMetadataFile = normalized;
    cachedMetadataSignature = signature;
    return normalized;
  } catch {
    return undefined;
  }
}

function normalizeMetadataFile(value: unknown): MetadataFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_CREDENTIAL_METADATA");
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.credentials)) {
    throw new Error("INVALID_CREDENTIAL_METADATA");
  }
  const credentials = raw.credentials.map(normalizeCredential);
  if (credentials.length > MAX_CREDENTIALS) throw new Error("CREDENTIAL_LIMIT_EXCEEDED");
  return { version: 1, credentials };
}

function normalizeCredential(value: unknown): DevelopmentCredentialMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_CREDENTIAL_METADATA");
  }
  const raw = value as Record<string, unknown>;
  const required = ["id", "targetId", "label", "account", "fingerprintSuffix", "createdAt", "updatedAt"] as const;
  for (const key of required) {
    if (typeof raw[key] !== "string" || !raw[key]) throw new Error("INVALID_CREDENTIAL_METADATA");
  }
  if (raw.store !== "macos-keychain" && raw.store !== "windows-credential-manager") {
    throw new Error("INVALID_CREDENTIAL_METADATA");
  }
  let rateMultiplier: number | undefined;
  try {
    rateMultiplier = normalizeRateMultiplier(raw.rateMultiplier);
  } catch {
    rateMultiplier = undefined;
  }
  const agentScope = normalizeAgentScope(raw.agentScope);
  const kind = raw.kind === undefined || raw.kind === "api_key"
    ? "api_key"
    : raw.kind === "oauth"
    ? "oauth"
    : undefined;
  if (!kind) throw new Error("INVALID_CREDENTIAL_METADATA");
  const oauth = kind === "oauth" ? normalizeOAuthMetadata(raw.oauth, raw.id as string) : undefined;
  return {
    id: raw.id as string,
    targetId: raw.targetId as string,
    label: raw.label as string,
    kind,
    store: raw.store,
    account: raw.account as string,
    fingerprintSuffix: raw.fingerprintSuffix as string,
    ...(oauth ? {oauth} : {}),
    ...(rateMultiplier === undefined ? {} : {rateMultiplier}),
    agentScope,
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
  };
}

function normalizeOAuthMetadata(
  value: unknown,
  credentialId: string,
): NonNullable<DevelopmentCredentialMetadata["oauth"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_CREDENTIAL_METADATA");
  const raw = value as Record<string, unknown>;
  if (raw.provider !== "openai") throw new Error("INVALID_CREDENTIAL_METADATA");
  const expiresAt = normalizeIsoTimestamp(raw.expiresAt);
  const accessTokenCredentialId = normalizeCredentialReference(raw.accessTokenCredentialId);
  if (accessTokenCredentialId !== credentialId) throw new Error("INVALID_CREDENTIAL_METADATA");
  const refreshTokenCredentialId = raw.refreshTokenCredentialId === undefined
    ? undefined
    : normalizeCredentialReference(raw.refreshTokenCredentialId);
  const accountId = typeof raw.accountId === "string" && raw.accountId.trim()
    ? raw.accountId.trim().slice(0, 256)
    : undefined;
  return {
    provider: "openai",
    expiresAt,
    accessTokenCredentialId,
    ...(refreshTokenCredentialId ? {refreshTokenCredentialId} : {}),
    ...(accountId ? {accountId} : {}),
  };
}

function normalizeIsoTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error("INVALID_CREDENTIAL_METADATA");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("INVALID_CREDENTIAL_METADATA");
  return new Date(timestamp).toISOString();
}

function normalizeCredentialReference(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error("INVALID_CREDENTIAL_METADATA");
  }
  return value;
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
