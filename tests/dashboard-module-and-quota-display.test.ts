import {describe, expect, test} from "vitest";
import {
  DASHBOARD_MODULE_IDS,
  DEFAULT_DASHBOARD_MODULE_ORDER,
  moveDashboardModule,
  normalizeDashboardModuleOrder,
  type DashboardModuleId,
} from "../src/lib/dashboard-module-order.js";
import {
  formatPlanQuotaAmount,
  formatPlanQuotaHeadline,
  formatPlanQuotaUsedAmount,
  pickPrimaryPlanQuotaWindow,
  planQuotaPercent,
  planQuotaRemainingPercent,
  planQuotaRemainingValue,
  planQuotaWindowLabel,
  usageFallbackLabel,
} from "../src/lib/plan-quota-display.js";
import {
  isRateUnconfirmed,
  rateUnconfirmedCredentials,
  rateUnconfirmedNotes,
  rateWarningBadgeLabel,
  rateWarningTitle,
  resolveRateWarning,
} from "../src/lib/sync-engine/rate-warning.js";

describe("仪表盘模块顺序（localStorage 持久化）", () => {
  test("默认顺序覆盖全部可排序模块，时间选择器不在其中", () => {
    expect([...DEFAULT_DASHBOARD_MODULE_ORDER]).toEqual([...DASHBOARD_MODULE_IDS]);
    // 时间筛选条是页面固定首块，不能被排到其它模块之后。
    expect(DASHBOARD_MODULE_IDS as readonly string[]).not.toContain("filters");
  });

  test("归一化：丢弃未知项、去重、缺失项按默认顺序补齐", () => {
    expect(normalizeDashboardModuleOrder(["heatmap", "heatmap", "nope", "overview"]))
      .toEqual(["heatmap", "overview", "leaderboard", "analysis", "trend", "plans"]);
    // 旧用户本地只存了部分模块：新模块必须仍然出现，不能被静默吞掉。
    expect(normalizeDashboardModuleOrder(["trend"])).toEqual([
      "trend", "overview", "leaderboard", "analysis", "plans", "heatmap",
    ]);
  });

  test("归一化容错：非数组/非字符串/空值一律回退默认顺序", () => {
    expect(normalizeDashboardModuleOrder(null)).toEqual([...DEFAULT_DASHBOARD_MODULE_ORDER]);
    expect(normalizeDashboardModuleOrder(42)).toEqual([...DEFAULT_DASHBOARD_MODULE_ORDER]);
    expect(normalizeDashboardModuleOrder([1, {}, "analysis"])).toEqual([
      "analysis", "overview", "leaderboard", "trend", "plans", "heatmap",
    ]);
  });

  test("相邻交换：只与渲染中的相邻模块对调", () => {
    const order = [...DEFAULT_DASHBOARD_MODULE_ORDER];
    expect(moveDashboardModule(order, order, "leaderboard", -1)).toEqual([
      "leaderboard", "overview", "analysis", "trend", "plans", "heatmap",
    ]);
    expect(moveDashboardModule(order, order, "overview", 1)).toEqual([
      "leaderboard", "overview", "analysis", "trend", "plans", "heatmap",
    ]);
  });

  test("相邻交换：跳过未渲染的条件模块，并在边界处保持原样", () => {
    const order = [...DEFAULT_DASHBOARD_MODULE_ORDER];
    // 「套餐 / 订阅」无数据时不渲染：trend 的下移邻居应为 heatmap 而不是 plans。
    const rendered = order.filter(id => id !== "plans");
    expect(moveDashboardModule(order, rendered, "trend", 1)).toEqual([
      "overview", "leaderboard", "analysis", "heatmap", "plans", "trend",
    ]);
    // 首位上移 / 末位下移 / 不存在的 id：必须原样返回，绝不越界。
    expect(moveDashboardModule(order, rendered, "overview", -1)).toEqual(order);
    expect(moveDashboardModule(order, rendered, "heatmap", 1)).toEqual(order);
    expect(moveDashboardModule(order, rendered, "missing" as DashboardModuleId, 1)).toEqual(order);
  });
});

describe("套餐窗口展示口径（仪表盘卡片与供应商侧栏共用）", () => {
  test("窗口标签翻译覆盖适配器实际落库的短标签", () => {
    expect(planQuotaWindowLabel("5h")).toBe("5 小时");
    expect(planQuotaWindowLabel("weekly")).toBe("1 周");
    expect(planQuotaWindowLabel("monthly")).toBe("月");
    expect(planQuotaWindowLabel("rolling")).toBe("滚动窗口");
    // 未知标签原样透出，绝不吞掉适配器新增的窗口。
    expect(planQuotaWindowLabel("custom")).toBe("custom");
  });

  test("主窗口优先级：5 小时 → 滚动 → 周 → 月，无命中回退第一条", () => {
    const items = [
      {windowLabel: "monthly", used: 1, total: 10, unit: "credits", resetAt: null},
      {windowLabel: "weekly", used: 2, total: 10, unit: "credits", resetAt: null},
      {windowLabel: "5h", used: 3, total: 10, unit: "credits", resetAt: null},
    ];
    expect(pickPrimaryPlanQuotaWindow(items)?.windowLabel).toBe("5h");
    expect(pickPrimaryPlanQuotaWindow([items[0]!, items[1]!])?.windowLabel).toBe("weekly");
    expect(pickPrimaryPlanQuotaWindow([{windowLabel: "custom"}])?.windowLabel).toBe("custom");
    expect(pickPrimaryPlanQuotaWindow([])).toBeUndefined();
  });

  test("百分比：total 缺失/非正数时为 null（不伪装成 0%），有值则夹紧到 0-100", () => {
    expect(planQuotaPercent({windowLabel: "5h", used: 3, total: 5})).toBe(60);
    expect(planQuotaPercent({windowLabel: "5h", used: 3, total: 0})).toBeNull();
    expect(planQuotaPercent({windowLabel: "5h", used: 3, total: null})).toBeNull();
    expect(planQuotaPercent({windowLabel: "5h", used: null, total: 5})).toBeNull();
    expect(planQuotaPercent(undefined)).toBeNull();
    expect(planQuotaPercent({windowLabel: "5h", used: 99, total: 5})).toBe(100);
  });

  test("「没设置」兜底文案按通道区分（2026-09-18 用户确认）", () => {
    // 按量通道缺的是控制台账号；套餐/订阅通道缺的是套餐同步。
    expect(usageFallbackLabel("account")).toBe("账号未设置");
    expect(usageFallbackLabel("plan")).toBe("套餐（订阅）未设置");
    // 已设置但暂时没有快照时才是这两种。
    expect(usageFallbackLabel("pending")).toBe("用量待同步");
    expect(usageFallbackLabel("balance-unavailable")).toBe("余额控制台查看");
  });

  test("余量数值与余量占比：优先原始 remaining，缺失时 total-used 推导（2026-10-07 余量主口径）", () => {
    // 原始 remaining 优先（供应商返回值可能与 total-used 有舍入差异）。
    expect(planQuotaRemainingValue({windowLabel: "5h", used: 3, total: 5, remaining: 1.86, unit: "credits"})).toBe(1.86);
    expect(planQuotaRemainingValue({windowLabel: "5h", used: 3, total: 5, unit: "credits"})).toBe(2);
    // percent 快照（total=100）同样可推导：100-62=38。
    expect(planQuotaRemainingValue({windowLabel: "5h", used: 62, total: 100, unit: "percent"})).toBe(38);
    expect(planQuotaRemainingValue({windowLabel: "5h", used: 3, total: null, unit: "credits"})).toBeNull();
    expect(planQuotaRemainingValue({windowLabel: "5h", used: null, total: 5, unit: "credits"})).toBeNull();
    expect(planQuotaRemainingValue(undefined)).toBeNull();
    expect(planQuotaRemainingPercent({windowLabel: "5h", used: 3, total: 5, unit: "credits"})).toBe(40);
    expect(planQuotaRemainingPercent({windowLabel: "5h", used: 62, total: 100, unit: "percent"})).toBe(38);
    expect(planQuotaRemainingPercent({windowLabel: "5h", used: 3, total: 0, unit: "credits"})).toBeNull();
    // 已用超出 total（脏数据）时夹紧到 0，不出现负百分比。
    expect(planQuotaRemainingPercent({windowLabel: "5h", used: 99, total: 5, unit: "credits"})).toBe(0);
    expect(planQuotaRemainingPercent(undefined)).toBeNull();
  });

  test("余量文本与一行摘要：percent 单位不重复拼单位（2026-10-07 与 zcode 对齐）", () => {
    // used+total → 剩余优先展示（total-used 推导）。
    expect(formatPlanQuotaAmount({windowLabel: "5h", used: 3.14, total: 5, unit: "credits"})).toBe("剩余 1.86 / 5 credits");
    // 原始 remaining 直返、无 total。
    expect(formatPlanQuotaAmount({windowLabel: "5h", used: 3, total: null, remaining: 7, unit: "credits"})).toBe("剩余 7 credits");
    // percent 快照：剩余 38 / 100，不带单位后缀。
    expect(formatPlanQuotaAmount({windowLabel: "5h", used: 62, total: 100, unit: "percent"})).toBe("剩余 38 / 100");
    // 只有 used（无 total 无 remaining）→ 退化为已用。
    expect(formatPlanQuotaAmount({windowLabel: "5h", used: 3, total: null, unit: "credits"})).toBe("已用 3 credits");
    expect(formatPlanQuotaAmount({windowLabel: "5h"})).toBe("—");
    // 已用补充行。
    expect(formatPlanQuotaUsedAmount({windowLabel: "5h", used: 3.14, total: 5, unit: "credits"})).toBe("已用 3.14 credits");
    expect(formatPlanQuotaUsedAmount({windowLabel: "5h"})).toBe("—");
    // 一行摘要展示剩余百分比。
    expect(formatPlanQuotaHeadline({windowLabel: "5h", used: 62, total: 100, unit: "percent"})).toBe("5 小时 剩 38%");
    expect(formatPlanQuotaHeadline({windowLabel: "weekly", used: 3, total: 10, unit: "credits"})).toBe("1 周 剩 70%");
    // 无 total 无法算占比 → 退化为余量文本。
    expect(formatPlanQuotaHeadline({windowLabel: "weekly", used: 3, total: null, remaining: 7, unit: "credits"})).toBe("1 周 剩余 7 credits");
    expect(formatPlanQuotaHeadline(undefined)).toBeNull();
  });
});

describe("中转站倍率黄标判定（只提醒，不拆链）", () => {
  test("只有「匹配成功但倍率缺失」才是黄标", () => {
    expect(isRateUnconfirmed({credentialId: "c1", label: "k1", matched: true})).toBe(true);
    expect(isRateUnconfirmed({credentialId: "c1", label: "k1", matched: true, ratio: 0.5})).toBe(false);
    // 远端根本没找到密钥属于「同步失败」，是另一类提示，不能算倍率黄标。
    expect(isRateUnconfirmed({credentialId: "c1", label: "k1", matched: false})).toBe(false);
  });

  test("提示文案只让用户去站点确认倍率，不复述内部保证（2026-09-18 用户确认）", () => {
    const comparison = [
      {credentialId: "c1", label: "甲", matched: true},
      {credentialId: "c2", label: "乙", matched: true, ratio: 1},
      {credentialId: "c3", label: "丙", matched: false, reason: "未找到"},
    ];
    expect(rateUnconfirmedCredentials(comparison).map(item => item.label)).toEqual(["甲"]);
    expect(rateUnconfirmedCredentials(null)).toEqual([]);
    const notes = rateUnconfirmedNotes(comparison);
    expect(notes.length).toBe(1);
    expect(notes[0]).toBe("密钥「甲」远端未返回有效倍率，请在供应商站点确认实际倍率");
    // 「本系统不会因此改动密钥、模型或 Agent 关联」对用户没有价值，必须消失。
    expect(notes[0]).not.toContain("不会因此改动");
    expect(notes[0]).not.toContain("Agent 关联");
    // 破坏性级联文案同样不得回潮。
    expect(notes[0]).not.toContain("已收回");
  });

  test("两级严重度：同步正常=黄标，账号/同步没设置=黄红标（2026-09-18 用户确认）", () => {
    const unconfirmed = [{credentialId: "c1", label: "025", matched: true}];
    // ① 同步正常但远端没返回倍率 → normal
    const normal = resolveRateWarning({
      unconfirmed,
      hasConsoleAccount: true,
      accountStatus: "ok",
      usesGroupRates: true,
    });
    expect(normal.severity).toBe("normal");
    expect(normal.configurationGap).toBe(false);
    expect(rateWarningBadgeLabel(normal)).toBe("倍率待确认");
    expect(rateWarningTitle(normal, "某站")).toContain("请到供应商站点确认实际倍率");
    expect(rateWarningTitle(normal, "某站")).not.toContain("不会因此改动");

    // ② 有证据但账号同步没跑成功（failed / auth_required / idle…）→ severe
    for (const accountStatus of ["failed", "auth_required", "idle", "running", null]) {
      const severe = resolveRateWarning({
        unconfirmed,
        hasConsoleAccount: true,
        accountStatus,
        usesGroupRates: true,
      });
      expect(severe.severity, String(accountStatus)).toBe("severe");
      expect(severe.configurationGap).toBe(false);
      expect(rateWarningBadgeLabel(severe)).toBe("倍率未校验");
    }

    // ③ 连账号同步都没配置 + 按分组倍率计费的中转站目标 → severe，
    //    且文案必须直接说「账号未设置」（可执行），不是抽象的「倍率未校验」。
    const noAccount = resolveRateWarning({
      unconfirmedCount: 0,
      hasConsoleAccount: false,
      accountStatus: null,
      usesGroupRates: true,
      billingChannel: "pay_as_you_go",
      includeConfigurationGaps: true,
    });
    expect(noAccount.severity).toBe("severe");
    expect(noAccount.configurationGap).toBe(true);
    expect(noAccount.gap).toBe("account");
    expect(rateWarningBadgeLabel(noAccount)).toBe("账号未设置");
    expect(rateWarningTitle(noAccount, "1yuanapi")).toContain("尚未配置控制台账号同步");
    // 供应商列表开启 includeConfigurationGaps；密钥行关闭时不出这类提醒。
    expect(resolveRateWarning({
      unconfirmedCount: 0,
      hasConsoleAccount: false,
      accountStatus: null,
      usesGroupRates: true,
      billingChannel: "pay_as_you_go",
    }).severity).toBe("none");

    // ④ 官方预设（密钥就是单条 API Key，没有分组倍率概念）→ 不提醒
    const preset = resolveRateWarning({
      unconfirmedCount: 0,
      hasConsoleAccount: false,
      accountStatus: null,
      usesGroupRates: false,
    });
    expect(preset.severity).toBe("none");

    // ⑥ 停用目标不产生计费，一律不提醒（新建草稿默认停用，避免刷屏）
    expect(resolveRateWarning({
      unconfirmedCount: 3,
      hasConsoleAccount: true,
      accountStatus: "ok",
      usesGroupRates: true,
      enabled: false,
    }).severity).toBe("none");
    expect(resolveRateWarning({
      unconfirmedCount: 0,
      hasConsoleAccount: false,
      accountStatus: null,
      usesGroupRates: true,
      enabled: false,
    }).severity).toBe("none");

    // ⑧ 套餐 / 订阅：没保存套餐同步配置（且有可用套餐适配器）→ severe「套餐（订阅）未设置」
    for (const channel of ["plan", "subscription"] as const) {
      const missingPlan = resolveRateWarning({
        unconfirmedCount: 0,
        hasConsoleAccount: false,
        accountStatus: null,
        usesGroupRates: false,
        billingChannel: channel,
        hasPlanConfig: false,
        hasPlanAdapter: true,
        includeConfigurationGaps: true,
      });
      expect(missingPlan.severity, channel).toBe("severe");
      expect(missingPlan.gap, channel).toBe("plan");
      expect(rateWarningBadgeLabel(missingPlan), channel).toBe("套餐（订阅）未设置");
      expect(rateWarningTitle(missingPlan, "某站"), channel).toContain("尚未保存套餐同步配置");
    }
    // 没有可用套餐适配器（如 DeepSeek 官方按量）→ 不该催用户去配套餐同步
    expect(resolveRateWarning({
      unconfirmedCount: 0,
      hasConsoleAccount: false,
      accountStatus: null,
      usesGroupRates: false,
      billingChannel: "plan",
      hasPlanConfig: false,
      hasPlanAdapter: false,
      includeConfigurationGaps: true,
    }).severity).toBe("none");
    // 已保存套餐配置 → 不再是配置缺口
    expect(resolveRateWarning({
      unconfirmedCount: 0,
      hasConsoleAccount: false,
      accountStatus: null,
      usesGroupRates: false,
      billingChannel: "plan",
      hasPlanConfig: true,
      hasPlanAdapter: true,
      includeConfigurationGaps: true,
    }).severity).toBe("none");

    // ⑨ 有「远端没返回倍率」的证据 + 账号没配置 → 说根因（账号未设置），而不是倍率未校验
    const evidenceAndNoAccount = resolveRateWarning({
      unconfirmed: [{credentialId: "c1", label: "025", matched: true}],
      hasConsoleAccount: false,
      accountStatus: null,
      usesGroupRates: true,
      billingChannel: "pay_as_you_go",
      includeConfigurationGaps: true,
    });
    expect(evidenceAndNoAccount.gap).toBe("account");
    expect(evidenceAndNoAccount.count).toBe(1);
    expect(rateWarningBadgeLabel(evidenceAndNoAccount)).toBe("账号未设置");
    expect(rateWarningTitle(evidenceAndNoAccount, "1yuanapi")).toContain("1 条密钥的远端倍率也未确认");

    // 账号存在但同步没跑成功（failed / auth_required…）→ 保留「倍率未校验」
    const brokenSync = resolveRateWarning({
      unconfirmed: [{credentialId: "c1", label: "025", matched: true}],
      hasConsoleAccount: true,
      accountStatus: "failed",
      usesGroupRates: true,
      billingChannel: "pay_as_you_go",
      includeConfigurationGaps: true,
    });
    expect(brokenSync.configurationGap).toBe(false);
    expect(rateWarningBadgeLabel(brokenSync)).toBe("倍率未校验");

    // ⑦ 同步事实还没加载时必须保持沉默：否则首帧「账号未知」会被误判成
    //    「账号未配置」，每次打开页面都先闪一片黄红标（2026-09-18 用户反馈）。
    expect(resolveRateWarning({
      unconfirmedCount: 0,
      hasConsoleAccount: false,
      accountStatus: null,
      usesGroupRates: true,
      factsLoaded: false,
    }).severity).toBe("none");
    expect(resolveRateWarning({
      unconfirmed: [{credentialId: "c1", label: "025", matched: true}],
      hasConsoleAccount: false,
      accountStatus: null,
      usesGroupRates: true,
      factsLoaded: false,
    }).severity).toBe("none");

    // ⑤ 概览接口只透出计数时同样能判级
    const fromCounts = resolveRateWarning({
      unconfirmedCount: 2,
      unconfirmedLabels: ["a", "b"],
      hasConsoleAccount: true,
      accountStatus: "ok",
      usesGroupRates: true,
    });
    expect(fromCounts.severity).toBe("normal");
    expect(fromCounts.count).toBe(2);
    expect(rateWarningTitle(fromCounts, "某站")).toContain("a、b");
  });
});
