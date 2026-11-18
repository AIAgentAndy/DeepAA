import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, test} from "vitest";
import {scanLocalCapabilities} from "../src/lib/agent-capabilities/scanner.js";
import {performSkillSync} from "../src/lib/agent-capabilities/skill-sync-core.js";

/**
 * 跨 Agent skill 管理(2026-11-11 双 Agent 审计修复)回归:
 * 1. HIGH-1 路径契约:sourcePath 统一为 skill 目录,SKILL.md 由消费方派生;
 * 2. HIGH-2 大小预算按递归目录内容计(非目录 inode size);
 * 3. MEDIUM-1/2:合并方向由调用方显式传递;一致性以首个有效 hash 为基准不回溯;
 * 4. MEDIUM-3:skillName basename 白名单防路径遍历;
 * 5. 409 CONFIRM_REQUIRED 二次确认闸门。
 * 全程使用临时 home,绝不触碰真实 ~/.codex 等。
 */
describe("跨 Agent skill 同步与一致性", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, {recursive: true, force: true});
    }
  });

  function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), "deepaa-skillsync-"));
    homes.push(home);
    return home;
  }

  test("HIGH-1: sourcePath 是目录且跨 Agent 索引 hash 生效", () => {
    const home = makeHome();
    mkdirSync(join(home, ".codex", "skills", "shared"), {recursive: true});
    writeFileSync(join(home, ".codex", "skills", "shared", "SKILL.md"), "# same");
    mkdirSync(join(home, ".claude", "skills", "shared"), {recursive: true});
    writeFileSync(join(home, ".claude", "skills", "shared", "SKILL.md"), "# same");

    const ledgers = scanLocalCapabilities({homeDir: home, noCache: true}) as
      Awaited<ReturnType<typeof scanLocalCapabilities>> & {crossAgentIndex?: {skills: Array<{name: string; agents: Array<{agentId: string; path: string; contentHash: string; consistent: boolean}>; allConsistent: boolean}>}};
    const codexSkill = ledgers.find(l => l.agentId === "codex")?.skills.find(s => s.name === "shared");
    assert.ok(codexSkill, "codex 侧 shared 条目");
    // 契约:sourcePath 是 skill 目录(SKILL.md 由消费方 join 派生)。
    assert.equal(codexSkill.sourcePath, join(home, ".codex", "skills", "shared"));

    const entry = ledgers.crossAgentIndex?.skills.find(s => s.name === "shared");
    assert.ok(entry, "跨 Agent 索引条目");
    assert.equal(entry.allConsistent, true, "同内容必须一致");
    for (const a of entry.agents) {
      assert.notEqual(a.contentHash, "unknown", "hash 必须真实计算(从目录派生 SKILL.md)");
      assert.equal(a.consistent, true);
    }
  });

  test("MEDIUM-2: 一致性基准取首个有效 hash,不回溯改写", () => {
    const home = makeHome();
    // codex=v1 → claude=v2 → opencode=v1:基准=v1,codex/opencode 一致,claude 不同。
    // (zcode 只扫插件缓存不平铺 skills,故第三者用 opencode。)
    mkdirSync(join(home, ".codex", "skills", "s"), {recursive: true});
    writeFileSync(join(home, ".codex", "skills", "s", "SKILL.md"), "# v1");
    mkdirSync(join(home, ".claude", "skills", "s"), {recursive: true});
    writeFileSync(join(home, ".claude", "skills", "s", "SKILL.md"), "# v2");
    mkdirSync(join(home, ".config", "opencode", "skills", "s"), {recursive: true});
    writeFileSync(join(home, ".config", "opencode", "skills", "s", "SKILL.md"), "# v1");

    const ledgers = scanLocalCapabilities({homeDir: home, noCache: true}) as
      Awaited<ReturnType<typeof scanLocalCapabilities>> & {crossAgentIndex?: {skills: Array<{name: string; agents: Array<{agentId: string; contentHash: string; consistent: boolean}>; allConsistent: boolean}>; inconsistentNames: string[]}};
    const entry = ledgers.crossAgentIndex?.skills.find(s => s.name === "s");
    assert.ok(entry);
    const byAgent = new Map(entry.agents.map(a => [a.agentId, a]));
    assert.equal(byAgent.get("codex")?.consistent, true, "首个=基准,必须一致");
    assert.equal(byAgent.get("claude")?.consistent, false, "与基准不同");
    assert.equal(byAgent.get("opencode")?.consistent, true, "回到基准内容仍一致(不因 claude 出现在中间而回溯改写)");
    assert.equal(entry.allConsistent, false);
    assert.ok(ledgers.crossAgentIndex?.inconsistentNames.includes("s"));
  });

  test("索引收敛:同 Agent 插件多版本收敛单行,取最新版 hash(验收审计 HIGH-2)", () => {
    const home = makeHome();
    const mk = (ver: string, body: string) => {
      const dir = join(home, ".zcode", "cli", "plugins", "cache", "zcode-plugins-official", "browser-use", ver, "skills", "control-browser");
      mkdirSync(dir, {recursive: true});
      writeFileSync(join(dir, "SKILL.md"), body);
    };
    mk("0.4.0", "# old");
    mk("0.4.2", "# mid");
    mk("0.5.1", "# new");
    const ledgers = scanLocalCapabilities({homeDir: home, noCache: true}) as
      Awaited<ReturnType<typeof scanLocalCapabilities>> & {crossAgentIndex?: {skills: Array<{name: string; agents: Array<{agentId: string; contentHash: string; consistent: boolean; variants?: number}>; allConsistent: boolean; contentKnown: boolean}>; inconsistentNames: string[]}};
    const entry = ledgers.crossAgentIndex?.skills.find(s => s.name === "browser-use:control-browser");
    assert.ok(entry, "索引条目");
    assert.equal(entry.agents.length, 1, "同 Agent 收敛为单行");
    assert.equal(entry.agents[0]!.agentId, "zcode");
    assert.equal(entry.agents[0]!.variants, 3, "副本数如实记录");
    assert.equal(entry.agents[0]!.contentHash, createHash("md5").update("# new").digest("hex"), "取最新版 0.5.1 内容");
    assert.equal(entry.allConsistent, true, "单 Agent 不再产生假「不一致」");
    assert.equal(entry.contentKnown, true);
    assert.ok(!ledgers.crossAgentIndex!.inconsistentNames.includes("browser-use:control-browser"), "不污染不一致清单");
  });

  test("全部 hash unknown:contentKnown=false(不冒充「内容一致」)", () => {
    const home = makeHome();
    const big = "x".repeat(101 * 1024);
    for (const agent of [".codex", ".claude"]) {
      const dir = join(home, agent, "skills", "huge");
      mkdirSync(dir, {recursive: true});
      writeFileSync(join(dir, "SKILL.md"), big);
    }
    const ledgers = scanLocalCapabilities({homeDir: home, noCache: true}) as
      Awaited<ReturnType<typeof scanLocalCapabilities>> & {crossAgentIndex?: {skills: Array<{name: string; allConsistent: boolean; contentKnown: boolean}>}};
    const entry = ledgers.crossAgentIndex?.skills.find(s => s.name === "huge");
    assert.ok(entry);
    assert.equal(entry.contentKnown, false, "无可校验内容");
    assert.equal(entry.allConsistent, true, "一致性判断中立");
  });

  test("同步全链路:409 确认 → 覆盖成功 → 内容真实落盘", () => {
    const home = makeHome();
    const srcDir = join(home, ".codex", "skills", "demo");
    mkdirSync(srcDir, {recursive: true});
    writeFileSync(join(srcDir, "SKILL.md"), "# demo v2\nnew content");
    writeFileSync(join(srcDir, "extra.txt"), "asset");
    // 目标已存在旧内容。
    const targetSkillDir = join(home, ".claude", "skills", "demo");
    mkdirSync(targetSkillDir, {recursive: true});
    writeFileSync(join(targetSkillDir, "SKILL.md"), "# demo v1");

    const base = {home, skillName: "demo", sourceAgent: "codex", targetAgent: "claude", sourcePath: srcDir};
    // 1) 内容不同且未确认 → 409。
    const gate = performSkillSync({...base, confirm: false});
    assert.equal(gate.status, 409);
    assert.equal(gate.body.error, "CONFIRM_REQUIRED");
    assert.ok(gate.body.sourceHash !== gate.body.targetHash);
    // 2) 确认后覆盖成功,附属文件一并复制。
    const ok = performSkillSync({...base, confirm: true});
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(readFileSync(join(targetSkillDir, "SKILL.md"), "utf8"), "# demo v2\nnew content");
    assert.equal(readFileSync(join(targetSkillDir, "extra.txt"), "utf8"), "asset");
    // 3) 内容一致时无需确认直接幂等成功。
    const idem = performSkillSync({...base, confirm: false});
    assert.equal(idem.status, 200);
  });

  test("目标不存在:直接同步成功", () => {
    const home = makeHome();
    const srcDir = join(home, ".codex", "skills", "fresh");
    mkdirSync(srcDir, {recursive: true});
    writeFileSync(join(srcDir, "SKILL.md"), "# fresh");
    const out = performSkillSync({home, skillName: "fresh", sourceAgent: "codex", targetAgent: "opencode", sourcePath: srcDir});
    assert.equal(out.status, 200);
    assert.ok(existsSync(join(home, ".config", "opencode", "skills", "fresh", "SKILL.md")));
  });

  test("盲区目标诚实拒绝:zcode/dsh 不支持目录同步(带可读原因)", () => {
    const home = makeHome();
    const srcDir = join(home, ".codex", "skills", "s");
    mkdirSync(srcDir, {recursive: true});
    writeFileSync(join(srcDir, "SKILL.md"), "# s");
    for (const agent of ["zcode", "dsh"]) {
      const out = performSkillSync({home, skillName: "s", sourceAgent: "codex", targetAgent: agent, sourcePath: srcDir});
      assert.equal(out.status, 400, agent);
      assert.equal(out.body.error, "TARGET_NOT_SUPPORTED", agent);
      assert.ok(String(out.body.message).includes("不支持目录同步"), `${agent} 原因文案`);
      // 落盘必须不存在(同步目标目录连建都不建)。
      assert.ok(!existsSync(join(home, agent === "zcode" ? ".zcode" : ".dsh", "skills")), agent);
    }
  });

  test("插件冒号名落点剥前缀(目标 Agent 只识别裸目录名)", () => {
    const home = makeHome();
    // 源目录用裸名:真实场景里 zcode 插件缓存的 sourcePath 本就是裸名目录,冒号只在
    // 扫描条目名;且含 ':' 的目录名在 Windows/NTFS 上无法创建,跨平台 fixture 不虚构。
    const srcDir = join(home, ".codex", "skills", "browser-use");
    mkdirSync(srcDir, {recursive: true});
    writeFileSync(join(srcDir, "SKILL.md"), "# plugin skill");
    const out = performSkillSync({home, skillName: "browser-use:control-browser", sourceAgent: "codex", targetAgent: "claude", sourcePath: srcDir});
    assert.equal(out.status, 200);
    assert.ok(existsSync(join(home, ".claude", "skills", "control-browser", "SKILL.md")), "落在裸名目录");
    assert.ok(!existsSync(join(home, ".claude", "skills", "browser-use:control-browser")), "绝不落冒号目录");
  });

  test("源白名单:仅允许本机 Agent 配置根/.agents/项目工作区", () => {
    const home = makeHome();
    // home 外目录拒绝。
    const outside = mkdtempSync(join(tmpdir(), "deepaa-outside-"));
    try {
      mkdirSync(join(outside, "evil"), {recursive: true});
      writeFileSync(join(outside, "evil", "SKILL.md"), "# evil");
      const out1 = performSkillSync({home, skillName: "evil", sourceAgent: "codex", targetAgent: "claude", sourcePath: join(outside, "evil")});
      assert.equal(out1.status, 403);
      assert.equal(out1.body.error, "SOURCE_FORBIDDEN");
    } finally { rmSync(outside, {recursive: true, force: true}); }
    // home 内但不在任何白名单根下同样拒绝。
    mkdirSync(join(home, "loose"), {recursive: true});
    writeFileSync(join(home, "loose", "SKILL.md"), "# loose");
    const out2 = performSkillSync({home, skillName: "loose", sourceAgent: "codex", targetAgent: "claude", sourcePath: join(home, "loose")});
    assert.equal(out2.status, 403);
    assert.equal(out2.body.error, "SOURCE_FORBIDDEN");
  });

  test("MEDIUM-3: 路径遍历 skillName 拒绝", () => {
    const home = makeHome();
    const srcDir = join(home, ".codex", "skills", "x");
    mkdirSync(srcDir, {recursive: true});
    writeFileSync(join(srcDir, "SKILL.md"), "# x");
    for (const evil of ["x/../../evil", "../escape", "a/b", "..", "."]) {
      const out = performSkillSync({home, skillName: evil, sourceAgent: "codex", targetAgent: "claude", sourcePath: srcDir});
      assert.equal(out.status, 400, evil);
      assert.equal(out.body.error, "INVALID_SKILL_NAME", evil);
    }
    assert.ok(!existsSync(join(home, "evil")), "绝不允许逃出 skills 目录");
    // L-2:含 ".." 的合法名字(v1..v2)不再被子串误杀。
    mkdirSync(join(home, ".codex", "skills", "v1..v2"), {recursive: true});
    writeFileSync(join(home, ".codex", "skills", "v1..v2", "SKILL.md"), "# dots");
    const legal = performSkillSync({home, skillName: "v1..v2", sourceAgent: "codex", targetAgent: "claude", sourcePath: join(home, ".codex", "skills", "v1..v2")});
    assert.equal(legal.status, 200, "合法双点名必须放行");
    rmSync(join(home, ".claude", "skills", "v1..v2"), {recursive: true, force: true});
  });

  test("HIGH-2: 大小预算按递归内容计,目录 inode 小也拦截", () => {
    const home = makeHome();
    const srcDir = join(home, ".codex", "skills", "big");
    mkdirSync(join(srcDir, "assets"), {recursive: true});
    writeFileSync(join(srcDir, "SKILL.md"), "# big");
    // 6 MiB 载荷在子目录里:目录自身 inode size 远小于 4KiB,旧实现会漏过。
    writeFileSync(join(srcDir, "assets", "blob.bin"), Buffer.alloc(6 * 1024 * 1024, 1));
    const out = performSkillSync({home, skillName: "big", sourceAgent: "codex", targetAgent: "claude", sourcePath: srcDir});
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "SOURCE_TOO_LARGE");
    assert.ok(!existsSync(join(home, ".claude", "skills", "big")), "超预算不得落盘");
  });

  test("清单池项目根纳入同步白名单(extraRoots,项目技能跨 Agent 同步)", () => {
    const home = makeHome();
    const proj = join(home, "Documents", "Work", "projX");
    const srcDir = join(proj, ".codex", "skills", "proj-skill");
    mkdirSync(srcDir, {recursive: true});
    writeFileSync(join(srcDir, "SKILL.md"), "# proj");
    const base = {home, skillName: "proj-skill", sourceAgent: "codex", targetAgent: "claude", sourcePath: srcDir};
    // 无 extraRoots:白名单外 → 403。
    assert.equal(performSkillSync(base).body.error, "SOURCE_FORBIDDEN");
    // 带清单池项目根 → 放行并落盘。
    const ok = performSkillSync({...base, extraRoots: [proj]});
    assert.equal(ok.status, 200, String(ok.body.message));
    assert.ok(existsSync(join(home, ".claude", "skills", "proj-skill", "SKILL.md")));
  });

  test("源目录缺失/SKILL.md 缺失/不支持的目标", () => {
    const home = makeHome();
    // 白名单根内不存在 → SOURCE_NOT_FOUND(白名单外会先命中 SOURCE_FORBIDDEN,另有专测)。
    assert.equal(performSkillSync({home, skillName: "s", sourceAgent: "codex", targetAgent: "claude", sourcePath: join(home, ".codex", "skills", "nope")}).body.error, "SOURCE_NOT_FOUND");
    // 有目录无 SKILL.md:同步本身按目录复制,但一致性 hash 会是 unknown;此处校验目标不支持分支。
    assert.equal(performSkillSync({home, skillName: "s", sourceAgent: "codex", targetAgent: "unknown-agent", sourcePath: home}).body.error, "TARGET_NOT_SUPPORTED");
    assert.equal(performSkillSync({home, skillName: "", sourceAgent: "codex", targetAgent: "claude", sourcePath: home}).body.error, "MISSING_PARAMS");
  });
});
