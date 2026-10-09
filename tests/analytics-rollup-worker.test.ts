import {describe, expect, test} from "vitest";
import {createAnalyticsRollupWorker} from "../src/lib/analytics/rollup-worker.js";
import {createSqliteFixture} from "./helpers/sqlite-fixture.js";

describe("独立 Analytics Rollup Worker", () => {
  test("使用独立租约并可执行最近小时重建", async () => {
    const fixture = await createSqliteFixture();
    try {
      const worker = createAnalyticsRollupWorker({dataDir: fixture.dataDir, intervalMs: 60_000});
      expect(worker.acquireLease()).toBe(true);
      expect(fixture.db.prepare("SELECT 1 FROM worker_lease WHERE id = 1").get()).toBeUndefined();
      await worker.runOnce();
      worker.releaseLease();
      await worker.close();
    } finally {
      await fixture.cleanup();
    }
  });
});
