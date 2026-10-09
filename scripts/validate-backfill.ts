/**
 * 验收脚本：在完整 data 上跑增量派生至追平，周期性打印进度与堆内存。
 * 验证增量引擎在大数据上不 OOM、产出完整。
 * 用法：pnpm exec tsx scripts/validate-backfill.ts [dataDir]
 */
import { join } from "node:path";
import { ensureCaptureIndexRecords } from "../src/lib/capture-index";
import { readPricingConfig } from "../src/lib/pricing";
import { DerivationStream } from "../src/lib/derivation/stream-processor";
import { processBatch, indexSignature } from "../src/lib/derivation/watcher";
import {
  GENERATOR_VERSION,
  emptyCheckpoint,
  readCheckpoint,
  writeCheckpoint,
  isCaughtUp,
  loadPricingConfigCached,
} from "../src/lib/derivation/incremental";

const dataDir = process.argv[2] ?? join(process.cwd(), "data");

function mb(): string {
  const m = process.memoryUsage();
  return `heap=${(m.heapUsed / 1048576).toFixed(1)}MB rss=${(m.rss / 1048576).toFixed(1)}MB`;
}

async function main() {
  const records = await ensureCaptureIndexRecords(dataDir);
  const total = records.length;
  console.log(`[validate] index records: ${total}`);

  let checkpoint = await readCheckpoint(dataDir);
  const freshSignature = await indexSignature(dataDir, total);
  if (!checkpoint || checkpoint.generatorVersion !== GENERATOR_VERSION) {
    console.log(`[validate] fresh checkpoint (version mismatch or none)`);
    checkpoint = emptyCheckpoint(freshSignature);
    await writeCheckpoint(dataDir, checkpoint);
  }
  console.log(`[validate] resume from recordCount=${checkpoint.derivedUpTo.recordCount}`);

  let pricingCache: { path: string; mtimeMs: number; config: Awaited<ReturnType<typeof readPricingConfig>> } | undefined;
  let stream = await (async () => {
    const cached = await loadPricingConfigCached(dataDir, pricingCache as never);
    if (cached) pricingCache = cached as never;
    return new DerivationStream(dataDir, (pricingCache?.config ?? (await readPricingConfig(dataDir))) as never);
  })();

  let batch = 0;
  const t0 = Date.now();
  let lastLog = 0;
  for (;;) {
    const refreshed = await loadPricingConfigCached(dataDir, pricingCache as never);
    if (refreshed && (!pricingCache || refreshed.mtimeMs !== pricingCache.mtimeMs)) {
      pricingCache = refreshed as never;
      stream = new DerivationStream(dataDir, refreshed.config as never);
    }
    const result = await processBatch(dataDir, stream, checkpoint, { batchMaxMs: 200, batchMaxRecords: 300 });
    batch += 1;
    const now = Date.now();
    if (now - lastLog > 3000 || result.caughtUp) {
      const pct = ((checkpoint.derivedUpTo.recordCount / total) * 100).toFixed(1);
      console.log(`[validate] batch=${batch} processed=${checkpoint.derivedUpTo.recordCount}/${total} (${pct}%) remaining=${result.remaining} ${mb()} elapsed=${((now - t0) / 1000).toFixed(1)}s`);
      lastLog = now;
    }
    if (result.caughtUp && isCaughtUp(checkpoint, total, freshSignature)) {
      console.log(`[validate] CAUGHT UP done. ${mb()} elapsed=${((now - t0) / 1000).toFixed(1)}s`);
      break;
    }
    if (result.processed === 0) {
      console.log(`[validate] no progress, stopping. recordCount=${checkpoint.derivedUpTo.recordCount}`);
      break;
    }
  }
  console.log(`[validate] complete. ${mb()}`);
}

main().catch((e) => { console.error("[validate] FATAL", e); process.exit(1); });
