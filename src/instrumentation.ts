/** Next Node 服务启动后异步拉起 SQLite 单写者，构建阶段不触碰数据目录。 */
export async function register(): Promise<void> {
  if (
    process.env.NEXT_RUNTIME !== "nodejs"
    || process.env.NEXT_PHASE === "phase-production-build"
  ) {
    return;
  }

  const { resolveDeepaaDataDir } = await import("./lib/data-paths");
  const { registerHealthComponent } = await import("./lib/health-status");
  const { startIngestionWorker } = await import("./lib/ingestion/worker");
  const { startAnalyticsRollupWorker } = await import("./lib/analytics/rollup-worker");
  const { startPricingImportScheduler } = await import("./lib/pricing-import");
  const { startOfficialCatalogSyncScheduler } = await import("./lib/provider-catalog/catalog-runner");
  const { ensurePricingConfigRevision } = await import("./lib/ingestion/pricing-revisions");
  const { getDeepaaDatabase } = await import("./lib/db/connection");
  const { readEffectivePricingConfig } = await import("./lib/pricing");
  const { getSyncService } = await import("./lib/sync-engine/service");
  const { SyncScheduler } = await import("./lib/sync-engine/scheduler");
  const dataDir = resolveDeepaaDataDir();
  startPricingImportScheduler(dataDir);
  registerHealthComponent("pricing-import");
  // 2026-09-07 四原则：启动 + 每 1 小时官方目录同步（替代原 6 小时缓存调度器）。
  // 静默集（插入 + 升级 + 字段新增 + 未使用更新）落盘时追加价格版本记录，保证 Worker 感知价格变化。
  startOfficialCatalogSyncScheduler(dataDir, undefined, async (dir, _config, effectiveAt) => {
    const effective = await readEffectivePricingConfig(dir);
    ensurePricingConfigRevision(getDeepaaDatabase(dir), effective, effectiveAt);
  });
  registerHealthComponent("official-catalog-sync");
  try {
    // tick 10s：最短同步周期为 1 分钟，把到期扫描误差控制在 10s 内。
    const syncScheduler = new SyncScheduler(await getSyncService(), 10_000);
    syncScheduler.start();
    registerHealthComponent("provider-sync-scheduler");
    console.info("[deepaa] provider sync scheduler started (tick 10s)");
  } catch (error) {
    // 同步调度失败不应阻止 Next UI 启动；用户仍可手动触发立即同步。
    console.error("[deepaa] provider sync scheduler startup failed", error);
  }
  try {
    // 派生批次完成钩子（2026-10-09 额度差分估算 F3）：落库晚于同步钩子的行经
    // 60s 节流复跑补算（结算游标幂等）；与调度器 10 分钟低频扫描构成双触发。
    let lastBatchSweepAt = 0;
    const batchCompleteListener = (): void => {
      const now = Date.now();
      if (now - lastBatchSweepAt < 60_000) return;
      lastBatchSweepAt = now;
      void getSyncService()
        .then(service => service.runPlanEstimateBackfillSweep())
        .catch(error => {
          console.error("[deepaa] plan-estimate-backfill batch sweep failed", error);
        });
    };
    startIngestionWorker({ dataDir, batchCompleteListener });
    registerHealthComponent("ingestion-worker");
  } catch (error) {
    // 分析 Worker 失败不应阻止 Next UI 启动，更不能影响独立代理进程。
    console.error("[deepaa] SQLite ingestion Worker startup failed", error);
  }
  try {
    // 双链路观测（2026-09-15）：Agent 官方直连本地导入，定时全自动、无手动触发；
    // 绑定由默认目标（官方预设 + Agent scope）推导，未绑定/数据缺失时静默空转。
    // tick 时长从调度器常量插值（2026-09-22 节拍 5s→2s 时曾漏改文案导致日志撒谎）。
    const { startAgentLocalImportScheduler, LOCAL_IMPORT_INTERVAL_MS } = await import("./lib/agent-local-source/local-import-scheduler");
    startAgentLocalImportScheduler({ dataDir });
    registerHealthComponent("agent-local-import");
    console.info(`[deepaa] agent local import scheduler started (tick ${LOCAL_IMPORT_INTERVAL_MS / 1000}s)`);
  } catch (error) {
    console.error("[deepaa] agent local import scheduler startup failed", error);
  }
  try {
    startAnalyticsRollupWorker({ dataDir });
    registerHealthComponent("analytics-rollup");
    console.info("[deepaa] analytics rollup worker started (tick 2m)");
  } catch (error) {
    // Analytics 汇总失败只影响 Dashboard 新鲜度，不阻断摄取、代理或 SSE。
    console.error("[deepaa] Analytics Rollup Worker startup failed", error);
  }
  try {
    // 存储自动清理（2026-09-21 用户确认）：每日空闲一次 + 保留窗口调整后当日空闲即清；
    // 复用 raw-purge 闭环（整文件粒度、墓碑、blob GC、incremental_vacuum）。
    const { startAutoPurgeScheduler } = await import("./lib/ingestion/purge-scheduler");
    startAutoPurgeScheduler({ dataDir });
    registerHealthComponent("storage-auto-purge");
    console.info("[deepaa] storage auto purge scheduler started (tick 10m)");
  } catch (error) {
    // 清理调度失败不影响任何业务链路；存储管理弹窗仍可手动清理。
    console.error("[deepaa] storage auto purge scheduler startup failed", error);
  }
}
