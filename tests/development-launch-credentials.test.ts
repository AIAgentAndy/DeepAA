import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  CredentialMetadataRepository,
  createCredentialMetadata,
  createOAuthCredentialMetadata,
} from "../src/lib/development-launch/credential-metadata.js";
import {
  buildCredentialAuthCommand,
  SystemCredentialStore,
} from "../src/lib/development-launch/credential-store.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("development credential metadata", () => {
  test("旧记录默认归一化为 api_key，OAuth 只持久化 token 引用与到期时间", async () => {
    const root = await mkdtemp(join(tmpdir(), "development-credentials-oauth-"));
    tempRoots.push(root);
    const filePath = join(root, "credentials.json");
    await writeFile(filePath, JSON.stringify({
      version: 1,
      credentials: [{
        id: "cred_legacy",
        targetId: "openai",
        label: "旧密钥",
        store: "macos-keychain",
        account: "cred_legacy",
        fingerprintSuffix: "sk-a****alue",
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
      }],
    }));
    const repository = new CredentialMetadataRepository(filePath);
    expect((await repository.find("cred_legacy"))?.kind).toBe("api_key");

    const oauth = createOAuthCredentialMetadata({
      id: "cred_oauth",
      targetId: "openai",
      label: "Codex OAuth",
      platform: "darwin",
      accessToken: "ey-access-token-secret",
      refreshTokenCredentialId: "cred_oauth_refresh",
      provider: "openai",
      accountId: "acct_123",
      expiresAt: "2026-08-18T00:00:00.000Z",
      agentScope: ["codex"],
      now: "2026-08-17T00:00:00.000Z",
    });
    await repository.upsert(oauth);

    expect(await repository.find("cred_oauth")).toMatchObject({
      kind: "oauth",
      oauth: {
        provider: "openai",
        accountId: "acct_123",
        expiresAt: "2026-08-18T00:00:00.000Z",
        accessTokenCredentialId: "cred_oauth",
        refreshTokenCredentialId: "cred_oauth_refresh",
      },
    });
    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain("ey-access-token-secret");
    expect(raw).not.toContain("refresh-token-secret");
  });

  test("拒绝缺少 provider、到期时间或 token 引用的 OAuth 元数据", async () => {
    const root = await mkdtemp(join(tmpdir(), "development-credentials-invalid-oauth-"));
    tempRoots.push(root);
    const filePath = join(root, "credentials.json");
    await writeFile(filePath, JSON.stringify({
      version: 1,
      credentials: [{
        id: "cred_invalid",
        targetId: "openai",
        label: "OAuth",
        kind: "oauth",
        store: "macos-keychain",
        account: "cred_invalid",
        fingerprintSuffix: "****",
        oauth: {provider: "openai"},
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
      }],
    }));

    await expect(new CredentialMetadataRepository(filePath).list()).rejects.toThrow("INVALID_CREDENTIAL_METADATA");
  });

  test("persists and normalizes agentScope; missing or empty scope is recorded explicitly as empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "development-credentials-"));
    tempRoots.push(root);
    const filePath = join(root, "config", "development-credentials.json");
    const repository = new CredentialMetadataRepository(filePath);

    const codexOnly = createCredentialMetadata({
      id: "cred_codex",
      targetId: "modelport.link",
      label: "gpt 稳定",
      platform: "darwin",
      secret: "sk-codex-only",
      agentScope: ["codex"],
    });
    const shared = createCredentialMetadata({
      id: "cred_shared",
      targetId: "modelport.link",
      label: "通用",
      platform: "darwin",
      secret: "sk-shared",
      agentScope: [],
    });
    const legacy = createCredentialMetadata({
      id: "cred_legacy",
      targetId: "modelport.link",
      label: "旧密钥",
      platform: "darwin",
      secret: "sk-legacy",
    });
    await repository.upsert(codexOnly);
    await repository.upsert(shared);
    await repository.upsert(legacy);

    const reloaded = await repository.list("modelport.link");
    expect(reloaded.find(item => item.id === "cred_codex")?.agentScope).toEqual(["codex"]);
    // 显式记录勾选结果：空数组与缺省都按「未选择任何 Agent」保存，不做全选推断。
    expect(reloaded.find(item => item.id === "cred_shared")?.agentScope).toEqual([]);
    expect(reloaded.find(item => item.id === "cred_legacy")?.agentScope).toEqual([]);

    // 显式白名单透传保留
    const future = createCredentialMetadata({
      id: "cred_future",
      targetId: "modelport.link",
      label: "未来",
      platform: "darwin",
      secret: "sk-future",
      agentScope: ["opencode"],
    });
    await repository.upsert(future);
    expect((await repository.find("cred_future"))?.agentScope).toEqual(["opencode"]);
  });

  test("persists metadata without persisting the secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "development-credentials-"));
    tempRoots.push(root);
    const filePath = join(root, "config", "development-credentials.json");
    const repository = new CredentialMetadataRepository(filePath);
    const secret = "sk-sensitive-value-f91a";
    const metadata = createCredentialMetadata({
      id: "cred_test",
      targetId: "ai98pro.xyz",
      label: "主密钥",
      platform: "darwin",
      secret,
      now: "2026-07-19T00:00:00.000Z",
    });

    await repository.upsert(metadata);

    expect(await repository.list("ai98pro.xyz")).toEqual([metadata]);
    const raw = await readFile(filePath, "utf-8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain(metadata.fingerprintSuffix);
  });

  test("filters credentials by target and removes one credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "development-credentials-"));
    tempRoots.push(root);
    const repository = new CredentialMetadataRepository(join(root, "credentials.json"));
    const first = createCredentialMetadata({
      id: "cred_a",
      targetId: "target-a",
      label: "A",
      platform: "darwin",
      secret: "secret-a",
    });
    const second = createCredentialMetadata({
      id: "cred_b",
      targetId: "target-b",
      label: "B",
      platform: "win32",
      secret: "secret-b",
    });
    await repository.upsert(first);
    await repository.upsert(second);

    expect(await repository.list("target-a")).toEqual([first]);
    expect(await repository.remove("cred_a")).toBe(true);
    expect(await repository.list()).toEqual([second]);
  });

  test("uses a non-secret fingerprint and rejects unsafe credential labels", () => {
    const secret = "tiny";
    const metadata = createCredentialMetadata({
      id: "cred_short",
      targetId: "target-a",
      label: "短密钥",
      platform: "darwin",
      secret,
    });

    expect(metadata.fingerprintSuffix).toHaveLength(4);
    expect(metadata.fingerprintSuffix).not.toBe(secret);
    expect(() => createCredentialMetadata({
      id: "cred_bad_label",
      targetId: "target-a",
      label: "bad\nlabel",
      platform: "darwin",
      secret: "secret-value",
    })).toThrow("CREDENTIAL_LABEL_REQUIRED");
  });

  test("drops unknown fields from metadata before returning it to an API", async () => {
    const root = await mkdtemp(join(tmpdir(), "development-credentials-"));
    tempRoots.push(root);
    const filePath = join(root, "credentials.json");
    await writeFile(filePath, JSON.stringify({
      version: 1,
      credentials: [{
        id: "cred_safe",
        targetId: "target-a",
        label: "A",
        store: "macos-keychain",
        account: "cred_safe",
        fingerprintSuffix: "1234",
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z",
        secret: "must-not-escape",
      }],
    }));

    const items = await new CredentialMetadataRepository(filePath).list();

    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty("secret");
    expect(JSON.stringify(items)).not.toContain("must-not-escape");
  });
});

describe("system credential helper wrapper", () => {
  test("builds an auth command without the secret", () => {
    const command = buildCredentialAuthCommand({
      nodeExecutable: "/usr/bin/node",
      helperPath: "/app/bin/credential-helper.mjs",
      credentialId: "cred_test",
    });

    expect(command).toEqual({
      command: "/usr/bin/node",
      args: ["/app/bin/credential-helper.mjs", "get", "cred_test"],
    });
  });

  test("passes a new secret only over stdin", async () => {
    const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
    const store = new SystemCredentialStore({
      nodeExecutable: "/usr/bin/node",
      helperPath: "/app/bin/credential-helper.mjs",
      run: async input => {
        calls.push(input);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const secret = "sk-only-on-stdin";

    await store.put("cred_test", "主密钥", secret);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.stdin).toBe(secret);
    expect(calls[0]?.args.join(" ")).not.toContain(secret);
  });
});
