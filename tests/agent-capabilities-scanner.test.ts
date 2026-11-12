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

  test("项目清单池驱动项目技能(own 目录优先于共享,2026-11-12 用户拉齐方案)", () => {
    const home = makeHome();
    // 项目 A:codex config.toml 清单 + 自身 .codex/skills + 共享 .agents/skills。
    const projA = join(home, "Documents", "Work", "projA");
    mkdirSync(join(projA, ".codex", "skills", "own-skill"), {recursive: true});
    writeFileSync(join(projA, ".codex", "skills", "own-skill", "SKILL.md"), "# own");
    mkdirSync(join(projA, ".agents", "skills", "shared-skill"), {recursive: true});
    writeFileSync(join(projA, ".agents", "skills", "shared-skill", "SKILL.md"), "# shared");
    // 同名优先级:own 与 shared 同名,own 内容胜出。
    mkdirSync(join(projA, ".agents", "skills", "own-skill"), {recursive: true});
    writeFileSync(join(projA, ".agents", "skills", "own-skill", "SKILL.md"), "# shared-version");
    mkdirSync(join(home, ".codex"), {recursive: true});
    writeFileSync(join(home, ".codex", "config.toml"), `[projects."${projA}"]\ntrust_level = "trusted"\n`);

    // 项目 B:claude 清单 + 自身 .claude/skills。
    const projB = join(home, "Documents", "UGit", "x", "projB");
    mkdirSync(join(projB, ".claude", "skills", "claude-only"), {recursive: true});
    writeFileSync(join(projB, ".claude", "skills", "claude-only", "SKILL.md"), "# claude");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({projects: {[projB]: {}}}));

    // 项目 C:dsh 会话目录名编码(路径含 '-' 段)。
    const projC = join(home, "Documents", "dsh-proj");
    mkdirSync(join(projC, ".agents", "skills", "dsh-shared"), {recursive: true});
    writeFileSync(join(projC, ".agents", "skills", "dsh-shared", "SKILL.md"), "# dsh");
    mkdirSync(join(home, ".dsh", "sessions"), {recursive: true});
    mkdirSync(join(home, ".dsh", "sessions", "--" + projC.split("/").join("-") + "--"), {recursive: true});

    const ledgers = scanLocalCapabilities({homeDir: home, noCache: true});
    const byId = new Map(ledgers.map(l => [l.agentId, l]));

    // codex:A 项目 own + shared 都在,own 同名胜出(path 为 .codex/skills)。
    const codexSkills = byId.get("codex")!.skills.filter(s => s.detail === "项目 · projA");
    const names = codexSkills.map(s => s.name).sort();
    assert.deepEqual(names, ["own-skill", "shared-skill"]);
    const own = codexSkills.find(s => s.name === "own-skill")!;
    assert.ok(own.sourcePath!.includes(join(".codex", "skills")), "own 目录优先");
    // zcode/dsh:只见共享,不见 codex 自身目录技能。
    const zcodeSkills = byId.get("zcode")!.skills.filter(s => s.detail === "项目 · projA");
    assert.deepEqual(zcodeSkills.map(s => s.name).sort(), ["own-skill", "shared-skill"], "共享目录对全部 Agent 可见(含同名共享版)");
    assert.ok(zcodeSkills.find(s => s.name === "own-skill")!.sourcePath!.includes(".agents"), "zcode 无 own 目录,取共享版");

    // claude:B 项目自身目录;codex 只见 B 的共享(无)→ 不出现。
    const claudeSkills = byId.get("claude")!.skills.filter(s => s.detail === "项目 · projB");
    assert.deepEqual(claudeSkills.map(s => s.name), ["claude-only"]);
    assert.equal(byId.get("codex")!.skills.filter(s => s.detail === "项目 · projB").length, 0, "无共享时其它 Agent 不出现");

    // dsh 目录名解码:C 项目共享技能全员可见。
    assert.ok(byId.get("dsh")!.skills.some(s => s.name === "dsh-shared" && s.detail === "项目 · dsh-proj"), "dsh 编码目录解码命中");
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
