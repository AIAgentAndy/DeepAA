import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, test} from "vitest";
import {getDeepaaDatabase} from "../src/lib/db/connection.js";

describe("价格来源底稿", () => {
  test("同一 vendor/runtimeModelId 分别保存官方与 LiteLLM 最近底稿，并按优先级解析", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pricing-source-baseline-"));
    const db = getDeepaaDatabase(dataDir);
    const store = await import("../src/lib/pricing/source-baseline-store.js");

    store.upsertPricingSourceBaseline(db, {
      vendor: "openai",
      runtimeModelId: "gpt-6-sol",
      sourceKind: "litellm",
      sourceRevision: "litellm-2026-09-24",
      sourceHash: "sha256:litellm",
      capturedAt: "2026-09-24T01:00:00.000Z",
      entry: {id: "litellm/gpt-6-sol", vendor: "openai", runtimeModelId: "gpt-6-sol", patterns: ["gpt-6-sol"], pricing: {input: 8, output: 40}, confidence: "third_party"},
    });
    store.upsertPricingSourceBaseline(db, {
      vendor: "openai",
      runtimeModelId: "gpt-6-sol",
      sourceKind: "official",
      sourceRevision: "2026.09.23.01",
      sourceHash: "sha256:official",
      capturedAt: "2026-09-24T02:00:00.000Z",
      entry: {id: "catalog:openai:gpt-6-sol", vendor: "openai", runtimeModelId: "gpt-6-sol", patterns: ["gpt-6-sol"], pricing: {input: 4, output: 20}, confidence: "official", catalogSource: "catalog"},
    });

    const resolved = store.resolveLatestPricingSource(db, "openai", "gpt-6-sol");
    expect(resolved?.sourceKind).toBe("official");
    expect(resolved?.entry.pricing).toEqual({input: 4, output: 20});
    expect(store.listPricingSourceBaselines(db, "openai", "gpt-6-sol")).toHaveLength(2);
  });
});
