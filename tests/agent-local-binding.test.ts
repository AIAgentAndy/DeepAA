/**
 * 双链路观测绑定推导单元测试（2026-10-06 修订）：归因目标 = 对应官方预设的合格
 * 候选目标（启用 + 计费通道一致 + 模型 scope 含该 Agent），默认目标在候选内优先、
 * 否则取创建时间最早——不再要求默认目标必须为官方预设。
 * 事故背景：zcode 默认目标切到火山套餐后，旧规则把直连导入整体静默关闭，且
 * 状态区因挂载条件绑定默认目标 presetId 而整块消失（零可见性）。
 */
import assert from "node:assert/strict";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, test} from "vitest";
import {resolveLocalImportBinding} from "@/lib/agent-local-source/binding";
import {localImportStatusCopyForAgent} from "@/lib/agent-local-source/presets";
import type {ProxyConfig, ProxyTarget} from "@/types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, {recursive: true, force: true})));
});

function zhipuTarget(overrides: Partial<ProxyTarget> = {}): ProxyTarget {
  return {
    id: "bigmodel.cn-api-coding-paas-v4",
    name: "bigmodel",
    presetId: "zhipu-coding-plan",
    billingChannel: "plan",
    vendorFamily: "zhipu",
    enabled: true,
    supportedModels: ["glm-5.3", "glm-5.3-flash"],
    supportedModelScopes: {"GLM-5.3": ["zcode"], "glm-5.3-flash": ["zcode"]},
    ...overrides,
  };
}

function volcesTarget(overrides: Partial<ProxyTarget> = {}): ProxyTarget {
  return {
    id: "cn-beijing.volces.com-api-plan-v3",
    name: "volces-agent-plan",
    presetId: "volcengine-plan",
    billingChannel: "plan",
    vendorFamily: "volcengine",
    enabled: true,
    supportedModels: ["glm-5.3"],
    supportedModelScopes: {"glm-5.3": ["zcode"]},
    ...overrides,
  };
}

async function withConfig(
  targets: ProxyTarget[],
  agentConnections: ProxyConfig["agentConnections"],
): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "deepaa-binding-"));
  tempDirs.push(dataDir);
  await mkdir(join(dataDir, "config"), {recursive: true});
  await writeFile(join(dataDir, "proxy-config.json"), JSON.stringify({
    version: 3,
    revision: 1,
    updatedAt: new Date().toISOString(),
    localProxyBaseUrl: "http://127.0.0.1:3211",
    agentConnections,
    targets,
  } satisfies ProxyConfig));
  return dataDir;
}

describe("本地导入绑定推导（2026-10-06：默认目标与官方预设解耦）", () => {
  test("默认目标 = 官方预设目标 → bound 归默认（旧语义回归保护）", async () => {
    const dataDir = await withConfig([zhipuTarget()], {zcode: {defaultTargetId: zhipuTarget().id}});
    const status = await resolveLocalImportBinding(dataDir, "zcode");
    assert.equal(status.state, "bound");
    if (status.state !== "bound") return;
    assert.equal(status.binding.targetId, "bigmodel.cn-api-coding-paas-v4");
    assert.equal(status.binding.viaDefaultTarget, true);
    // 模型面归一：scope 键大小写混合也要落成小写白名单。
    assert.deepEqual([...status.binding.allowedModels].sort(), ["glm-5.3", "glm-5.3-flash"]);
  });

  test("默认目标 = 第三方预设 + 唯一官方目标启用 → 仍 bound 并归因官方目标（本事故主用例）", async () => {
    const createdAt = new Date(Date.now() - 3_600_000).toISOString();
    const dataDir = await withConfig(
      [volcesTarget(), zhipuTarget({createdAt})],
      {zcode: {defaultTargetId: "cn-beijing.volces.com-api-plan-v3"}},
    );
    const status = await resolveLocalImportBinding(dataDir, "zcode");
    assert.equal(status.state, "bound");
    if (status.state !== "bound") return;
    assert.equal(status.binding.targetId, "bigmodel.cn-api-coding-paas-v4");
    assert.equal(status.binding.viaDefaultTarget, false);
    assert.equal(status.binding.targetName, "bigmodel");
    // 导入下界 = max(now-30d, 官方目标 createdAt)。
    assert.equal(status.binding.floorEpochMs, Date.parse(createdAt));
  });

  test("未接入任何默认目标（无 agentConnections 条目）+ 官方目标合格 → 仍 bound", async () => {
    const dataDir = await withConfig([zhipuTarget()], {});
    const status = await resolveLocalImportBinding(dataDir, "zcode");
    assert.equal(status.state, "bound");
    if (status.state === "bound") {
      assert.equal(status.binding.viaDefaultTarget, false);
    }
  });

  test("两个官方预设目标 + 默认在第三方 → bound 创建时间最早者；默认指向其一 → 归默认", async () => {
    const earlier = zhipuTarget({id: "zhipu-earlier", createdAt: "2026-08-01T00:00:00.000Z"});
    const later = zhipuTarget({id: "zhipu-later", createdAt: "2026-09-01T00:00:00.000Z"});
    // 默认在第三方：取最早创建。
    const thirdParty = await withConfig(
      [later, earlier, volcesTarget()],
      {zcode: {defaultTargetId: "cn-beijing.volces.com-api-plan-v3"}},
    );
    const toThird = await resolveLocalImportBinding(thirdParty, "zcode");
    assert.equal(toThird.state, "bound");
    if (toThird.state === "bound") {
      assert.equal(toThird.binding.targetId, "zhipu-earlier");
      assert.equal(toThird.binding.viaDefaultTarget, false);
    }
    // 默认指向较晚创建的官方目标：显式选择优先于创建时间。
    const explicit = await withConfig(
      [earlier, later],
      {zcode: {defaultTargetId: "zhipu-later"}},
    );
    const toLater = await resolveLocalImportBinding(explicit, "zcode");
    assert.equal(toLater.state, "bound");
    if (toLater.state === "bound") {
      assert.equal(toLater.binding.targetId, "zhipu-later");
      assert.equal(toLater.binding.viaDefaultTarget, true);
    }
  });

  test("默认目标为官方预设但已停用 → 不参与候选；无其它候选时 disabled 且 reason 说明停用", async () => {
    const dataDir = await withConfig(
      [zhipuTarget({enabled: false})],
      {zcode: {defaultTargetId: "bigmodel.cn-api-coding-paas-v4"}},
    );
    const status = await resolveLocalImportBinding(dataDir, "zcode");
    assert.equal(status.state, "disabled");
    if (status.state === "disabled") {
      assert.match(status.reason, /已停用/);
      assert.match(status.reason, /bigmodel\.cn-api-coding-paas-v4/);
    }
  });

  test("官方目标启用但无该 Agent 模型面 → disabled 且 reason 说明模型 scope 缺口", async () => {
    const dataDir = await withConfig(
      [zhipuTarget({supportedModelScopes: {"glm-5.3": ["claude"]}})],
      {zcode: {defaultTargetId: "bigmodel.cn-api-coding-paas-v4"}},
    );
    const status = await resolveLocalImportBinding(dataDir, "zcode");
    assert.equal(status.state, "disabled");
    if (status.state === "disabled") {
      assert.match(status.reason, /没有任何模型 scope 含 zcode/);
    }
  });

  test("无任何官方预设目标 → disabled 且 reason 明确缺预设目标", async () => {
    const dataDir = await withConfig([volcesTarget()], {zcode: {defaultTargetId: "cn-beijing.volces.com-api-plan-v3"}});
    const status = await resolveLocalImportBinding(dataDir, "zcode");
    assert.equal(status.state, "disabled");
    if (status.state === "disabled") {
      assert.match(status.reason, /未配置官方预设 zhipu-coding-plan/);
    }
  });

  test("候选排除计费通道与预设不符的目标（手工编辑防御）", async () => {
    const dataDir = await withConfig(
      [zhipuTarget({id: "zhipu-wrong-channel", billingChannel: "pay_as_you_go", createdAt: "2026-08-01T00:00:00.000Z"}), zhipuTarget({id: "zhipu-ok", createdAt: "2026-09-01T00:00:00.000Z"})],
      {zcode: {defaultTargetId: "cn-beijing.volces.com-api-plan-v3"}},
    );
    const status = await resolveLocalImportBinding(dataDir, "zcode");
    assert.equal(status.state, "bound");
    if (status.state === "bound") {
      assert.equal(status.binding.targetId, "zhipu-ok");
    }
  });
});

describe("官方直连观测文案按 Agent 分化（2026-10-09 用户确认）", () => {
  test("codex 文案口径为 OpenAI 登录协议限制，不得出现积分折扣/ZCode 表述", () => {
    const codex = localImportStatusCopyForAgent("codex");
    assert.ok(codex.direct.includes("OpenAI 登录协议限制"));
    assert.ok(!codex.direct.includes("积分"));
    assert.ok(!codex.direct.includes("ZCode"));
  });

  test("zcode 保留官方积分折扣口径（客户端签名认定）", () => {
    const zcode = localImportStatusCopyForAgent("zcode");
    assert.ok(zcode.direct.includes("官方积分折扣"));
    assert.ok(!zcode.direct.includes("协议限制"));
  });

  test("dsh 为仅身份标注口径；identityOnly 分支说明网关 raw 更完整", () => {
    const dsh = localImportStatusCopyForAgent("dsh");
    assert.ok(dsh.identityOnly.includes("仅身份标注"));
    assert.ok(dsh.identityOnly.includes("网关 raw 记录更完整"));
  });

  test("未登记 Agent 回退通用表述（防御，正常不触达）", () => {
    const fallback = localImportStatusCopyForAgent("opencode");
    assert.ok(fallback.direct.includes("经本网关的请求不受影响"));
    assert.ok(!fallback.direct.includes("ZCode"));
    assert.ok(!fallback.direct.includes("积分"));
  });
});
