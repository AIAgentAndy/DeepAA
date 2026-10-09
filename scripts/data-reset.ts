import { resolveDeepaaDataDir } from "../src/lib/data-paths";
import {
  assertConfiguredProxyStopped,
  resetDeepaaData,
} from "../src/lib/data-reset";

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    throw new Error("pnpm data:reset 不接受额外参数。");
  }
  const dataDir = resolveDeepaaDataDir();
  await assertConfiguredProxyStopped(dataDir);
  const result = await resetDeepaaData({ dataDir });
  process.stdout.write(`${JSON.stringify({
    event: "data-reset-complete",
    dataDir: result.dataDir,
    backupDir: result.backupDir,
    archivedPaths: result.archivedPaths,
    schemaVersion: result.schemaVersion,
  })}\n`);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`data:reset 失败：${message}\n`);
  process.exitCode = 1;
});
