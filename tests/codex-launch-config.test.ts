import {describe, expect, test} from "vitest";
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "fs/promises";
import {tmpdir} from "os";
import {join} from "path";
import {parse as parseToml} from "smol-toml";
import {
  ensureCodexConfigParsable,
  ensureCodexGatewayPlaceholderAuth,
  removeCodexPlaceholderAuth,
  setTomlTopLevelValue,
  writeCodexDefaultModel,
} from "../src/lib/development-launch/strategies/shared.js";
import {GATEWAY_PLACEHOLDER_TOKEN} from "../src/lib/config-sync/core/placeholder-auth.js";
import type {ProxyTarget} from "../src/types.js";

const tempRoots: string[] = [];

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-launch-config-"));
  tempRoots.push(root);
  const homeDir = join(root, "home");
  await mkdir(join(homeDir, ".codex"), {recursive: true});
  return homeDir;
}

describe("codex 启动链路配置写入与自愈（2026-10-11 修复）", () => {
  test.afterAll(async () => {
    await Promise.all(tempRoots.splice(0).map(path => rm(path, {recursive: true, force: true})));
  });

  test("新顶层键插入顶层区末尾，绝不落入末尾 section（事故回归）", () => {
    // 2026-10-11 Windows 事故原样夹具：文件以空 [profiles] 段结尾。
    const toml = [
      "model = \"gpt-6.1-sol_catapi.chat\"",
      "model_provider = \"deepaa_gateway\"",
      "",
      "[desktop]",
      "followUpQueueMode = \"steer\"",
      "",
      "[profiles]",
      "",
    ].join("\n");
    const next = setTomlTopLevelValue(toml, "sandbox_mode", "\"danger-full-access\"");
    const parsed = parseToml(next) as Record<string, unknown>;
    expect(parsed.sandbox_mode).toBe("danger-full-access");
    expect(parsed.profiles).toEqual({});
    // 插入点必须在首个 section 头之前，且不破坏原有顶层键。
    expect(next.indexOf("sandbox_mode")).toBeLessThan(next.indexOf("[desktop]"));
    expect(parsed.model).toBe("gpt-6.1-sol_catapi.chat");
  });

  test("section 内同名键不匹配：替换只认顶层，缺失时顶层插入", () => {
    const toml = "[profiles.work]\nmodel = \"gpt-x\"\n";
    const next = setTomlTopLevelValue(toml, "model", "\"new-model_t\"");
    const parsed = parseToml(next) as {model?: string; profiles?: {work?: {model?: string}}};
    expect(parsed.model).toBe("new-model_t");
    expect(parsed.profiles?.work?.model).toBe("gpt-x");
  });

  test("已存在的顶层键原位替换并保留注释", () => {
    const toml = "# 顶部注释\nmodel = \"old_t\"\n\n[desktop]\nfollowUpQueueMode = \"steer\"\n";
    const next = setTomlTopLevelValue(toml, "model", "\"new_t\"");
    expect(next).toContain("# 顶部注释");
    expect(next).toContain("model = \"new_t\"");
    expect(next).not.toContain("old_t");
  });

  test("writeCodexDefaultModel 对事故形态文件产出可解析配置且 sandbox 落顶层", async () => {
    const homeDir = await tempHome();
    await writeFile(join(homeDir, ".codex", "config.toml"), [
      "notify = [\"hook.exe\"]",
      "",
      "[desktop]",
      "followUpQueueMode = \"steer\"",
      "",
      "[profiles]",
      "",
    ].join("\n"), "utf8");
    await writeCodexDefaultModel(homeDir, {id: "catapi.chat"} as ProxyTarget, "gpt-6.1-sol", {
      sandboxMode: "danger-full-access",
    });
    const raw = await readFile(join(homeDir, ".codex", "config.toml"), "utf8");
    const parsed = parseToml(raw) as Record<string, unknown>;
    expect(parsed.model).toBe("gpt-6.1-sol_catapi.chat");
    expect(parsed.model_provider).toBe("deepaa_gateway");
    expect(parsed.sandbox_mode).toBe("danger-full-access");
    // 写入前按项目规则备份。
    const backups = (await readdir(join(homeDir, ".codex", "deepaa"))).filter(name =>
      name.startsWith("config.toml_bk_"));
    expect(backups.length).toBeGreaterThan(0);
  });

  test("健康配置：自愈检查零副作用", async () => {
    const homeDir = await tempHome();
    const configPath = join(homeDir, ".codex", "config.toml");
    await writeFile(configPath, "model = \"x_t\"\n", "utf8");
    expect(await ensureCodexConfigParsable(homeDir)).toBeUndefined();
    expect(await readFile(configPath, "utf8")).toBe("model = \"x_t\"\n");
  });

  test("损坏配置：从最近可解析备份恢复并留证坏文件", async () => {
    const homeDir = await tempHome();
    const configPath = join(homeDir, ".codex", "config.toml");
    const backupDir = join(homeDir, ".codex", "deepaa");
    await mkdir(backupDir, {recursive: true});
    await writeFile(join(backupDir, "config.toml_bk_20261011_060000"), "model = \"good_t\"\n", "utf8");
    await writeFile(join(backupDir, "config.toml_bk_20261011_061500"), "model = \"good2_t\"\n", "utf8");
    const broken = "[profiles]\nsandbox_mode = \"danger-full-access\"\n";
    await writeFile(configPath, broken, "utf8");

    const warning = await ensureCodexConfigParsable(homeDir);
    expect(warning?.code).toBe("CODEX_CONFIG_RESTORED_FROM_BACKUP");
    // 恢复的是最近一份（字典序最大）可解析备份。
    expect(await readFile(configPath, "utf8")).toBe("model = \"good2_t\"\n");
    const invalid = (await readdir(backupDir)).find(name => name.startsWith("config.toml_invalid_"));
    expect(invalid).toBeDefined();
    expect(await readFile(join(backupDir, invalid!), "utf8")).toBe(broken);
  });

  test("损坏配置且无可解析备份：保持原样并返回不可恢复提示", async () => {
    const homeDir = await tempHome();
    const configPath = join(homeDir, ".codex", "config.toml");
    const broken = "[profiles]\nsandbox_mode = \"x\"\n";
    await writeFile(configPath, broken, "utf8");
    const warning = await ensureCodexConfigParsable(homeDir);
    expect(warning?.code).toBe("CODEX_CONFIG_CORRUPT_UNRECOVERABLE");
    expect(await readFile(configPath, "utf8")).toBe(broken);
  });

  test("占位登录：缺失时预填，已有真实登录绝不覆盖", async () => {
    const homeDir = await tempHome();
    expect(await ensureCodexGatewayPlaceholderAuth(homeDir)).toBe(true);
    const prefilled = JSON.parse(await readFile(join(homeDir, ".codex", "auth.json"), "utf8"));
    expect(prefilled).toEqual({auth_mode: "apikey", OPENAI_API_KEY: GATEWAY_PLACEHOLDER_TOKEN});
    // 第二次（已存在）：不覆盖、返回 false。
    expect(await ensureCodexGatewayPlaceholderAuth(homeDir)).toBe(false);
    // 真实登录（tokens 结构）：绝不触碰。
    const realAuth = JSON.stringify({tokens: {access_token: "real"}}, null, 2);
    await writeFile(join(homeDir, ".codex", "auth.json"), realAuth, "utf8");
    expect(await ensureCodexGatewayPlaceholderAuth(homeDir)).toBe(false);
    expect(await readFile(join(homeDir, ".codex", "auth.json"), "utf8")).toBe(realAuth);
  });

  test("占位登录：keyring 凭据存储形态跳过预填", async () => {
    const homeDir = await tempHome();
    await writeFile(join(homeDir, ".codex", "config.toml"), "cli_auth_credentials_store = \"keyring\"\n", "utf8");
    expect(await ensureCodexGatewayPlaceholderAuth(homeDir)).toBe(false);
    await expect(readFile(join(homeDir, ".codex", "auth.json"), "utf8")).rejects.toThrow();
  });

  test("占位登录清理：仅删除自己的占位，真实凭据与缺失均不动", async () => {
    const homeDir = await tempHome();
    const authPath = join(homeDir, ".codex", "auth.json");
    // 缺失 → false。
    expect(await removeCodexPlaceholderAuth(homeDir)).toBe(false);
    // 自己的占位 → 删除。
    await writeFile(authPath, JSON.stringify({
      auth_mode: "apikey",
      OPENAI_API_KEY: GATEWAY_PLACEHOLDER_TOKEN,
    }, null, 2), "utf8");
    expect(await removeCodexPlaceholderAuth(homeDir)).toBe(true);
    await expect(readFile(authPath, "utf8")).rejects.toThrow();
    // 用户自有 apikey（值不同）→ 不动。
    await writeFile(authPath, JSON.stringify({auth_mode: "apikey", OPENAI_API_KEY: "1111"}), "utf8");
    expect(await removeCodexPlaceholderAuth(homeDir)).toBe(false);
    expect(JSON.parse(await readFile(authPath, "utf8")).OPENAI_API_KEY).toBe("1111");
  });
});
