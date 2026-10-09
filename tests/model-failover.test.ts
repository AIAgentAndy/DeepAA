import {describe, expect, test} from "vitest";
import {
  ANCHOR_RETRY_DELAY_MS,
  CodexWindowTracker,
  COMPACTION_SCAN_WINDOW_BYTES,
  codexWindowNumber,
  ANCHOR_RETRY_JITTER_MS,
  FAILOVER_ATTEMPT_HEADER_TIMEOUT_MS,
  FAILOVER_CHAIN_BUDGET_MS,
  MAX_MODEL_FALLBACKS,
  ModelFailoverRegistry,
  isFailoverStatusCode,
  isServedStatusCode,
  resolveFailoverPlan,
  type FailoverStateKey,
} from "../src/proxy/model-failover.js";
import {buildGatewayModelId} from "../src/proxy/gateway-prefix.js";
import type {GatewayRouteDecision} from "../src/proxy/gateway-router.js";
import type {RoutingSnapshot, RoutingTarget} from "../src/proxy/routing-config.js";

function routingTarget(id: string, models: string[], fallbacks: string[] = []): RoutingTarget {
  return {
    id,
    name: id,
    openaiUrl: `https://${id}`,
    billingChannel: "pay_as_you_go",
    enabled: true,
    supportedModels: models,
    modelAgentScopes: new Map(models.map(model => [model, ["codex"]])),
    modelWireApis: new Map(models.map(model => [model, ["responses"]])),
    modelFallbacks: new Map(models.length > 0 && fallbacks.length > 0 ? [[models[0]!, fallbacks]] : []),
    credentialsByAgent: new Map([["codex", "cred-1"]]),
  };
}

function decision(target: RoutingTarget, modelId: string): GatewayRouteDecision {
  return {
    target,
    modelId,
    requestedModel: buildGatewayModelId(target.id, modelId),
    agent: "codex",
    credentialMode: "inject",
    credentialId: "cred-1",
    upstreamPath: "/v1/responses",
    upstreamUrl: `https://${target.id}`,
    wireApi: "responses",
  };
}

function snapshotWith(targets: RoutingTarget[]): RoutingSnapshot {
  return {
    revision: 1,
    targetsById: new Map(targets.map(target => [target.id, target])),
  };
}

const key = (targetId = "t", modelId = "m"): FailoverStateKey => ({targetId, modelId, wireApi: "responses"});

describe("ModelFailoverRegistry（无跨请求计数，键含 wireApi）", () => {
  test("enterDegraded → 降级无粘性；lockSticky 设粘性；recover 全清", () => {
    const registry = new ModelFailoverRegistry();
    registry.enterDegraded(key(), 1_000);
    expect(registry.isDegraded(key())).toBe(true);
    expect(registry.stickyBackup(key())).toBeUndefined();
    registry.lockSticky(key(), {targetId: "b", modelId: "bm"}, 1_001);
    expect(registry.stickyBackup(key())).toEqual({targetId: "b", modelId: "bm"});
    registry.recover(key());
    expect(registry.isDegraded(key())).toBe(false);
  });

  test("wireApi 是状态键的一部分：同模型不同协议通道独立观测", () => {
    const registry = new ModelFailoverRegistry();
    registry.enterDegraded(key("t", "m"), 1_000);
    expect(registry.isDegraded({targetId: "t", modelId: "m", wireApi: "chat_completions"})).toBe(false);
    expect(registry.isDegraded({targetId: "t", modelId: "m", wireApi: "responses"})).toBe(true);
  });

  test("probeFailed 刷新兜底计时且保留粘性；clearSticky 降粘性但保持降级", () => {
    const registry = new ModelFailoverRegistry();
    registry.enterDegraded(key(), 0);
    registry.lockSticky(key(), {targetId: "b", modelId: "bm"}, 1);
    registry.probeFailed(key(), 2 * 60 * 60 * 1000 + 2);
    expect(registry.stickyBackup(key())).toEqual({targetId: "b", modelId: "bm"});
    expect(registry.shouldTimeProbe(key(), 2 * 60 * 60 * 1000 + 3)).toBe(false);
    registry.clearSticky(key());
    expect(registry.isDegraded(key())).toBe(true);
    expect(registry.stickyBackup(key())).toBeUndefined();
  });

  test("clearTarget 按目标精细清理；clearAll 全清", () => {
    const registry = new ModelFailoverRegistry();
    registry.enterDegraded(key("t1", "m"), 1_000);
    registry.enterDegraded(key("t2", "m"), 1_000);
    registry.clearTarget("t1");
    expect(registry.isDegraded(key("t1", "m"))).toBe(false);
    expect(registry.isDegraded(key("t2", "m"))).toBe(true);
    registry.clearAll();
    expect(registry.isDegraded(key("t2", "m"))).toBe(false);
  });
});

describe("状态码分类", () => {
  test("408/429/5xx 计入通道失败；400/401/402/403/404 与其余 4xx 排除", () => {
    expect(isFailoverStatusCode(408)).toBe(true);
    expect(isFailoverStatusCode(429)).toBe(true);
    expect(isFailoverStatusCode(500)).toBe(true);
    expect(isFailoverStatusCode(599)).toBe(true);
    expect(isFailoverStatusCode(400)).toBe(false);
    expect(isFailoverStatusCode(401)).toBe(false);
    expect(isFailoverStatusCode(404)).toBe(false);
    expect(isFailoverStatusCode(200)).toBe(false);
  });

  test("仅 2xx 视为成功服务（3xx/4xx 不是）", () => {
    expect(isServedStatusCode(200)).toBe(true);
    expect(isServedStatusCode(204)).toBe(true);
    expect(isServedStatusCode(301)).toBe(false);
    expect(isServedStatusCode(401)).toBe(false);
    expect(isServedStatusCode(502)).toBe(false);
  });
});

describe("resolveFailoverPlan", () => {
  const now = 10_000;
  const pathname = "/codex/v1/responses";
  const fallbacks = [
    buildGatewayModelId("backup-a.example", "bm-a"),
    buildGatewayModelId("backup-b.example", "bm-b"),
  ];
  const primaryTarget = routingTarget("primary.example", ["gpt-test"], fallbacks);
  const backupTargets = [routingTarget("backup-a.example", ["bm-a"]), routingTarget("backup-b.example", ["bm-b"])];
  const primary = decision(primaryTarget, "gpt-test");
  const snapshot = snapshotWith([primaryTarget, ...backupTargets]);

  test("无备份链返回 undefined", () => {
    const bareTarget = routingTarget("primary.example", ["gpt-test"]);
    expect(resolveFailoverPlan({snapshot: snapshotWith([bareTarget]), registry: new ModelFailoverRegistry(), decision: decision(bareTarget, "gpt-test"), pathname, compactionEvidence: false, now})).toBeUndefined();
  });

  test("健康态：锚点=主模型（带抖动重试），备份依次跟随", () => {
    const plan = resolveFailoverPlan({snapshot, registry: new ModelFailoverRegistry(), decision: primary, pathname, compactionEvidence: false, now});
    expect(plan?.mode).toBe("healthy");
    expect(plan?.attempts.map(item => `${item.decision.target.id}/${item.decision.modelId}`)).toEqual([
      "primary.example/gpt-test",
      "primary.example/gpt-test",
      "backup-a.example/bm-a",
      "backup-b.example/bm-b",
    ]);
    expect(plan?.attempts[0]?.retryAfterMs).toBeUndefined();
    const retryDelay = plan?.attempts[1]?.retryAfterMs;
    expect(retryDelay).toBeGreaterThanOrEqual(ANCHOR_RETRY_DELAY_MS - ANCHOR_RETRY_JITTER_MS);
    expect(retryDelay).toBeLessThanOrEqual(ANCHOR_RETRY_DELAY_MS + ANCHOR_RETRY_JITTER_MS);
    expect(plan?.trigger).toBeUndefined();
  });

  test("悬空备份候选被静默跳过；全部无效视为无故障转移", () => {
    const danglingTarget = routingTarget("primary.example", ["gpt-test"], [
      "ghost.example/none",
      buildGatewayModelId("absent.example", "also-none"),
    ]);
    const plan = resolveFailoverPlan({
      snapshot: snapshotWith([danglingTarget]),
      registry: new ModelFailoverRegistry(),
      decision: decision(danglingTarget, "gpt-test"),
      pathname, compactionEvidence: false, now,
    });
    expect(plan).toBeUndefined();
  });

  test("降级态：锚点=粘性备份（带重试），顺延其余备份；压缩证据触发主模型探测", () => {
    const registry = new ModelFailoverRegistry();
    registry.enterDegraded({targetId: "primary.example", modelId: "gpt-test", wireApi: "responses"}, now - 10);
    registry.lockSticky({targetId: "primary.example", modelId: "gpt-test", wireApi: "responses"}, {targetId: "backup-a.example", modelId: "bm-a"}, now - 9);

    const degraded = resolveFailoverPlan({snapshot, registry, decision: primary, pathname, compactionEvidence: false, now});
    expect(degraded?.mode).toBe("degraded");
    expect(degraded?.attempts.map(item => item.decision.target.id)).toEqual([
      "backup-a.example", "backup-a.example", "backup-b.example",
    ]);
    expect(degraded?.trigger).toBe("consecutive_failures");

    const probe = resolveFailoverPlan({snapshot, registry, decision: primary, pathname, compactionEvidence: true, now});
    expect(probe?.mode).toBe("probe");
    expect(probe?.attempts[0]?.decision.target.id).toBe("primary.example");
    expect(probe?.attempts[1]?.decision.target.id).toBe("primary.example");
    expect(probe?.attempts[2]?.decision.target.id).toBe("backup-a.example");
    expect(probe?.trigger).toBe("compaction");
  });

  test("降级无粘性：链首备份作为锚点（带重试）", () => {
    const registry = new ModelFailoverRegistry();
    registry.enterDegraded({targetId: "primary.example", modelId: "gpt-test", wireApi: "responses"}, now - 10);
    const plan = resolveFailoverPlan({snapshot, registry, decision: primary, pathname, compactionEvidence: false, now});
    expect(plan?.mode).toBe("degraded");
    expect(plan?.attempts.map(item => item.decision.target.id)).toEqual([
      "backup-a.example", "backup-a.example", "backup-b.example",
    ]);
  });

  test("全部有效备份进入候选链（≤ MAX_MODEL_FALLBACKS 防御截断）", () => {
    const manyFallbacks = Array.from({length: 8}, (_, index) => buildGatewayModelId(`b${index}.example`, "bm"));
    const manyTarget = routingTarget("primary.example", ["gpt-test"], manyFallbacks);
    const backupPool = Array.from({length: 8}, (_, index) => routingTarget(`b${index}.example`, ["bm"]));
    const plan = resolveFailoverPlan({
      snapshot: snapshotWith([manyTarget, ...backupPool]),
      registry: new ModelFailoverRegistry(),
      decision: decision(manyTarget, "gpt-test"),
      pathname, compactionEvidence: false, now,
    });
    expect(plan?.attempts).toHaveLength(2 + MAX_MODEL_FALLBACKS);
    expect(plan?.attempts[6]?.decision.target.id).toBe("b4.example");
  });

  test("常量为用户确认值", () => {
    expect(ANCHOR_RETRY_DELAY_MS).toBe(300);
    expect(ANCHOR_RETRY_JITTER_MS).toBe(50);
    expect(FAILOVER_ATTEMPT_HEADER_TIMEOUT_MS).toBe(30_000);
    expect(FAILOVER_CHAIN_BUDGET_MS).toBe(120_000);
    expect(MAX_MODEL_FALLBACKS).toBe(5);
  });
});

describe("恢复探测门控与候选冷却（2026-09-14 修订）", () => {
  const now = 1_000_000;
  const pathname = "/codex/v1/responses";

  test("压缩证据受最小探测间隔约束：首报允许，间隔内不重复，到期再允许", () => {
    const registry = new ModelFailoverRegistry();
    const k = key("t", "m");
    registry.enterDegraded(k, now - 100);
    // 无历史探测：压缩证据立即允许。
    expect(registry.shouldProbe(k, true, now)).toBe(true);
    registry.probeFailed(k, now);
    // 间隔内（<10min）：压缩证据不再触发。
    expect(registry.shouldProbe(k, true, now + 60_000)).toBe(false);
    // 到期：再次允许。
    expect(registry.shouldProbe(k, true, now + 10 * 60 * 1000 + 1)).toBe(true);
    // 无压缩证据且未到时间兜底：不探测。
    expect(registry.shouldProbe(k, false, now + 60_000)).toBe(false);
    // 时间兜底（2h）到点：无条件允许。
    registry.probeFailed(k, now + 10 * 60 * 1000 + 1);
    expect(registry.shouldProbe(k, false, now + 10 * 60 * 1000 + 1 + 2 * 60 * 60 * 1000)).toBe(true);
  });

  test("候选冷却：冷却期内候选被计划排除，clearTarget 按目标清理", () => {
    const registry = new ModelFailoverRegistry();
    registry.coolCandidate("b1.example", "bm1", now);
    expect(registry.isCandidateCooling("b1.example", "bm1", now + 1000)).toBe(true);
    expect(registry.isCandidateCooling("b1.example", "bm1", now + 10 * 60 * 1000 + 1)).toBe(false);

    const primaryTarget = routingTarget("primary.example", ["gpt-test"], [
      buildGatewayModelId("b1.example", "bm1"),
      buildGatewayModelId("b2.example", "bm2"),
    ]);
    const backups = [routingTarget("b1.example", ["bm1"]), routingTarget("b2.example", ["bm2"])];
    const snapshot = snapshotWith([primaryTarget, ...backups]);
    const plan = resolveFailoverPlan({
      snapshot, registry, decision: decision(primaryTarget, "gpt-test"),
      pathname, compactionEvidence: false, now: now + 1000,
    });
    // b1 冷却中被排除，链 = [主, 主(重试), b2]。
    expect(plan?.attempts.map(item => item.decision.target.id)).toEqual([
      "primary.example", "primary.example", "b2.example",
    ]);

    registry.clearTarget("b1.example");
    expect(registry.isCandidateCooling("b1.example", "bm1", now + 1000)).toBe(false);
  });

  test("passthrough/订阅目标不进入候选链（运行时纵深防御）", () => {
    const primaryTarget = routingTarget("primary.example", ["gpt-test"]);
    const passthroughTarget = {
      ...routingTarget("sub.example", ["bm-sub"]),
      billingChannel: "subscription",
    } as ReturnType<typeof routingTarget>;
    const snapshot = snapshotWith([primaryTarget, passthroughTarget]);
    const plan = resolveFailoverPlan({
      snapshot,
      registry: new ModelFailoverRegistry(),
      decision: decision(primaryTarget, "gpt-test"),
      pathname, compactionEvidence: false, now,
    });
    expect(plan).toBeUndefined();
  });
});

test("压缩扫描窗口常量为真实案例校准值（标记字节偏移 81,852 > 64KiB）", () => {
  expect(COMPACTION_SCAN_WINDOW_BYTES).toBe(2 * 1024 * 1024);
});

describe("CodexWindowTracker / codexWindowNumber（2026-09-15 首选压缩信号）", () => {
  test("首次见到只记基线；编号递增触发；不变/回退不触发", () => {
    const tracker = new CodexWindowTracker();
    expect(tracker.consume("s1", 0)).toBe(false);
    expect(tracker.consume("s1", 0)).toBe(false);
    expect(tracker.consume("s1", 1)).toBe(true);
    expect(tracker.consume("s1", 1)).toBe(false);
    // 编号回退（如 CLI 重装后重新计数）：不触发，无害。
    expect(tracker.consume("s1", 0)).toBe(false);
    // 不同 session 相互独立。
    expect(tracker.consume("s2", 3)).toBe(false);
    expect(tracker.consume("s2", 4)).toBe(true);
  });

  test("codexWindowNumber：合法头解析，缺失/非法/超长返回 undefined", () => {
    expect(codexWindowNumber({"x-codex-turn-metadata": '{"window_number":1,"other":"x"}'})).toBe(1);
    expect(codexWindowNumber({"x-codex-turn-metadata": '{"window_number":0}'})).toBe(0);
    expect(codexWindowNumber({})).toBeUndefined();
    expect(codexWindowNumber({"x-codex-turn-metadata": "not-json"})).toBeUndefined();
    expect(codexWindowNumber({"x-codex-turn-metadata": '{"window_number":"2"}'})).toBeUndefined();
    expect(codexWindowNumber({"x-codex-turn-metadata": "x".repeat(9000)})).toBeUndefined();
  });

  test("真实头样例（脱敏自 2026-09-14 捕获）可解析", () => {
    const header = JSON.stringify({
      installation_id: "da600964-a5e2-4e49-b86d-4c2135f68cad",
      session_id: "01a0a085-29da-7712-82e0-ca8ee0d7b19a",
      window_number: 1,
      context_window_id: "01a0a099-ac32-7be1-a180-43546717aab9",
    });
    expect(codexWindowNumber({"x-codex-turn-metadata": header})).toBe(1);
  });
});
