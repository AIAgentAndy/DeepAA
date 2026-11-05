import assert from "node:assert/strict";
import {afterEach, describe, test} from "node:test";
import type {RawCapturedExchangeV2} from "../src/lib/harness/types.js";
import {createExchangeProcessor} from "../src/lib/ingestion/exchange-processor.js";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture.js";
import {loadAgentStepHarness} from "../src/lib/db/harness-queries.js";
import {lookupCapability} from "../src/lib/db/capability-lookup-queries.js";
import {loadStepCapabilitySummary} from "../src/lib/db/step-capability-queries.js";

const BASE_TIME = new Date(Date.now() - 3_600_000).toISOString();
// zcode 真实形态:system-reminder 包裹的 Skill 工具清单(实测 2026-09-11)。
const SKILLS_TEXT = `<system-reminder>
The following skills are available for use with the Skill tool:

- demo-skill: Demo skill (file: /Users/andy/.zcode/cli/plugins/cache/demo-plugin/1.0/skills/demo-skill/SKILL.md)
- plain-skill: Plain (file: /Users/andy/.claude/skills/plain-skill/SKILL.md)
</system-reminder>`;

/**
 * P2 节点 A/B/C（2026-11-05）：Skill 激活证据（v57）+ 反查定义演变 + 插件来源计数。
 * 覆盖：激活提取（zcode 实测形态 {"skill":...}）、带插件前缀激活匹配、目录≠激活、
 * kind=skill 反查走激活表、定义演变多快照提取、pluginSourceCount。
 */
describe("SQLite P2 节点 A/B/C：Skill 激活 + 定义演变 + 插件来源", () => {
  const fixtures: SqliteFixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  });

  function makeExchange(seq: number, opts: {tools: unknown[]; calls: Array<{name: string; input?: unknown}>}): RawCapturedExchangeV2 {
    const capturedAt = new Date(Date.parse(BASE_TIME) + seq * 60_000).toISOString();
    const requestBody = JSON.stringify({
      model: "m", instructions: "You are Codex.",
      input: [
        {type: "message", role: "user", content: [{type: "input_text", text: SKILLS_TEXT}]},
        {type: "message", role: "user", content: [{type: "input_text", text: `t ${seq}`}]},
      ],
      tools: opts.tools,
    });
    const responseBody = JSON.stringify({
      id: `r-${seq}`, object: "response", status: "completed", model: "m",
      output: opts.calls.map((c, i) => ({
        type: "function_call", call_id: `call-${seq}-${i}`, name: c.name,
        ...(c.input !== undefined ? {arguments: JSON.stringify(c.input)} : {arguments: "{}"}),
      })),
      usage: {input_tokens: 100, output_tokens: 4},
    });
    return {
      schemaVersion: 2, exchangeId: `capture-skill:ex-${seq}`, captureSessionId: "capture-skill", sequence: seq,
      capturedAt, completedAt: capturedAt, durationMs: 25,
      routing: {targetId: "t", targetName: "T", targetFormatHint: "openai",
        localUrl: "http://127.0.0.1:3211/zcode/v1/responses", upstreamUrl: "https://e.test/v1/responses",
        localPath: "/zcode/v1/responses", upstreamPath: "/v1/responses", method: "POST", agent: "zcode", wireApi: "responses"},
      request: {headers: {"user-agent": "ZCode/1.0.0", session_id: "sess-s", thread_id: "th-s",
        "x-codex-turn-metadata": JSON.stringify({session_id: "sess-s", thread_id: "th-s", turn_id: "tu-s", request_kind: "turn", workspaces: {}})},
        rawBody: requestBody, bodySizeBytes: 100, bodySha256: `r-${seq}`},
      response: {status: 200, statusText: "OK", headers: {}, rawBody: responseBody, bodySizeBytes: 100, bodySha256: `s-${seq}`, isStreaming: false},
      bodyStorage: {policy: "inline"}, captureDiagnostics: [],
      security: {containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true},
    };
  }

  async function processOne(fixture: SqliteFixture, exchange: RawCapturedExchangeV2, offset: number): Promise<string> {
    const sourceId = fixture.db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
       VALUES('captures/v2/skill.jsonl', 'f', 4096, ?)
       ON CONFLICT(relative_path) DO UPDATE SET updated_at = excluded.updated_at
       RETURNING id`,
    ).pluck().get(BASE_TIME) as number;
    const processor = createExchangeProcessor({db: fixture.db, dataDir: fixture.dataDir});
    const result = await processor.processExchangeRecord({
      sourceId, sourceRelativePath: "captures/v2/skill.jsonl",
      byteOffset: offset, lineLengthBytes: 100, exchange,
    });
    return fixture.db.prepare("SELECT id FROM agent_steps WHERE exchange_id = ?").pluck().get(result.exchangeId) as string;
  }

  test("节点A: 激活提取/目录≠激活/前缀匹配/summary/反查激活记录", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const tools = [{type: "function", name: "Bash", parameters: {type: "object"}}];

    // step1: 只声明(目录出现),不激活。
    const s1 = await processOne(fixture, makeExchange(1, {tools, calls: []}), 0);
    // step2: 激活 demo-skill(裸名) + 带插件前缀的 plain-skill。
    const s2 = await processOne(fixture, makeExchange(2, {tools, calls: [
      {name: "Skill", input: {skill: "demo-skill", args: "do it"}},
      {name: "Skill", input: {skill: "browser-use:plain-skill"}},
    ]}), 100);
    // step3: 非 Skill 工具不产生激活。
    await processOne(fixture, makeExchange(3, {tools, calls: [{name: "Bash"}]}), 200);

    const activations = fixture.db.prepare("SELECT skill_name FROM skill_activations ORDER BY skill_name").all();
    assert.deepEqual(activations.map((a: {skill_name: string}) => a.skill_name), ["browser-use:plain-skill", "demo-skill"]);

    const h1 = loadAgentStepHarness(fixture.db, s1);
    assert.ok(h1);
    assert.ok(h1.inventory.skills.length >= 2);
    assert.ok(h1.inventory.skills.every(skill => !skill.activatedThisStep), "仅目录出现不得标记激活");

    const h2 = loadAgentStepHarness(fixture.db, s2);
    assert.ok(h2);
    const demo = h2.inventory.skills.find(skill => skill.name === "demo-skill");
    const plain = h2.inventory.skills.find(skill => skill.name === "plain-skill");
    assert.equal(demo?.activatedThisStep, true, "裸名激活必须命中");
    assert.equal(plain?.activatedThisStep, true, "带插件前缀激活必须命中(endsWith)");

    const summary2 = loadStepCapabilitySummary(fixture.db, s2);
    assert.ok(summary2);
    assert.equal(summary2.activatedSkillCount, 2);
    assert.equal(summary2.pluginSourceCount, 1, "demo-skill 的 r0 root 指向 plugins/cache → plugin 推断 1 个");
    const summary1 = loadStepCapabilitySummary(fixture.db, s1);
    assert.equal(summary1?.activatedSkillCount, 0);

    // kind=skill 反查:激活记录(而非恒空的 tool_calls 匹配)。
    const lookup = lookupCapability(fixture.db, {agentName: "zcode", kind: "skill", name: "demo-skill"});
    assert.ok(lookup);
    assert.equal(lookup.calls.items.length, 1);
    assert.equal(lookup.calls.items[0]!.status, "skill-activation");
    assert.equal(lookup.calls.items[0]!.stepId, s2);
    // 前缀反查:plain-skill 命中 browser-use:plain-skill 激活。
    const prefixed = lookupCapability(fixture.db, {agentName: "zcode", kind: "skill", name: "plain-skill"});
    assert.equal(prefixed?.calls.items.length, 1);
  });

  test("节点B: 定义演变——同名工具跨快照的 schema 规模历史", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    // 名称级快照身份:同工具集仅描述变化不建新快照(F6 存储侧设计);定义演变
    // 的触发条件 = 工具集变化产生新快照,evolving-tool 在两个集合中形态不同。
    const small = [
      {type: "function", name: "evolving-tool", description: "x".repeat(100), parameters: {type: "object"}},
    ];
    const big = [
      {type: "function", name: "evolving-tool", description: "y".repeat(2_000), parameters: {type: "object"}},
      {type: "function", name: "extra-tool", description: "z", parameters: {type: "object"}},
    ];
    await processOne(fixture, makeExchange(1, {tools: small, calls: []}), 0);
    await processOne(fixture, makeExchange(2, {tools: big, calls: []}), 100);

    const lookup = lookupCapability(fixture.db, {agentName: "zcode", kind: "tool", name: "evolving-tool"});
    assert.ok(lookup);
    assert.ok(lookup.definitions, "定义演变必须返回");
    assert.equal(lookup.definitions!.length, 2, "两个快照两种形态");
    const sizes = lookup.definitions!.map(def => def.schemaTokensEst).sort((a, b) => a - b);
    assert.ok(sizes[1]! > sizes[0]! * 4, "大小形态可区分");
    // 按首见时间序。
    assert.ok(lookup.definitions![0]!.firstSeenAt <= lookup.definitions![1]!.firstSeenAt);
  });
});
