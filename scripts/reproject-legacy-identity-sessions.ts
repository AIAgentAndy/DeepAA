/**
 * CLI：批次 3 存量重挂（旧指纹 donor 会话定向重放）。核心逻辑在
 * src/lib/ingestion/legacy-identity-repair.ts，本文件只做参数解析与报告。
 *
 * 用法：
 *   pnpm exec tsx scripts/reproject-legacy-identity-sessions.ts [dataDir]           # dry-run，只报告
 *   pnpm exec tsx scripts/reproject-legacy-identity-sessions.ts [dataDir] --execute # 执行定向重放
 */
import { resolveDeepaaDataDir } from "../src/lib/data-paths.js";
import {
  analyzeLegacyIdentityDonorSessions,
  reprojectLegacyIdentitySessions,
} from "../src/lib/ingestion/legacy-identity-repair.js";
import { openDeepaaDatabase } from "../src/lib/db/connection.js";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const dataDirArg = args.find(arg => !arg.startsWith("--"));
const dataDir = dataDirArg ?? resolveDeepaaDataDir();

const analysisDb = openDeepaaDatabase({dataDir});
const plan = analyzeLegacyIdentityDonorSessions(analysisDb);
analysisDb.close();

console.log(`[repair] dataDir=${dataDir} mode=${execute ? "EXECUTE" : "dry-run"}`);
console.log(`[repair] donor 会话 ${plan.donors.length} 个，涉及模型交换 ${plan.affectedExchangeCount} 个`);
for (const donor of plan.donors) {
  console.log(`  - ${donor.id} ${donor.agentName} fp=${donor.fingerprintId} req=${donor.requestCount} start=${donor.startTime}`);
}

if (!execute) {
  console.log("[repair] dry-run 结束：未做任何写入。加 --execute 执行定向重放。");
  process.exit(0);
}
if (plan.donors.length === 0) {
  console.log("[repair] 无需修复。");
  process.exit(0);
}

const startedAt = Date.now();
const result = await reprojectLegacyIdentitySessions(dataDir);

console.log(`[repair] 完成：重放 ${result.rederived} 个交换（并回规范会话 ${result.mergedBack} 个），跳过 ${result.skipped.length} 个，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
for (const item of result.skipped) console.log(`  ! 跳过 ${item.exchangeId}（${item.reason}）`);
if (result.remainingDonors.length > 0) {
  console.log(`[repair] 仍残留 donor 会话 ${result.remainingDonors.length} 个（多为仅剩辅助行的会话壳，属预期）：`);
  for (const donor of result.remainingDonors) console.log(`  - ${donor.id} ${donor.agentName}`);
}
console.log("[repair] analytics 脏桶已由派生链路标记，rollup worker 将自动重算受影响小时桶。");
