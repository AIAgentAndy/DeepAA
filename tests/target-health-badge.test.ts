import {describe, expect, test} from "vitest";
import {
  BADGE_PRIORITY,
  SYNC_FAILURE_DEFAULT_THRESHOLD,
  SYNC_FAILURE_THRESHOLDS,
  badgeInputFromOverview,
  badgeInputFromStatus,
  resolveTargetBadge,
  type TargetBadgeInput,
} from "../src/lib/sync-engine/target-health-badge.js";
import {resolveOfficialPresetForTarget} from "../src/lib/provider-preset-capabilities.js";
import {resolvePlanProviderForTarget} from "../src/lib/sync-engine/plan-provider.js";
import type {SyncOverviewTargetSummary} from "../src/lib/sync-engine/overview-types.js";
import type {ProxyTarget} from "../src/types.js";

/**
 * 供应商健康标识（2026-09-20 用户确认设计）：
 * - 连续两次自动同步失败（账号链或套餐链任一）→ 红「同步失败」；
 * - 单一标识互斥展示，优先级：账号未设置 > 套餐（订阅）未设置 > 同步失败 > 倍率未校验 > 倍率待确认；
 * - 停用目标与首帧（事实未返回）一律沉默；提醒只做展示，不影响同步自动执行。
 */

const relayTarget = {
  id: "t1",
  name: "某中转",
  openaiUrl: "https://gateway.example/v1",
  enabled: true,
  supportedModels: ["m1"],
} as unknown as ProxyTarget;

function input(overrides: Partial<TargetBadgeInput> = {}): TargetBadgeInput {
  return {
    unconfirmedCount: 0,
    unconfirmedLabels: [],
    hasConsoleAccount: true,
    accountStatus: "ok",
    usesGroupRates: true,
    billingChannel: "pay_as_you_go",
    hasPlanConfig: false,
    includeConfigurationGaps: true,
    enabled: true,
    factsLoaded: true,
    ...overrides,
  };
}

describe("target-health-badge：同步失败判定", () => {
  test("门槛按失败类别策略化：凭证/鉴权一次即亮，默认连续两次（2026-09-20 用户确认）", () => {
    expect(SYNC_FAILURE_THRESHOLDS.auth).toBe(1);
    expect(SYNC_FAILURE_THRESHOLDS.default).toBe(2);
    expect(SYNC_FAILURE_DEFAULT_THRESHOLD).toBe(2);
  });

  test("凭证/鉴权类（auth）失败一次即亮，title 说清根因与动作", () => {
    const badge = resolveTargetBadge(input({
      accountConsecutiveFailures: 1,
      accountFailureKind: "auth",
      accountLastError: "PLAN_AUTH_403",
    }), "某站");
    expect(badge).toMatchObject({kind: "sync_failure", severity: "severe", label: "同步失败"});
    expect(badge?.title).toContain("账号同步（余额/倍率）连续失败 1 次");
    expect(badge?.title).toContain("凭证/鉴权失败");
    expect(badge?.title).toContain("PLAN_AUTH_403");
    expect(badge?.title).toContain("自动消失");
  });

  test("套餐链凭证失败一次同样即亮（本次 opencode 403 场景）", () => {
    const badge = resolveTargetBadge(input({
      hasPlanConfig: true,
      planConsecutiveFailures: 1,
      planFailureKind: "auth",
      planLastError: "PLAN_AUTH_403",
    }));
    expect(badge).toMatchObject({kind: "sync_failure"});
    expect(badge?.title).toContain("套餐同步连续失败 1 次");
  });

  test("未知类别回退默认门槛（前向兼容：新库数据/旧读取端互不炸）", () => {
    // 未来可能新增 network 类别（门槛 3）；当前读取端未登记 → 按默认两次处理。
    expect(resolveTargetBadge(input({
      accountConsecutiveFailures: 1,
      accountFailureKind: "network",
    }))).toBeNull();
    expect(resolveTargetBadge(input({
      accountConsecutiveFailures: 2,
      accountFailureKind: "network",
    }))).toMatchObject({kind: "sync_failure"});
  });

  test("账号链连续两次自动失败 → 红「同步失败」，title 说明链路与错误", () => {
    const badge = resolveTargetBadge(input({
      accountConsecutiveFailures: 2,
      accountLastError: "spawn ENOENT",
    }), "某中转");
    expect(badge).toMatchObject({kind: "sync_failure", severity: "severe", label: "同步失败"});
    expect(badge?.title).toContain("账号同步（余额/倍率）连续失败 2 次");
    expect(badge?.title).toContain("spawn ENOENT");
    expect(badge?.title).toContain("自动消失");
  });

  test("套餐链连续两次自动失败同样命中（本次事故场景）", () => {
    const badge = resolveTargetBadge(input({
      hasPlanConfig: true,
      planConsecutiveFailures: 2,
      planLastError: "PLAN_HTTP_429",
    }));
    expect(badge).toMatchObject({kind: "sync_failure", label: "同步失败"});
    expect(badge?.title).toContain("套餐同步连续失败 2 次");
  });

  test("两条链同时挂时 title 列出两条链", () => {
    const badge = resolveTargetBadge(input({
      hasPlanConfig: true,
      accountConsecutiveFailures: 3,
      accountLastError: "E1",
      planConsecutiveFailures: 5,
      planLastError: "E2",
    }));
    expect(badge?.title).toContain("账号同步（余额/倍率）连续失败 3 次");
    expect(badge?.title).toContain("套餐同步连续失败 5 次");
  });

  test("单次失败不亮（连续两次门槛）", () => {
    expect(resolveTargetBadge(input({accountConsecutiveFailures: 1}))).toBeNull();
    expect(resolveTargetBadge(input({hasPlanConfig: true, planConsecutiveFailures: 1}))).toBeNull();
  });

  test("计数只在对应配置存在时参与判定（防御：无账号/无套餐配置的计数不亮标）", () => {
    expect(resolveTargetBadge(input({
      hasConsoleAccount: false,
      accountConsecutiveFailures: 2,
    }))).not.toMatchObject({kind: "sync_failure"});
    expect(resolveTargetBadge(input({
      hasPlanConfig: false,
      planConsecutiveFailures: 2,
    }))).not.toMatchObject({kind: "sync_failure"});
  });

  test("停用目标与首帧保持沉默", () => {
    expect(resolveTargetBadge(input({accountConsecutiveFailures: 9, enabled: false}))).toBeNull();
    expect(resolveTargetBadge(input({accountConsecutiveFailures: 9, factsLoaded: false}))).toBeNull();
  });
});

describe("target-health-badge：唯一标识优先级", () => {
  test("优先级表声明：配置缺口 > 同步失败 > 倍率类", () => {
    expect(BADGE_PRIORITY).toEqual([
      "account_gap",
      "plan_gap",
      "sync_failure",
      "rate_unverified",
      "rate_unconfirmed",
    ]);
  });

  test("账号未设置 > 同步失败", () => {
    // 按量 + 分组倍率目标无账号，同时计数已达门槛（异常防御场景）：只显示「账号未设置」。
    const badge = resolveTargetBadge(input({
      hasConsoleAccount: false,
      accountConsecutiveFailures: 2,
    }));
    expect(badge).toMatchObject({kind: "account_gap", label: "账号未设置"});
  });

  test("套餐（订阅）未设置 > 同步失败", () => {
    const badge = resolveTargetBadge(input({
      billingChannel: "plan",
      hasPlanAdapter: true,
      hasPlanConfig: false,
      hasConsoleAccount: true,
      accountStatus: "ok",
      planConsecutiveFailures: 2,
    }));
    expect(badge).toMatchObject({kind: "plan_gap", label: "套餐（订阅）未设置"});
  });

  test("同步失败 > 倍率未校验（同步坏掉是根因，倍率只是表征）", () => {
    const badge = resolveTargetBadge(input({
      unconfirmedCount: 2,
      accountStatus: "failed",
      accountConsecutiveFailures: 2,
      accountLastError: "X",
    }));
    expect(badge).toMatchObject({kind: "sync_failure"});
  });

  test("同步未到失败门槛但有倍率证据 + 同步不健康 → 倍率未校验", () => {
    const badge = resolveTargetBadge(input({
      unconfirmedCount: 2,
      accountStatus: "failed",
      accountConsecutiveFailures: 1,
    }));
    expect(badge).toMatchObject({kind: "rate_unverified", severity: "severe", label: "倍率未校验"});
  });

  test("同步健康 + 倍率证据 → 黄「倍率待确认」", () => {
    const badge = resolveTargetBadge(input({unconfirmedCount: 1}));
    expect(badge).toMatchObject({kind: "rate_unconfirmed", severity: "normal", label: "倍率待确认"});
  });

  test("健康目标无标识", () => {
    expect(resolveTargetBadge(input())).toBeNull();
  });
});

describe("target-health-badge：列表输入适配器（两侧共用一份）", () => {
  test("overview 适配器：未返回时首帧沉默，返回后字段齐全", () => {
    const pending = badgeInputFromOverview(relayTarget, undefined);
    expect(pending.factsLoaded).toBe(false);
    expect(resolveTargetBadge(pending, "某中转")).toBeNull();

    const overview = {
      targetId: "t1",
      hasConsoleAccount: true,
      accountStatus: "auth_required",
      accountLastSyncAt: null,
      accountConsecutiveFailures: 1,
      accountLastError: "PLAN_AUTH_403",
      accountFailureKind: "auth",
      balance: null,
      plan: null,
      hasPlanConfig: false,
      planLastSyncAt: null,
      planConsecutiveFailures: 0,
      planLastError: null,
      planFailureKind: null,
      rateUnconfirmedCount: 0,
      rateUnconfirmedLabels: [],
    } satisfies SyncOverviewTargetSummary;
    // 凭证/鉴权类一次即亮：概览投影 → 适配器 → 判定的完整链路。
    const badge = resolveTargetBadge(badgeInputFromOverview(relayTarget, overview), "某中转");
    expect(badge).toMatchObject({kind: "sync_failure", label: "同步失败"});
  });

  test("status 适配器：仪表盘路径与侧栏路径判定一致（含失败类别）", () => {
    const status = {
      account: {status: "auth_required", lastSyncError: "PLAN_AUTH_403", consecutiveAutoFailures: 1, consecutiveFailureKind: "auth"},
      credentialComparison: null,
      plan: {config: null},
    };
    const badge = resolveTargetBadge(badgeInputFromStatus(relayTarget, status), "某中转");
    expect(badge).toMatchObject({kind: "sync_failure", label: "同步失败"});

    expect(badgeInputFromStatus(relayTarget, undefined).factsLoaded).toBe(false);
  });

  test("适配器派生字段与列表旧口径一致（官方预设 = 无分组倍率；套餐适配器存在性）", () => {
    const derived = badgeInputFromOverview(relayTarget, undefined);
    expect(derived.usesGroupRates).toBe(!resolveOfficialPresetForTarget(relayTarget));
    expect(derived.hasPlanAdapter).toBe(Boolean(resolvePlanProviderForTarget(relayTarget)));
    expect(derived.includeConfigurationGaps).toBe(true);
    expect(derived.enabled).toBe(true);
  });
});
