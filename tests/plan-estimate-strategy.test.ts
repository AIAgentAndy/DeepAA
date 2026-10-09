import {describe, expect, test} from "vitest";
import {
  buildQuotaDeltaDetail,
  canPairQuotaSnapshots,
  computeQuotaDeltaAllocation,
  type BackfillCandidate,
  type PairedQuotaSnapshot,
} from "../src/lib/plan-estimate/strategy.js";

function snapshot(used: number, capturedAt: string, total = 100): PairedQuotaSnapshot {
  return {windowLabel: "weekly", used, total, resetAt: "2026-10-06T00:00:00.000Z", capturedAt};
}

function candidate(exchangeId: string, capturedAt: string, referenceCostNano: number): BackfillCandidate {
  return {exchangeId, capturedAt, referenceCostNano};
}

const PERIOD_FROM = "2026-09-28T08:00:00.000Z";
const PERIOD_TO = "2026-09-28T20:00:00.000Z";

describe("额度差分估算策略（纯函数）", () => {
  test("正差分：周期价值 = 月费 × 窗口/30 × Δ比例，按市价份额分摊", () => {
    const result = computeQuotaDeltaAllocation({
      monthlyFee: 1400,
      feeCurrency: "CNY",
      fxUsdCny: 7,
      windowDays: 7,
      earlier: snapshot(40, PERIOD_FROM),
      later: snapshot(55, PERIOD_TO),
      candidates: [
        candidate("ex-a", "2026-09-28T09:00:00.000Z", 2_000_000_000),
        candidate("ex-b", "2026-09-28T10:00:00.000Z", 8_000_000_000),
      ],
      maxRows: 100,
    });
    expect(result.status).toBe("estimated");
    if (result.status !== "estimated") return;
    // 1400 × 7/30 × 15/100 = 49 CNY → 49e9 nano；份额 2:8 → 9.8e9 / 39.2e9。
    expect(result.periodValueNano).toBe(49_000_000_000);
    expect(result.deltaUsed).toBe(15);
    expect(result.rows.map(row => row.nano)).toEqual([9_800_000_000, 39_200_000_000]);
    expect(result.rows[0]!.share).toBeCloseTo(0.2, 9);
    expect(result.deferredRows).toBe(0);
  });

  test("满耗极限自检：Δ=总额度 → 周期价值 = 月费 × 窗口/30", () => {
    const result = computeQuotaDeltaAllocation({
      monthlyFee: 600,
      feeCurrency: "CNY",
      fxUsdCny: 1,
      windowDays: 7,
      earlier: snapshot(0, PERIOD_FROM),
      later: snapshot(100, PERIOD_TO),
      candidates: [candidate("ex", PERIOD_FROM, 1_000_000_000)],
      maxRows: 100,
    });
    if (result.status !== "estimated") throw new Error("expected estimated");
    expect(result.periodValueNano).toBe(Math.round(600 * 1e9 * (7 / 30)));
  });

  test("USD 月费按入账汇率折算周期价值", () => {
    const result = computeQuotaDeltaAllocation({
      monthlyFee: 20,
      feeCurrency: "USD",
      fxUsdCny: 7,
      windowDays: 7,
      earlier: snapshot(10, PERIOD_FROM),
      later: snapshot(20, PERIOD_TO),
      candidates: [candidate("ex", PERIOD_FROM, 1_000_000_000)],
      maxRows: 100,
    });
    if (result.status !== "estimated") throw new Error("expected estimated");
    expect(result.currency).toBe("USD");
    expect(result.fx).toBe(7);
    // 20 USD × 7 × 7/30 × 10/100 = 32.666… CNY。
    expect(result.periodValueNano).toBe(Math.round(20 * 7 * 1e9 * (7 / 30) * 0.1));
  });

  test("负差分与零差分跳过（重置/无消耗不产生负成本）", () => {
    for (const laterUsed of [40, 39]) {
      const result = computeQuotaDeltaAllocation({
        monthlyFee: 1400, feeCurrency: "CNY", fxUsdCny: 1, windowDays: 7,
        earlier: snapshot(40, PERIOD_FROM),
        later: snapshot(laterUsed, PERIOD_TO),
        candidates: [candidate("ex", PERIOD_FROM, 1e9)],
        maxRows: 10,
      });
      expect(result).toMatchObject({status: "skip", reason: "non_positive_delta"});
    }
  });

  test("无市价行不参与分摊：全部无市价 → no_market_cost；零候选 → no_candidates", () => {
    const noMarket = computeQuotaDeltaAllocation({
      monthlyFee: 1400, feeCurrency: "CNY", fxUsdCny: 1, windowDays: 7,
      earlier: snapshot(40, PERIOD_FROM), later: snapshot(55, PERIOD_TO),
      candidates: [candidate("ex", PERIOD_FROM, 0)],
      maxRows: 10,
    });
    expect(noMarket).toMatchObject({status: "skip", reason: "no_market_cost"});
    const noRows = computeQuotaDeltaAllocation({
      monthlyFee: 1400, feeCurrency: "CNY", fxUsdCny: 1, windowDays: 7,
      earlier: snapshot(40, PERIOD_FROM), later: snapshot(55, PERIOD_TO),
      candidates: [],
      maxRows: 10,
    });
    expect(noRows).toMatchObject({status: "skip", reason: "no_candidates"});
  });

  test("行数上限截断：按 capturedAt 升序取前 N、其余顺延（deferredRows）", () => {
    const candidates = Array.from({length: 5}, (_, index) =>
      candidate(`ex-${index}`, `2026-09-28T0${9 + index}:00:00.000Z`, 1_000_000_000));
    const result = computeQuotaDeltaAllocation({
      monthlyFee: 1400, feeCurrency: "CNY", fxUsdCny: 1, windowDays: 7,
      earlier: snapshot(40, PERIOD_FROM), later: snapshot(55, PERIOD_TO),
      candidates,
      maxRows: 2,
    });
    if (result.status !== "estimated") throw new Error("expected estimated");
    expect(result.rows.map(row => row.exchangeId)).toEqual(["ex-0", "ex-1"]);
    expect(result.deferredRows).toBe(3);
    // 每行份额 = 1/2（分母只含本轮被采纳的行）。
    expect(result.rows[0]!.share).toBeCloseTo(0.5, 9);
  });

  test("marketTotalNano 聚合分母（2026-10-09 截断守恒）：份额按全量口径、顺延数只看本轮 pending", () => {
    const candidates = [
      candidate("ex-0", "2026-09-28T09:00:00.000Z", 1_000_000_000),
      candidate("ex-1", "2026-09-28T10:00:00.000Z", 1_000_000_000),
      candidate("ex-2", "2026-09-28T11:00:00.000Z", 1_000_000_000),
    ];
    const result = computeQuotaDeltaAllocation({
      monthlyFee: 300, feeCurrency: "CNY", fxUsdCny: 1, windowDays: 7,
      earlier: snapshot(0, PERIOD_FROM), later: snapshot(10, PERIOD_TO),
      candidates, maxRows: 1,
      /* 全量口径 9（含本轮候选之外的已补写行）：截断轮的份额不被候选页放大。 */
      marketTotalNano: 9_000_000_000,
    });
    if (result.status !== "estimated") throw new Error("expected estimated");
    // 周期价值 300 × 7/30 × 10/100 = 7 CNY；ex-0 份额 = 1/9 → 0.777… CNY。
    expect(result.periodValueNano).toBe(7_000_000_000);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.share).toBeCloseTo(1 / 9, 9);
    expect(result.rows[0]!.nano).toBe(Math.round(7_000_000_000 / 9));
    expect(result.deferredRows).toBe(2);
  });

  test("配对校验：同窗口同 reset_at 且时间严格递增才可配对（跨周期/同批绝不配对）", () => {
    const later = {windowLabel: "weekly", resetAt: "2026-10-06T00:00:00.000Z", capturedAt: PERIOD_TO};
    expect(canPairQuotaSnapshots(
      {windowLabel: "weekly", resetAt: "2026-10-06T00:00:00.000Z"},
      later,
      PERIOD_FROM,
    )).toBe(true);
    // reset_at 变化（厂商开新周期）→ 不配对。
    expect(canPairQuotaSnapshots({windowLabel: "weekly", resetAt: "2026-10-13T00:00:00.000Z"}, later, PERIOD_FROM)).toBe(false);
    // reset_at 缺失（周期边界未知）→ 保守不配对。
    expect(canPairQuotaSnapshots({windowLabel: "weekly", resetAt: null}, later, PERIOD_FROM)).toBe(false);
    // 窗口不同 → 不配对。
    expect(canPairQuotaSnapshots({windowLabel: "5h", resetAt: "2026-10-06T00:00:00.000Z"}, later, PERIOD_FROM)).toBe(false);
    // 同一批（captured_at 相同，多密钥）→ 不配对，等待下一批。
    expect(canPairQuotaSnapshots({windowLabel: "weekly", resetAt: "2026-10-06T00:00:00.000Z"}, later, PERIOD_TO)).toBe(false);
  });

  test("buildQuotaDeltaDetail：差分依据完整入 detail（浮窗还原用）", () => {
    const result = computeQuotaDeltaAllocation({
      monthlyFee: 20, feeCurrency: "USD", fxUsdCny: 7, windowDays: 7,
      earlier: snapshot(40, PERIOD_FROM), later: snapshot(55, PERIOD_TO),
      candidates: [candidate("ex-a", PERIOD_FROM, 3_000_000_000)],
      maxRows: 10,
    });
    if (result.status !== "estimated") throw new Error("expected estimated");
    const detail = JSON.parse(buildQuotaDeltaDetail(result, result.rows[0]!));
    expect(detail).toMatchObject({
      consumedBasis: "quota_delta",
      monthlyFee: 20,
      currency: "USD",
      windowLabel: "weekly",
      windowDays: 7,
      usedFrom: 40,
      usedTo: 55,
      total: 100,
      deltaUsed: 15,
      periodFrom: PERIOD_FROM,
      periodTo: PERIOD_TO,
      requestCount: 1,
      fxUsdCny: 7,
    });
    expect(detail.shareOfMarketCost).toBe(1);
  });
});
