import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveClaudeConfiguration,
  resolveCodexConfiguration,
  resolveDshConfiguration,
  resolveOpenCodeConfiguration,
} from "../src/lib/development-launch/config-resolver.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function fixture(): Promise<{ root: string; homeDir: string; projectDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "development-config-"));
  tempRoots.push(root);
  const homeDir = join(root, "home");
  const projectDir = join(root, "project");
  await mkdir(homeDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  return { root, homeDir, projectDir };
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf-8");
}

function tomlProjectKey(path: string): string {
  // JSON.stringify 的转义规则与 TOML basic string 一致（反斜杠/引号都会转义）。
  // 不能再预先 replaceAll 转义：Windows 路径会被双重转义成 \\\\，导致键永远匹配不上。
  return JSON.stringify(path);
}

describe("Codex configuration resolution", () => {
  test("uses a trusted project model before the user model", async () => {
    const { homeDir, projectDir } = await fixture();
    await write(join(projectDir, ".codex", "config.toml"), [
      'model = "project-model"',
      'model_reasoning_effort = "high"',
      'model_provider = "ignored-project-provider"',
    ].join("\n"));
    await write(join(homeDir, ".codex", "config.toml"), [
      'model = "global-model"',
      'model_reasoning_effort = "medium"',
      `[projects.${tomlProjectKey(projectDir)}]`,
      'trust_level = "trusted"',
    ].join("\n"));

    const result = await resolveCodexConfiguration({ homeDir, projectDir });

    expect(result.projectTrust).toBe("trusted");
    expect(result.model).toMatchObject({ value: "project-model", source: "project" });
    // 2026-10-02：codex 能力类/旗标类字段（推理档/沙箱/上下文/压缩阈值）不再由
    // config.toml resolver 回显（弹窗回显已切目录能力值），resolver 只保留 model。
    expect(result.fields).not.toHaveProperty("modelReasoningEffort");
    expect(result.fields).not.toHaveProperty("modelProvider");
  });

  test("ignores an untrusted project model and falls back to the user model", async () => {
    const { homeDir, projectDir } = await fixture();
    await write(join(projectDir, ".codex", "config.toml"), 'model = "project-model"\n');
    await write(join(homeDir, ".codex", "config.toml"), [
      'model = "global-model"',
      `[projects.${tomlProjectKey(projectDir)}]`,
      'trust_level = "untrusted"',
    ].join("\n"));

    const result = await resolveCodexConfiguration({ homeDir, projectDir });

    expect(result.projectTrust).toBe("untrusted");
    expect(result.model).toMatchObject({ value: "global-model", source: "user" });
  });

  test("does not read a parent directory project config", async () => {
    const { root, homeDir, projectDir } = await fixture();
    await write(join(root, ".codex", "config.toml"), 'model = "parent-model"\n');
    await write(join(homeDir, ".codex", "config.toml"), 'model = "global-model"\n');

    const result = await resolveCodexConfiguration({ homeDir, projectDir });

    expect(result.model).toMatchObject({ value: "global-model", source: "user" });
    expect(result.modelOptions).not.toContain("parent-model");
  });

  test("uses an explicitly selected profile between project and user config", async () => {
    const { homeDir, projectDir } = await fixture();
    await write(join(homeDir, ".codex", "config.toml"), 'model = "global-model"\n');
    await write(join(homeDir, ".codex", "team.config.toml"), 'model = "profile-model"\n');

    const result = await resolveCodexConfiguration({ homeDir, projectDir, profile: "team" });

    expect(result.model).toMatchObject({ value: "profile-model", source: "profile" });
  });

  test("returns an unset model when no supported source defines one", async () => {
    const { homeDir, projectDir } = await fixture();

    const result = await resolveCodexConfiguration({ homeDir, projectDir });

    expect(result.model).toEqual({ source: "unset", overridable: true });
  });

  test("uses the full TOML parser and returns a stable warning for damaged config", async () => {
    const { homeDir, projectDir } = await fixture();
    await write(join(homeDir, ".codex", "config.toml"), [
      'model = "gateway#model"',
      'model_reasoning_effort = "high"',
      'features = ["one", "two"]',
      'metadata = { owner = "team" }',
    ].join("\n"));

    const parsed = await resolveCodexConfiguration({ homeDir, projectDir });
    expect(parsed.model.value).toBe("gateway#model");
    expect(parsed.warnings).toEqual([]);

    const secretMarker = "must-not-escape-from-parser";
    await write(join(homeDir, ".codex", "config.toml"), `model = [\"${secretMarker}\"\n`);
    const damaged = await resolveCodexConfiguration({ homeDir, projectDir });

    expect(damaged.warnings[0]).toMatchObject({
      code: "CONFIG_PARSE_FAILED",
      message: "Codex TOML 配置解析失败",
    });
    expect(damaged.warnings[0]?.message).not.toContain(secretMarker);
  });

  test("rejects a Codex config before reading when it exceeds one MiB", async () => {
    const { homeDir, projectDir } = await fixture();
    await write(join(homeDir, ".codex", "config.toml"), `model = \"${"x".repeat(1024 * 1024)}\"`);

    const result = await resolveCodexConfiguration({ homeDir, projectDir });

    expect(result.model.source).toBe("unset");
    expect(result.warnings[0]).toMatchObject({ code: "CONFIG_TOO_LARGE" });
  });

  test("未提供项目目录时只解析用户级 Codex 配置", async () => {
    const { homeDir } = await fixture();
    await write(join(homeDir, ".codex", "config.toml"), 'model = "user-model"\n');

    const result = await resolveCodexConfiguration({ homeDir });

    expect(result.model).toMatchObject({ value: "user-model", source: "user" });
    expect(result.projectTrust).toBe("not_configured");
    expect(result.warnings).toEqual([]);
  });
});

describe("OpenCode / dsh configuration resolution", () => {
  test("OpenCode 项目配置覆盖全局配置，JSONC 注释不影响解析", async () => {
    const { homeDir, projectDir } = await fixture();
    vi.stubEnv("OPENCODE_CONFIG", "");
    // 显式指向夹具目录：runner 预设的 XDG_CONFIG_HOME/APPDATA 与平台默认路径差异不再影响解析。
    vi.stubEnv("OPENCODE_CONFIG_DIR", join(homeDir, ".config", "opencode"));
    await write(join(homeDir, ".config", "opencode", "opencode.jsonc"), `{
  // 全局注释
  "model": "global-provider/global-model",
  "provider": {}
}`);
    await write(join(projectDir, ".opencode", "opencode.json"), JSON.stringify({
      model: "project-provider/project-model",
      small_model: "project-provider/project-model",
    }));

    const result = await resolveOpenCodeConfiguration({ homeDir, projectDir });

    expect(result.cli).toBe("opencode");
    expect(result.model).toMatchObject({ value: "project-provider/project-model", source: "project" });
    expect(result.modelOptions).toEqual([
      "global-provider/global-model",
      "project-provider/project-model",
    ]);
  });

  test("OpenCode 缺少配置时返回 unset，不把解析失败当模型", async () => {
    const { homeDir, projectDir } = await fixture();
    vi.stubEnv("OPENCODE_CONFIG", "");
    vi.stubEnv("OPENCODE_CONFIG_DIR", join(homeDir, ".config", "opencode"));
    const result = await resolveOpenCodeConfiguration({ homeDir, projectDir });
    expect(result.model).toEqual({ source: "unset", overridable: true });
    expect(result.warnings).toEqual([]);
  });

  test("dsh 从 settings.yaml 读取默认模型与静态模型列表", async () => {
    const { homeDir } = await fixture();
    vi.stubEnv("DSH_HOME", "");
    await write(join(homeDir, ".dsh", "settings.yaml"), [
      "llm-pi-ai:",
      "  providers:",
      "    deepaa-gateway:",
      "      baseURL: http://localhost:3211/dsh/v1",
      "      apiKeyEnv: DEEPAA_GATEWAY_TOKEN",
      "      models:",
      "        - id: deepseek-v4-flash_deepseek.example",
      "        - id: deepseek-reasoner_deepseek.example",
      "agent-default-model:",
      "  provider: deepaa-gateway",
      "  model: deepseek-v4-flash_deepseek.example",
    ].join("\n"));

    const result = await resolveDshConfiguration({ homeDir });

    expect(result.cli).toBe("dsh");
    expect(result.model).toMatchObject({ value: "deepseek-v4-flash_deepseek.example" });
    expect(result.modelOptions).toEqual([
      "deepseek-v4-flash_deepseek.example",
      "deepseek-reasoner_deepseek.example",
    ]);
  });

  test("dsh 缺少 settings.yaml 时返回 unset", async () => {
    const { homeDir } = await fixture();
    vi.stubEnv("DSH_HOME", "");
    const result = await resolveDshConfiguration({ homeDir });
    expect(result.model).toEqual({ source: "unset", overridable: true });
  });
});

describe("Claude Code configuration resolution", () => {
  test("uses project local before project and user settings", async () => {
    const { homeDir, projectDir } = await fixture();
    await write(join(homeDir, ".claude", "settings.json"), JSON.stringify({ model: "user-model" }));
    await write(join(projectDir, ".claude", "settings.json"), JSON.stringify({ model: "project-model" }));
    await write(join(projectDir, ".claude", "settings.local.json"), JSON.stringify({
      env: { ANTHROPIC_MODEL: "local-model" },
    }));

    const result = await resolveClaudeConfiguration({ homeDir, projectDir });

    expect(result.model).toMatchObject({ value: "local-model", source: "project_local" });
    expect(result.modelOptions).toEqual(["local-model", "project-model", "user-model"]);
  });

  test("does not read a user settings.local.json file", async () => {
    const { homeDir, projectDir } = await fixture();
    await write(join(homeDir, ".claude", "settings.local.json"), JSON.stringify({ model: "unsupported-model" }));
    await write(join(homeDir, ".claude", "settings.json"), JSON.stringify({ model: "user-model" }));

    const result = await resolveClaudeConfiguration({ homeDir, projectDir });

    expect(result.model).toMatchObject({ value: "user-model", source: "user" });
    expect(result.modelOptions).not.toContain("unsupported-model");
  });

  test("prefers ANTHROPIC_MODEL over model in the same settings file", async () => {
    const { homeDir, projectDir } = await fixture();
    await write(join(projectDir, ".claude", "settings.json"), JSON.stringify({
      model: "setting-model",
      env: { ANTHROPIC_MODEL: "environment-model" },
    }));

    const result = await resolveClaudeConfiguration({ homeDir, projectDir });

    expect(result.model).toMatchObject({ value: "environment-model", source: "project" });
  });

  test("returns an unset model without a hard-coded fallback", async () => {
    const { homeDir, projectDir } = await fixture();

    const result = await resolveClaudeConfiguration({ homeDir, projectDir });

    expect(result.model).toEqual({ source: "unset", overridable: true });
  });

  test("returns a stable warning for damaged Claude settings without leaking its contents", async () => {
    const { homeDir, projectDir } = await fixture();
    const secretMarker = "must-not-escape-from-json-parser";
    await write(
      join(projectDir, ".claude", "settings.local.json"),
      `{\"model\":\"${secretMarker}\"`,
    );
    await write(join(homeDir, ".claude", "settings.json"), JSON.stringify({ model: "user-model" }));

    const result = await resolveClaudeConfiguration({ homeDir, projectDir });

    expect(result.model.value).toBe("user-model");
    expect(result.warnings[0]).toMatchObject({
      code: "CONFIG_PARSE_FAILED",
      message: "Claude Code settings JSON 解析失败",
    });
    expect(result.warnings[0]?.message).not.toContain(secretMarker);
  });
});
