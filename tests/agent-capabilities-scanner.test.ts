import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, test} from "vitest";
import {scanLocalCapabilities} from "../src/lib/agent-capabilities/scanner.js";

/**
 * P1-5（2026-11-03）：本机能力台账扫描回归——五 Agent 只读有界扫描。
 * 隔离 mock home（绝不触碰真实 ~/.codex 等）；覆盖 skills/MCP/插件/profiles
 * 渠道、目录预算 limited 标记、missing 状态、60s 缓存与 noCache 穿透。
 */
describe("P1-5 本机能力台账扫描", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, {recursive: true, force: true});
    }
  });

  function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), "deepaa-caps-home-"));
    homes.push(home);
    return home;
  }

  test("codex/claude/zcode/dsh 各渠道条目与可观测字段", () => {
    const home = makeHome();
    // codex:2 个 skills + config.toml 2 个 mcp_servers。
    mkdirSync(join(home, ".codex", "skills", "alpha"), {recursive: true});
    writeFileSync(join(home, ".codex", "skills", "alpha", "SKILL.md"), "# alpha");
    mkdirSync(join(home, ".codex", "skills", "beta"), {recursive: true});
    writeFileSync(join(home, ".codex", "skills", "beta", "SKILL.md"), "# beta");
    mkdirSync(join(home, ".codex", "skills", "not-a-skill"), {recursive: true});
    writeFileSync(join(home, ".codex", "config.toml"), `
model = "gpt-5"
[mcp_servers.docs]
command = "echo"
[mcp_servers.node_repl]
command = "node"
[mcp_servers.node_repl.env]
API_KEY = "redacted-name-only"
`);
    // claude:1 skill + settings mcp + 插件清单。
    mkdirSync(join(home, ".claude", "skills", "gamma"), {recursive: true});
    writeFileSync(join(home, ".claude", "skills", "gamma", "SKILL.md"), "# gamma");
    mkdirSync(join(home, ".claude", "plugins"), {recursive: true});
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({mcpServers: {docs: {command: "x"}}}));
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {"superpowers@claude-plugins-official": [{scope: "user"}]},
    }));
    // zcode:插件市场 + 插件技能。
    mkdirSync(join(home, ".zcode", "cli", "plugins", "cache", "zcode-plugins-official", "browser-use", "skills", "control-browser"), {recursive: true});
    // dsh:profiles。
    mkdirSync(join(home, ".dsh", "profiles", "web"), {recursive: true});
    mkdirSync(join(home, ".dsh", "profiles", "node_modules"), {recursive: true});

    const ledgers = scanLocalCapabilities({homeDir: home, noCache: true});
    const byId = new Map(ledgers.map(ledger => [ledger.agentId, ledger]));

    const codex = byId.get("codex");
    assert.ok(codex);
    assert.equal(codex.availability.state, "available");
    // 无 SKILL.md 的目录不是技能。
    assert.deepEqual(codex.skills.map(skill => skill.name).sort(), ["alpha", "beta"]);
    assert.deepEqual(codex.mcpServers.map(server => server.name).sort(), ["docs", "node_repl"]);
    assert.ok(codex.scan.candidateCount >= 3);
    assert.ok(codex.scan.processedCount >= 2);
    assert.equal(codex.scan.limited, false);
    assert.ok(codex.scan.bytesRead > 0);

    const claude = byId.get("claude");
    assert.ok(claude);
    assert.deepEqual(claude.skills.map(skill => skill.name), ["gamma"]);
    assert.deepEqual(claude.mcpServers.map(server => server.name), ["docs"]);
    assert.deepEqual(claude.plugins.map(plugin => plugin.name), ["superpowers@claude-plugins-official"]);

    const zcode = byId.get("zcode");
    assert.ok(zcode);
    assert.deepEqual(zcode.plugins.map(plugin => plugin.name), ["zcode-plugins-official/browser-use"]);
    assert.deepEqual(zcode.skills.map(skill => skill.name), ["browser-use:control-browser"]);

    const dsh = byId.get("dsh");
    assert.ok(dsh);
    assert.deepEqual(dsh.plugins.map(profile => profile.name), ["web"], "node_modules 必须被过滤");

    // opencode:mock home 无配置 → missing 诚实呈现。
    const opencode = byId.get("opencode");
    assert.ok(opencode);
    assert.equal(opencode.availability.state, "missing");
    assert.equal(opencode.skills.length, 0);
  });

  test("60s 缓存命中与 noCache 穿透", () => {
    const home = makeHome();
    mkdirSync(join(home, ".codex", "skills", "cached-skill"), {recursive: true});
    writeFileSync(join(home, ".codex", "skills", "cached-skill", "SKILL.md"), "# c");

    const first = scanLocalCapabilities({homeDir: home});
    assert.equal(first.find(ledger => ledger.agentId === "codex")?.skills.length, 1);
    // 缓存窗口内新增文件不可见(60s TTL)。
    mkdirSync(join(home, ".codex", "skills", "new-skill"), {recursive: true});
    writeFileSync(join(home, ".codex", "skills", "new-skill", "SKILL.md"), "# n");
    const cached = scanLocalCapabilities({homeDir: home});
    assert.equal(cached.find(ledger => ledger.agentId === "codex")?.skills.length, 1, "TTL 内必须命中缓存");
    // noCache 穿透可见新文件。
    const fresh = scanLocalCapabilities({homeDir: home, noCache: true});
    assert.equal(fresh.find(ledger => ledger.agentId === "codex")?.skills.length, 2);
  });

  test("损坏配置不阻断扫描(空清单+available)", () => {
    const home = makeHome();
    mkdirSync(join(home, ".claude", "plugins"), {recursive: true});
    writeFileSync(join(home, ".claude", "settings.json"), "{broken json");
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "[not an object");
    const ledgers = scanLocalCapabilities({homeDir: home, noCache: true});
    const claude = ledgers.find(ledger => ledger.agentId === "claude");
    assert.ok(claude);
    assert.equal(claude.availability.state, "available");
    assert.deepEqual(claude.mcpServers, []);
    assert.deepEqual(claude.plugins, []);
  });
});
