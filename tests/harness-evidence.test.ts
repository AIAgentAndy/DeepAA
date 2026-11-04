import { describe, expect, test } from "vitest";
import {
  classifyToolName,
  extractHarnessEvidence,
  partitionInputText,
} from "../src/lib/harness/evidence.js";
import {
  extractTaggedSections,
  parseSkillsForAgent,
  skillsParseStatusForAgent,
} from "../src/lib/harness/skills-parser.js";
import {
  collectCompositionChars,
  contextCompositionFor,
} from "../src/lib/harness/context-composition.js";
import { estimateTokens } from "../src/lib/harness/text-estimate.js";
import { normalizeExchange } from "../src/lib/harness/normalizer.js";
import type { RawCapturedExchange } from "../src/lib/harness/types.js";

/**
 * 以下 fixture 均取自真实抓包验证过的格式（docs/Harness能力建设一期.md §2）：
 * codex-tui 0.146.1 请求中的 <skills_instructions> / <plugins_instructions> /
 * AGENTS.md 注入条目 / <environment_context><cwd> / x-codex-turn-metadata.workspaces。
 */
const CODEX_SKILLS_SECTION = `<skills_instructions>
## Skills
A skill is a set of local instructions to follow that is stored in a \`SKILL.md\` file. Below is the list of skills that can be used.
### Skill roots
- \`r0\` = /Users/andy/.codex/skills
- \`r1\` = /Users/andy/.agents/skills
- \`r2\` = /Users/andy/.codex/skills/.system
- \`r3\` = /Users/andy/.codex/plugins/cache/openai-bundled
- \`r6\` = /Users/andy/Documents/UGit/AIAgentAndy/llm-inspector/.agents/skills
### Available skills
- imagegen: Generate or edit raster images when the task benefits from AI-created bitmap visuals (file: r2/imagegen/SKILL.md)
- openai-docs: Use when the user asks how to build with OpenAI products or APIs (file: r3/openai-docs/SKILL.md)
- tdd: Test-driven development workflow for code changes (file: r1/tdd/SKILL.md)
- frontend-lint: Project frontend lint rules and conventions (file: r6/frontend-lint/SKILL.md)
- openai-bundled:docs-helper: Fetch bundled OpenAI documentation pages (file: r3/docs-helper/SKILL.md)
- code-review: Review code with repo standards (file: r0/code-review/SKILL.md)
</skills_instructions>`;

const PROJECT_KEY = "/Users/andy/Documents/UGit/AIAgentAndy/llm-inspector";

const WORKSPACES_HEADER = JSON.stringify({
  installation_id: "da600964-a5e2-4e49-b86d-4c2135f68cad",
  session_id: "019fd9e8-1445-77e0-9e4e-da85acb99bf0",
  thread_id: "019fd9e8-1445-77e0-9e4e-da85acb99bf0",
  turn_id: "019fea23-6255-7241-9f61-62c316c6a2d7",
  request_kind: "turn",
  sandbox: "none",
  workspaces: {
    [PROJECT_KEY]: {
      associated_remote_urls: { origin: "https://github.com/AIAgentAndy/llm-inspector.git" },
      latest_git_commit_hash: "1e242c690e73cda4be005156f7656ceff35da747",
      has_changes: false,
    },
  },
  turn_started_at_unix_ms: 1786339615480,
});

const AGENTS_MD_ITEM = `# AGENTS.md instructions for ${PROJECT_KEY}\n\n<INSTRUCTIONS>\n这是 Andy 的项目级研发约束。\n</INSTRUCTIONS>`;

const ENV_CONTEXT_ITEM = `<environment_context>
  <cwd>${PROJECT_KEY}</cwd>
  <shell>zsh</shell>
  <current_date>2026-09-10</current_date>
</environment_context>`;

const PERMISSIONS_ITEM = `<permissions instructions>
Filesystem sandboxing defines which files can be read or written. \`sandbox_mode\` is \`danger-full-access\`.
</permissions instructions>`;

function makeExchange(options: {
  exchangeId: string;
  path?: string;
  headers?: Record<string, string>;
  request: unknown;
  response?: unknown;
}): RawCapturedExchange {
  const response = options.response ?? {
    id: "resp_1",
    object: "response",
    status: "completed",
    output: [],
    usage: { input_tokens: 400, output_tokens: 20 },
  };
  return {
    schemaVersion: 1,
    exchangeId: options.exchangeId,
    captureSessionId: "capture-harness-evidence",
    sequence: 1,
    capturedAt: "2026-09-11T10:00:00.000Z",
    completedAt: "2026-09-11T10:00:01.000Z",
    durationMs: 1000,
    routing: {
      targetId: "target",
      targetName: "Target",
      targetFormatHint: "openai",
      localUrl: `http://localhost:3211${options.path ?? "/codex/v1/responses"}`,
      upstreamUrl: "https://example.test/v1/responses",
      localPath: options.path ?? "/codex/v1/responses",
      upstreamPath: options.path ?? "/v1/responses",
      method: "POST",
      agent: "codex",
      wireApi: "responses",
    },
    request: {
      headers: options.headers ?? {},
      rawBody: JSON.stringify(options.request),
      parsedBody: options.request,
      bodySizeBytes: JSON.stringify(options.request).length,
      bodySha256: "0".repeat(64),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      rawBody: JSON.stringify(response),
      parsedBody: response,
      bodySizeBytes: JSON.stringify(response).length,
      bodySha256: "1".repeat(64),
      isStreaming: false,
    },
    bodyStorage: { policy: "inline" },
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: false,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}

describe("tool name classification", () => {
  test("classifies mcp__ prefixes in both claude and codex shapes", () => {
    expect(classifyToolName("mcp__github__search")).toEqual({ kind: "mcp", mcpServer: "github" });
    expect(classifyToolName("mcp__node_repl")).toEqual({ kind: "mcp", mcpServer: "node_repl" });
  });

  test("classifies plain tools and rejects mcp__-only degenerate names", () => {
    expect(classifyToolName("exec_command")).toEqual({ kind: "tool" });
    expect(classifyToolName("mcp__")).toEqual({ kind: "tool" });
  });
});

describe("codex skills parsing (real capture format)", () => {
  test("extracts roots, entries, and source levels", () => {
    const result = parseSkillsForAgent("codex", [CODEX_SKILLS_SECTION], PROJECT_KEY);
    const byName = new Map(result.skills.map(skill => [skill.name, skill]));
    expect(result.skills).toHaveLength(6);

    expect(byName.get("imagegen")).toMatchObject({ sourceLevel: "system", sourceRoot: "/Users/andy/.codex/skills/.system" });
    expect(byName.get("openai-docs")).toMatchObject({ sourceLevel: "plugin", pluginName: "openai-bundled" });
    expect(byName.get("frontend-lint")).toMatchObject({ sourceLevel: "project", sourceRoot: `${PROJECT_KEY}/.agents/skills` });
    expect(byName.get("docs-helper")).toMatchObject({ sourceLevel: "plugin", pluginName: "openai-bundled" });
    expect(byName.get("tdd")).toMatchObject({ sourceLevel: "user", sourceRoot: "/Users/andy/.agents/skills" });
    expect(byName.get("code-review")).toMatchObject({ sourceLevel: "user", sourceRoot: "/Users/andy/.codex/skills" });
    expect(result.sectionChars).toBeGreaterThan(0);
  });

  test("returns not_supported empty result for agents without a parser (no guessing)", () => {
    // opencode/dsh 仍无已验证样本，保持空集；claude/zcode 见下方 Skill 工具清单用例。
    const result = parseSkillsForAgent("opencode", [CODEX_SKILLS_SECTION], PROJECT_KEY);
    expect(result.skills).toEqual([]);
    expect(result.sectionChars).toBe(0);
    // I6：空集 ≠ 没技能——未支持 Agent 显式 not_supported。
    expect(result.status).toBe("not_supported");
    // codex 格式对 claude/zcode 解析器同样无效（标题不匹配）。
    expect(parseSkillsForAgent("claude-code", [CODEX_SKILLS_SECTION], PROJECT_KEY).skills).toEqual([]);
  });

  test("extractTaggedSections tolerates unclosed sections", () => {
    expect(extractTaggedSections("<skills_instructions>broken", "<skills_instructions>", "</skills_instructions>")).toEqual([]);
  });
});

/** 2026-09-11 真实库取证（zcode ex-25 $.system / claude 173 处）：Skill 工具清单段。 */
const ZCODE_SKILL_TOOL_SECTION = `<system-reminder>
The following skills are available for use with the Skill tool:

- browser-use:control-browser: Main-agent-only Browser Use. Use to open, navigate, inspect, test, click, type, fill, screenshot, or verify pages. (also loadable as control-browser) (file: /Users/andy/.zcode/cli/plugins/cache/zcode-plugins-official/browser-use/0.4.2/skills/control-browser/SKILL.md)
- computer-use:computer-use: Main-agent-only desktop control through accessibility-first semantic actions. (file: /Users/andy/.zcode/cli/plugins/cache/zcode-plugins-official/computer-use/0.5.14/skills/computer-use/SKILL.md)
- project-lint: Project-level lint conventions. (file: ${PROJECT_KEY}/.agents/skills/project-lint/SKILL.md)
- user-helper: Personal helper skill. (file: /Users/andy/.claude/skills/user-helper/SKILL.md)
</system-reminder>`;

const CLAUDE_ENV_BLOCK = `Here is useful information about the environment you are running in:
<env>
Working directory: ${PROJECT_KEY}
Is directory a git repo: Yes
Platform: darwin
OS Version: darwin 25.2.0 x64
</env>`;

describe("claude-code / zcode skill-tool section parsing (real capture format)", () => {
  test("extracts plugin/project/user entries from the Skill tool list", () => {
    const result = parseSkillsForAgent("zcode", [ZCODE_SKILL_TOOL_SECTION], PROJECT_KEY);
    const byName = new Map(result.skills.map(skill => [skill.name, skill]));
    expect(result.skills).toHaveLength(4);
    expect(byName.get("control-browser")).toMatchObject({
      sourceLevel: "plugin",
      pluginName: "browser-use",
      sourceRoot: "/Users/andy/.zcode/cli/plugins/cache/zcode-plugins-official/browser-use/0.4.2/skills/control-browser",
    });
    expect(byName.get("project-lint")).toMatchObject({
      sourceLevel: "project",
      sourceRoot: `${PROJECT_KEY}/.agents/skills/project-lint`,
    });
    expect(byName.get("user-helper")).toMatchObject({sourceLevel: "user"});
    expect(result.sectionChars).toBeGreaterThan(0);
  });

  test("claude-code uses the same parser", () => {
    const result = parseSkillsForAgent("claude-code", [ZCODE_SKILL_TOOL_SECTION], PROJECT_KEY);
    expect(result.skills.map(skill => skill.name)).toContain("control-browser");
  });

  test("dsh / opencode remain explicit empty state (no verified sample)", () => {
    expect(parseSkillsForAgent("dsh", [ZCODE_SKILL_TOOL_SECTION], PROJECT_KEY).skills).toEqual([]);
    expect(parseSkillsForAgent("opencode", [ZCODE_SKILL_TOOL_SECTION], PROJECT_KEY).skills).toEqual([]);
  });

  test("I6（2026-11-03）：无 system-reminder 包裹的裸清单块也能解析条目（claude skills=0 根因）", () => {
    // 本机 2026-11-03 真实取证：claude-code 网关请求存在以标题直接开头、无
    // </system-reminder> 闭标签的清单块（本机装有 5+ skills，库中 15 个请求含
    // 标题但 114 个快照 skills 全 0）。旧回退只取标题长度导致条目全丢。
    const bareSection = `The following skills are available for use with the Skill tool:

- faceless-explainer: Turn arbitrary text into a faceless explainer video.
- brainstorming: Structured brainstorming workflow.`;
    const result = parseSkillsForAgent("claude-code", [bareSection], PROJECT_KEY);
    expect(result.skills.map(skill => skill.name)).toEqual(["faceless-explainer", "brainstorming"]);
    expect(result.sectionChars).toBe(bareSection.length);
  });

  test("I6：codex 同一技能目录出现在两个输入块时去重（F5 反例）", () => {
    const single = parseSkillsForAgent("codex", [CODEX_SKILLS_SECTION], PROJECT_KEY);
    const result = parseSkillsForAgent("codex", [CODEX_SKILLS_SECTION, CODEX_SKILLS_SECTION], PROJECT_KEY);
    const names = result.skills.map(skill => skill.name);
    expect(new Set(names).size).toBe(names.length, `重复条目: ${names.join(",")}`);
    expect(result.skills.length).toBe(single.skills.length);
    // sectionChars 仍是两段注入的实际字符量（构成估算按注入计，不按去重计）。
    expect(result.sectionChars).toBe(single.sectionChars * 2);
  });

  test("I6：skillsParseStatusForAgent 能力表与查询/ UI 共享", () => {
    expect(skillsParseStatusForAgent("codex")).toBe("parsed");
    expect(skillsParseStatusForAgent("claude-code")).toBe("parsed");
    expect(skillsParseStatusForAgent("zcode")).toBe("parsed");
    expect(skillsParseStatusForAgent("dsh")).toBe("not_supported");
    expect(skillsParseStatusForAgent("opencode")).toBe("not_supported");
  });
});

describe("claude/zcode env block project extraction (real capture format)", () => {
  test("resolves projectKey from <env> Working directory", () => {
    expect(extractHarnessEvidence("zcode", {}, [CLAUDE_ENV_BLOCK]).projectKey).toBe(PROJECT_KEY);
    expect(extractHarnessEvidence("claude-code", {}, [CLAUDE_ENV_BLOCK]).projectKey).toBe(PROJECT_KEY);
  });

  test("env-context cwd keeps priority over env block; env block beats AGENTS.md path", () => {
    expect(extractHarnessEvidence("zcode", {}, [ENV_CONTEXT_ITEM, CLAUDE_ENV_BLOCK]).projectKey).toBe(PROJECT_KEY);
    expect(extractHarnessEvidence("zcode", {}, [CLAUDE_ENV_BLOCK, AGENTS_MD_ITEM]).projectKey).toBe(PROJECT_KEY);
  });

  test("partition counts skill-tool section as skills and env block as env", () => {
    const text = `${ZCODE_SKILL_TOOL_SECTION}\n${CLAUDE_ENV_BLOCK}`;
    const partition = partitionInputText(text, PROJECT_KEY);
    expect(partition.skillsChars).toBe(ZCODE_SKILL_TOOL_SECTION.length);
    const envSpan = CLAUDE_ENV_BLOCK.slice(
      CLAUDE_ENV_BLOCK.indexOf("<env>"),
      CLAUDE_ENV_BLOCK.indexOf("</env>") + "</env>".length,
    );
    expect(partition.envChars).toBe(envSpan.length);
    // env 开标签前的引导行与拼接换行按现有语义计入 conversation。
    expect(partition.conversationChars).toBe(text.length - partition.skillsChars - partition.envChars);
  });
});

describe("rules and project extraction", () => {
  test("classifies project-level AGENTS.md by projectKey and permissions spans", () => {
    const evidence = extractHarnessEvidence(
      "codex",
      {},
      [AGENTS_MD_ITEM, PERMISSIONS_ITEM, "普通用户消息文本"],
    );
    expect(evidence.rules).toHaveLength(2);
    expect(evidence.rules[0]).toMatchObject({ kind: "agents_md_project", path: PROJECT_KEY });
    expect(evidence.rules[1]).toMatchObject({ kind: "permissions" });
    expect(evidence.rulesChars).toBe(AGENTS_MD_ITEM.length + PERMISSIONS_ITEM.length);
  });

  test("falls back to global classification when path is outside projectKey", () => {
    // 存在更高优先级项目证据（cwd=PROJECT_KEY），另一条 AGENTS.md 注入路径不同 → 全局。
    const evidence = extractHarnessEvidence(
      "codex",
      {},
      [ENV_CONTEXT_ITEM, "# AGENTS.md instructions for /Users/andy/global-place\n<INSTRUCTIONS>x</INSTRUCTIONS>"],
    );
    expect(evidence.projectKey).toBe(PROJECT_KEY);
    expect(evidence.rules[0]?.kind).toBe("agents_md_global");
  });

  test("resolves projectKey from workspaces header with cwd preference", () => {
    const projectKey = extractHarnessEvidence("codex", { "x-codex-turn-metadata": WORKSPACES_HEADER }, [ENV_CONTEXT_ITEM]).projectKey;
    expect(projectKey).toBe(PROJECT_KEY);
  });

  test("falls back to env cwd then AGENTS.md path", () => {
    expect(extractHarnessEvidence("codex", {}, [ENV_CONTEXT_ITEM]).projectKey).toBe(PROJECT_KEY);
    expect(extractHarnessEvidence("codex", {}, [AGENTS_MD_ITEM]).projectKey).toBe(PROJECT_KEY);
    expect(extractHarnessEvidence("codex", {}, ["no evidence"]).projectKey).toBeUndefined();
  });
});

describe("input text partition", () => {
  test("splits skills / permissions / env / conversation spans", () => {
    const combined = `${CODEX_SKILLS_SECTION}\nmiddle user text\n${PERMISSIONS_ITEM}`;
    const partition = partitionInputText(combined, PROJECT_KEY);
    expect(partition.skillsChars).toBe(CODEX_SKILLS_SECTION.length);
    expect(partition.rulesChars).toBe(PERMISSIONS_ITEM.length);
    expect(partition.conversationChars).toBe("\nmiddle user text\n".length);
    expect(partition.envChars).toBe(0);
  });
});

describe("token estimation", () => {
  test("CJK counts one token per character and ASCII one per four", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("编码约束")).toBe(4);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("编码abc")).toBe(3); // 2 CJK + ceil(3/4) = 2 + 1
  });
});

describe("normalizer harness evidence integration", () => {
  test("extracts tools classification, pseudonames, skills, rules, and project from a codex exchange", () => {
    const exchange = makeExchange({
      exchangeId: "codex-harness-evidence",
      headers: { "x-codex-turn-metadata": WORKSPACES_HEADER },
      request: {
        model: "gpt-5",
        instructions: "You are Codex, an agent based on GPT-5.",
        input: [
          { type: "message", role: "developer", content: [{ type: "input_text", text: PERMISSIONS_ITEM }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: AGENTS_MD_ITEM }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: CODEX_SKILLS_SECTION }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: ENV_CONTEXT_ITEM }] },
          { type: "function_call_output", call_id: "call_1", output: "file contents" },
        ],
        tools: [
          { type: "function", name: "exec_command", description: "Run a shell command", parameters: { type: "object" } },
          { type: "tool_search", execution: "client", description: "Search available tools", parameters: { type: "object" } },
          { type: "function", name: "mcp__node_repl__run", description: "Run node", parameters: { type: "object" } },
        ],
      },
    });
    const normalized = normalizeExchange(exchange);

    const toolSearch = normalized.request.toolSchemas.find(schema => schema.name === "@tool_search");
    expect(toolSearch).toBeDefined();
    expect(toolSearch?.kind).toBe("tool");
    expect(toolSearch?.schemaChars).toBeGreaterThan(0);

    const mcpTool = normalized.request.toolSchemas.find(schema => schema.name === "mcp__node_repl__run");
    expect(mcpTool).toMatchObject({ kind: "mcp", mcpServer: "node_repl" });

    const evidence = normalized.harnessEvidence;
    expect(evidence.projectKey).toBe(PROJECT_KEY);
    expect(evidence.skills.map(skill => skill.name)).toContain("frontend-lint");
    expect(evidence.skills.map(skill => skill.name)).toContain("imagegen");
    expect(evidence.rules.map(rule => rule.kind)).toContain("agents_md_project");
    expect(evidence.rules.map(rule => rule.kind)).toContain("permissions");
  });

  test("context composition estimates and calibrates against real usage", () => {
    const exchange = makeExchange({
      exchangeId: "codex-composition",
      headers: { "x-codex-turn-metadata": WORKSPACES_HEADER },
      request: {
        model: "gpt-5",
        instructions: "You are Codex.",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: CODEX_SKILLS_SECTION }] },
          { type: "function_call_output", call_id: "call_1", output: "tool output text" },
        ],
        tools: [
          { type: "function", name: "exec_command", description: "Run shell", parameters: { type: "object" } },
          { type: "function", name: "mcp__node_repl__run", description: "Run node", parameters: { type: "object" } },
        ],
      },
    });
    const normalized = normalizeExchange(exchange);
    const composition = contextCompositionFor(normalized, normalized.harnessEvidence);

    expect(composition.chars.mcp).toBeGreaterThan(0);
    expect(composition.chars.toolsNonMcp).toBeGreaterThan(0);
    expect(composition.chars.skills).toBe(CODEX_SKILLS_SECTION.length);
    expect(composition.chars.toolResults).toBeGreaterThan(0);
    expect(composition.chars.system).toBeGreaterThan(0);

    // usage = input 400 + cache_read 0 → 校准后合计等于实际值。
    expect(composition.calibration?.actualInputTokens).toBe(400);
    const calibratedTotal = Object.values(composition.calibratedTokens ?? {}).reduce((sum, value) => sum + value, 0);
    expect(calibratedTotal).toBe(400);
  });

  test("composition skips calibration when usage is missing", () => {
    const exchange = makeExchange({
      exchangeId: "codex-no-usage",
      request: {
        model: "gpt-5",
        input: [{ type: "message", role: "user", content: "hello" }],
        tools: [],
      },
      response: { id: "resp_2", object: "response", status: "completed", output: [] },
    });
    const normalized = normalizeExchange(exchange);
    const composition = contextCompositionFor(normalized, normalized.harnessEvidence);
    expect(composition.calibratedTokens).toBeUndefined();
    expect(composition.calibration).toBeUndefined();
    expect(composition.chars.conversation).toBeGreaterThan(0);
  });

  test("collectCompositionChars keeps conversation and toolResults disjoint", () => {
    const exchange = makeExchange({
      exchangeId: "codex-disjoint",
      request: {
        model: "gpt-5",
        input: [
          { type: "message", role: "user", content: "普通消息" },
          { type: "function_call_output", call_id: "call_1", output: "output" },
        ],
        tools: [],
      },
    });
    const normalized = normalizeExchange(exchange);
    const { chars } = collectCompositionChars(normalized, normalized.harnessEvidence);
    expect(chars.conversation).toBe("普通消息".length);
    expect(chars.toolResults).toBe("output".length);
  });
});

describe("I7（2026-11-03）：上下文分解守恒与校准口径（F7）", () => {
  test("嵌套段互斥归属：skills 段嵌在 permissions 内不双计，四桶之和 == 文本长度", () => {
    // F7 反例原型：204 字符文本（permissions 段内嵌 skills 段）旧实现合计 368。
    const nested = `<permissions instructions>
<skills_instructions>
- alpha: do things
- beta: more things
</skills_instructions>
be careful out there
</permissions instructions>`;
    const partition = partitionInputText(nested);
    const total = partition.skillsChars + partition.rulesChars + partition.envChars + partition.conversationChars;
    expect(total).toBe(nested.length);
    // 嵌套段归先出现的外层（permissions），内层 skills 不再重复计入。
    expect(partition.rulesChars).toBe(nested.length);
    expect(partition.skillsChars).toBe(0);
    expect(partition.conversationChars).toBe(0);
  });

  test("非嵌套场景与旧口径等价（skills/env/permissions 各自独立）", () => {
    const independent = `chat line one
<skills_instructions>
- alpha: do things
</skills_instructions>
<env>
cwd: /tmp
</env>
chat line two`;
    const partition = partitionInputText(independent);
    const total = partition.skillsChars + partition.rulesChars + partition.envChars + partition.conversationChars;
    expect(total).toBe(independent.length);
    expect(partition.skillsChars).toBe("<skills_instructions>\n- alpha: do things\n</skills_instructions>".length);
    expect(partition.envChars).toBe("<env>\ncwd: /tmp\n</env>".length);
    // conversation = 两行聊天 + skills 段与 env 段之间的两个换行符。
    expect(partition.conversationChars).toBe("chat line one\n".length + "\n\n".length + "chat line two".length);
  });

  test("校准分母包含 cache creation（Anthropic 100+200+300 → 600）", async () => {
    const {contextCompositionFor} = await import("../src/lib/harness/context-composition.js");
    const {normalizeExchange} = await import("../src/lib/harness/index.js");
    const normalized = normalizeExchange(makeUsageExchange({
      input_tokens: 100,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 300,
      output_tokens: 10,
    }));
    const composition = contextCompositionFor(normalized, {skills: [], rules: [], projectKey: undefined});
    expect(composition.calibration?.actualInputTokens).toBe(600);
    expect(composition.calibratedTokens).toBeDefined();
  });
});

function makeUsageExchange(usage: Record<string, number>) {
  return {
    schemaVersion: 1,
    exchangeId: "usage-cal",
    captureSessionId: "c",
    sequence: 1,
    capturedAt: "2026-11-03T08:00:00.000Z",
    completedAt: "2026-11-03T08:00:01.000Z",
    durationMs: 1000,
    routing: {
      targetId: "t", targetName: "T", targetFormatHint: "anthropic",
      localUrl: "http://localhost:3211/v1/messages", upstreamUrl: "https://example.test/v1/messages",
      localPath: "/v1/messages", upstreamPath: "/v1/messages", method: "POST",
    },
    request: {
      headers: {"anthropic-version": "2023-06-01"},
      rawBody: JSON.stringify({model: "claude-sonnet", messages: [{role: "user", content: [{type: "text", text: "hi"}]}]}),
      parsedBody: {model: "claude-sonnet", messages: [{role: "user", content: [{type: "text", text: "hi"}]}]},
      bodySizeBytes: 100, bodySha256: "0".repeat(64),
    },
    response: {
      status: 200, statusText: "OK", headers: {},
      rawBody: JSON.stringify({type: "message", role: "assistant", content: [{type: "text", text: "ok"}], usage}),
      parsedBody: {type: "message", role: "assistant", content: [{type: "text", text: "ok"}], usage},
      bodySizeBytes: 100, bodySha256: "1".repeat(64), isStreaming: false,
    },
    bodyStorage: {policy: "inline"},
    captureDiagnostics: [],
    security: {containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true},
  } as never;
}
