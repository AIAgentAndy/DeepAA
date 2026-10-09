import {expect, test} from "vitest";
import {
  buildConfigFileManifest,
  sanitizeConfigContent,
  sensitiveConfigPreview,
} from "../src/lib/config-sync/file-preview.js";

test("文件 manifest 只包含路径和接管元数据，不携带正文", () => {
  const manifest = buildConfigFileManifest({
    agent: "zcode",
    fileIndex: 0,
    spec: {
      id: "zcode-config",
      kind: "json",
      managedNamespaces: ["provider.deepaa-gateway"],
      description: "ZCode 配置",
      skipSecretScan: true,
    },
    artifact: {
      specId: "zcode-config",
      path: "/tmp/.zcode/v2/config.json",
      kind: "json",
      active: true,
      content: '{"apiKey":"sk-do-not-return-123456789"}',
    },
    exists: true,
    bytes: 123,
  });
  expect(manifest.fileId).toBe("zcode:zcode-config:0");
  expect(manifest).not.toHaveProperty("content");
  expect(JSON.stringify(manifest)).not.toContain("sk-do-not-return");
});

test("服务端按结构脱敏 JSON/JSONC/TOML/YAML 中的真实凭据", () => {
  const marker = "sk-sensitive-preview-1234567890";
  const samples = [
    ["json", JSON.stringify({provider: {options: {apiKey: marker}}, model: "demo"})],
    ["jsonc", `{// 保留注释\n"provider":{"options":{"apiKey":"${marker}"}}}`],
    ["toml", `experimental_bearer_token = "${marker}"\nmodel = "demo"\n`],
    ["yaml", `refs:\n  USER_TOKEN: ${marker}\nmodel: demo\n`],
  ] as const;
  for (const [kind, content] of samples) {
    const sanitized = sanitizeConfigContent(kind, content);
    expect(sanitized).not.toContain(marker);
    expect(sanitized).toContain("sk-s**7890");
  }
});

test("本地配置预览默认只折叠敏感值中段，显式 reveal 时恢复完整内容", () => {
  const marker = "sk-sensitive-preview-1234567890";
  const content = JSON.stringify({provider: {options: {apiKey: marker}}});
  const masked = sanitizeConfigContent("json", content);
  expect(masked).toContain("sk-s**7890");
  expect(masked).not.toContain(marker);
  const revealed = sanitizeConfigContent("json", content, {revealSecrets: true});
  expect(revealed).toContain(marker);
});

test("结构化配置中的非标准字段也会按 token 形态局部隐藏", () => {
  const marker = "sk-unlabeled-preview-1234567890";
  const masked = sanitizeConfigContent("json", JSON.stringify({metadata: {value: marker}}));
  expect(masked).toContain("sk-u**7890");
  expect(masked).not.toContain(marker);
});

test("dsh 敏感凭据文件只返回合成的占位键摘要", () => {
  const preview = sensitiveConfigPreview({
    agent: "dsh",
    fileId: "dsh:dsh-credentials:1",
    specId: "dsh-credentials",
    path: "/tmp/.dsh/.credentials.yaml",
    kind: "yaml",
    active: true,
    sensitive: true,
    description: "dsh credentials",
    managedNamespaces: ["refs"],
    ownership: "sensitive",
    status: "sensitive",
    exists: true,
    bytes: 100,
    maxBytes: 1024,
  });
  expect(preview.content).toContain("DEEPAA_GATEWAY_TOKEN");
  expect(preview.content).toContain("<DeepAA 网关占位凭据>");
  expect(preview.content).not.toContain("USER_TOKEN");
});
