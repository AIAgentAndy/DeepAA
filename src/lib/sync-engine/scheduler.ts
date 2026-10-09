import type {SyncService} from "./service";

/** 额度差分估算复跑节流（2026-10-09 用户确认 F3）：低频定时闭合派生落库晚于
 *  同步钩子的竞争窗口；游标幂等，快拍只会得到 short_circuit/skip。 */
const PLAN_ESTIMATE_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * 控制台同步调度器：串行执行到期的控制台账号与套餐同步，
 * 随机抖动避免整点打爆中转站；失败退避由 SyncService 计算 next_sync_at。
 * 只调度已配置同步的供应商；手动"立即同步"不受调度约束。
 * tick 默认 10s：最短同步周期为 1 分钟，到期扫描误差不超过一个 tick。
 */
export class SyncScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private nextPlanEstimateSweepAt = 0;

  constructor(
    private readonly service: SyncService,
    private readonly intervalMs = 10_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 暴露单次有界 tick，便于启动时立即运行和测试双调度源。 */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = this.service.store.dueAccounts(new Date().toISOString());
      for (const account of due) {
        try {
          await this.service.runSync(account.targetId, {automatic: true});
        } catch {
          // 状态与下次调度已由 SyncService 记录，单供应商失败不阻断其他供应商。
        }
      }
      const duePlans = this.service.store.duePlanConfigs(new Date().toISOString());
      for (const config of duePlans.items) {
        try {
          await this.service.runPlanSync(config.targetId, {automatic: true});
        } catch {
          // 套餐失败保留最近成功快照；单供应商失败不阻断后续供应商与控制台同步。
        }
      }
      await this.service.reconcileDueHours().catch(error => {
        console.error("[deepaa] relay hourly reconciliation tick failed", error);
      });
      this.service.store.prune(new Date().toISOString());
      await this.runPlanEstimateSweepOnce(Date.now());
    } finally {
      this.running = false;
    }
  }

  /** 额度差分估算复跑（10 分钟节流）：到期才执行；单次失败不阻断调度循环。 */
  private async runPlanEstimateSweepOnce(nowMs: number): Promise<void> {
    if (nowMs < this.nextPlanEstimateSweepAt) return;
    this.nextPlanEstimateSweepAt = nowMs + PLAN_ESTIMATE_SWEEP_INTERVAL_MS;
    try {
      await this.service.runPlanEstimateBackfillSweep();
    } catch (error) {
      console.error("[deepaa] plan-estimate-backfill sweep tick failed", error);
    }
  }
}
