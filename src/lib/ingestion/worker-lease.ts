/**
 * Worker 租约的唯一契约（2026-09-18）。
 *
 * 背景：SQLite 单写者约定靠 `worker_lease`（单行、带到期时间）保证。此前各模块
 * 各自内联 `assertLease` 并抛普通 `Error`，导致两个可观测性缺口：
 *
 * 1. `worker.ts` 的错误分类只认 error 上的 `code` 字段，普通 `Error` 一律塌缩成
 *    `derivation_failed`——日志里看不出"到底是不是租约丢了"；
 * 2. 租约丢失发生在**失败回写**路径时，回写自己也带租约校验而失败，任务状态
 *    迁移永不提交：任务永久停留在 `running` + 冻结锁，因 claim 的"同 source
 *    前序未完成"约束锁死整个文件后续记录（2026-09-18 实测 174 条积压）。
 *
 * 因此租约丢失必须是**可识别**的错误类型，统一走本模块。
 */
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";

/** 租约丢失的错误码（`worker.ts` 的 ingestionErrorCode 直接取 error.code）。 */
export const WORKER_LEASE_LOST_CODE = "worker_lease_lost";

export class WorkerLeaseLostError extends Error {
  readonly code = WORKER_LEASE_LOST_CODE;

  constructor(readonly ownerId: string) {
    super(`Worker ${ownerId} 未持有有效租约。`);
    this.name = "WorkerLeaseLostError";
  }
}

export function isWorkerLeaseLostError(error: unknown): boolean {
  return error instanceof WorkerLeaseLostError
    || (!!error && typeof error === "object"
      && (error as { code?: unknown }).code === WORKER_LEASE_LOST_CODE);
}

/**
 * 断言当前 worker 仍持有有效租约；丢失时抛 `WorkerLeaseLostError`。
 *
 * 只用于**推进共享游标/领取任务**等必须有排他写权限的路径。任务终态回写
 * （成功/失败/永久失败）走行级所有权校验（`locked_by` + `attempt_count`），
 * 不再依赖本断言——那些路径即使租约过期也必须把结果落库，否则会留下僵尸锁。
 */
export function assertWorkerLease(
  db: DeepaaDatabase,
  ownerId: string,
  now: string = new Date().toISOString(),
): void {
  const active = db.prepare(
    `SELECT 1 FROM worker_lease
     WHERE id = 1 AND owner_id = ? AND expires_at > ?`,
  ).get(ownerId, now);
  if (!active) throw new WorkerLeaseLostError(ownerId);
}
