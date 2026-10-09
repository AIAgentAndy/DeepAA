import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";

export interface ConsoleAccountRow {
  id: string;
  targetId: string;
  providerType: string;
  consoleBaseUrl: string;
  username: string;
  passwordRef: string;
  loginMode: string;
  status: string;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  /** 连续自动同步失败次数：自动失败 +1、任何一次成功清零；手动失败不加不清。 */
  consecutiveAutoFailures: number;
  /** 最近一次失败的类别（auth = 凭证/鉴权；null = 无进行中的失败链）；门槛按类别策略化。 */
  consecutiveFailureKind: string | null;
  nextSyncAt: string | null;
  /** 自动同步周期（分钟）；账号与套餐链路各自独立。 */
  syncIntervalMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface BalanceSnapshotRow {
  id: number;
  targetId: string;
  consoleAccountId: string | null;
  providerType: string;
  currency: string;
  amount: number;
  quota: number | null;
  usedQuota: number | null;
  source: string;
  rawJson: string;
  capturedAt: string;
}

export interface RateSnapshotRow {
  id: number;
  targetId: string;
  credentialId: string;
  tokenGroup: string | null;
  ratio: number;
  source: string;
  capturedAt: string;
}

export interface SyncRunRow {
  id: number;
  consoleAccountId: string | null;
  targetId: string;
  status: string;
  mode: string;
  detailJson: string;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * 同步 run 的 detail_json 只在调用方明确需要「最近一次同步证据」时才解析，
 * 解析前先按字符数做防御上限；异常膨胀的行一律按「无证据」处理。
 */
const SYNC_RUN_DETAIL_MAX_CHARS = 256 * 1024;

/** 从 `sync_runs.detail_json` 还原出来的密钥远程对比行（结构经运行期校验）。 */
export interface CredentialComparisonRow {
  credentialId: string;
  label: string;
  matched: boolean;
  remoteName?: string;
  remoteKeyId?: string;
  ratio?: number;
  reason?: string;
}

export interface PlanSyncConfigRow {
  id: string;
  targetId: string;
  providerType: string;
  credentialId: string | null;
  accessKeyRef: string | null;
  secretKeyRef: string | null;
  status: string;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  /** 连续自动同步失败次数：自动失败 +1、任何一次成功清零；手动失败不加不清。 */
  consecutiveAutoFailures: number;
  /** 最近一次失败的类别（auth = 凭证/鉴权；null = 无进行中的失败链）；门槛按类别策略化。 */
  consecutiveFailureKind: string | null;
  nextSyncAt: string | null;
  /** 自动同步周期（分钟）；账号与套餐链路各自独立。 */
  syncIntervalMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlanQuotaSnapshotRow {
  id: number;
  targetId: string;
  planSyncId: string | null;
  consoleAccountId: string | null;
  credentialId: string | null;
  providerType: string;
  planFamily: string | null;
  planName: string | null;
  windowLabel: string;
  used: number | null;
  total: number | null;
  remaining: number | null;
  unit: string | null;
  resetAt: string | null;
  rawJson: string;
  capturedAt: string;
}

/** 旧调用方插入快照时可省略 remaining，写入边界统一归一化为 NULL。 */
type PlanQuotaSnapshotInsert = Omit<PlanQuotaSnapshotRow, "id" | "remaining"> & {
  remaining?: number | null;
};

export interface BoundedSyncRows<T> {
  items: T[];
  candidateCount: number;
  processedCount: number;
  limited: boolean;
}

const BALANCE_RETENTION_DAYS = 90;
const RATE_RETENTION_PER_CREDENTIAL = 200;
const SYNC_RUN_RETENTION_PER_ACCOUNT = 200;
const PLAN_QUOTA_RETENTION_DAYS = 90;

const CONSOLE_ACCOUNT_COLUMNS = `
  id, target_id AS targetId,
  CASE provider_type WHEN 'dashscope' THEN 'qwenai' ELSE provider_type END AS providerType,
  console_base_url AS consoleBaseUrl, username, password_ref AS passwordRef,
  login_mode AS loginMode, status, last_sync_at AS lastSyncAt,
  last_sync_error AS lastSyncError, next_sync_at AS nextSyncAt,
  consecutive_auto_failures AS consecutiveAutoFailures,
  consecutive_failure_kind AS consecutiveFailureKind,
  sync_interval_minutes AS syncIntervalMinutes,
  created_at AS createdAt, updated_at AS updatedAt
`;

const BALANCE_COLUMNS = `
  id, target_id AS targetId, console_account_id AS consoleAccountId,
  provider_type AS providerType, currency, amount, quota,
  used_quota AS usedQuota, source, raw_json AS rawJson, captured_at AS capturedAt
`;

const RATE_COLUMNS = `
  id, target_id AS targetId, credential_id AS credentialId,
  token_group AS tokenGroup, ratio, source, captured_at AS capturedAt
`;

const SYNC_RUN_COLUMNS = `
  id, console_account_id AS consoleAccountId, target_id AS targetId,
  status, mode, detail_json AS detailJson, started_at AS startedAt,
  finished_at AS finishedAt
`;

const PLAN_SYNC_CONFIG_COLUMNS = `
  id, target_id AS targetId,
  CASE provider_type WHEN 'dashscope' THEN 'qwenai-token-plan' ELSE provider_type END AS providerType,
  credential_id AS credentialId, access_key_ref AS accessKeyRef,
  secret_key_ref AS secretKeyRef, status, last_sync_at AS lastSyncAt,
  last_sync_error AS lastSyncError, next_sync_at AS nextSyncAt,
  consecutive_auto_failures AS consecutiveAutoFailures,
  consecutive_failure_kind AS consecutiveFailureKind,
  sync_interval_minutes AS syncIntervalMinutes,
  created_at AS createdAt, updated_at AS updatedAt
`;

const PLAN_QUOTA_COLUMNS = `
  id, target_id AS targetId, plan_sync_id AS planSyncId,
  console_account_id AS consoleAccountId, credential_id AS credentialId,
  CASE provider_type WHEN 'dashscope' THEN 'qwenai-token-plan' ELSE provider_type END AS providerType,
  plan_family AS planFamily, plan_name AS planName,
  window_label AS windowLabel, used, total, remaining, unit, reset_at AS resetAt,
  raw_json AS rawJson, captured_at AS capturedAt
`;

function boundedLimit(limit: number, maximum = 50): number {
  return Math.min(Math.max(Math.trunc(limit), 1), maximum);
}

/**
 * 同步引擎 SQLite 读写：操作 v14/v15 新增的低频小表，
 * 所有查询走索引并带保留策略清理，禁止无界读取。
 */
export class SyncStore {
  constructor(private readonly db: DeepaaDatabase) {}

  /** 只读数据库句柄：额度差分估算回填等同进程配套机制使用，不扩大 store 职责边界。 */
  get database(): DeepaaDatabase {
    return this.db;
  }

  /** 最近一次对账窗口（任意状态）：作为下一窗口的锚点。 */
  latestReconciliationWindow(targetId: string): {
    windowEnd: string; status: string; diffAmount: number;
  } | undefined {
    return this.db.prepare(
      `SELECT window_end AS windowEnd, status, diff_amount AS diffAmount
       FROM reconciliation_windows WHERE target_id = ?
       ORDER BY window_end DESC, id DESC LIMIT 1`,
    ).get(targetId) as {windowEnd: string; status: string; diffAmount: number} | undefined;
  }

  insertReconciliationWindow(input: {
    targetId: string;
    windowStart: string;
    windowEnd: string;
    siteSpend: number;
    localSpend: number;
    diffAmount: number;
    currency: string;
    status: "baseline" | "balanced" | "applied" | "needs_review" | "skipped";
    ledgerExchangeId?: string;
  }): void {
    this.db.prepare(
      `INSERT INTO reconciliation_windows(
        target_id, window_start, window_end, site_spend, local_spend,
        diff_amount, currency, status, ledger_exchange_id, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_id, window_end) DO NOTHING`,
    ).run(
      input.targetId,
      input.windowStart,
      input.windowEnd,
      input.siteSpend,
      input.localSpend,
      input.diffAmount,
      input.currency,
      input.status,
      input.ledgerExchangeId ?? null,
      new Date().toISOString(),
    );
  }

  upsertConsoleAccount(input: Omit<ConsoleAccountRow, "createdAt" | "updatedAt">): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO console_accounts(
        id, target_id, provider_type, console_base_url, username, password_ref,
        login_mode, status, last_sync_at, last_sync_error, consecutive_auto_failures,
        consecutive_failure_kind, next_sync_at, sync_interval_minutes, created_at, updated_at
      ) VALUES(@id, @targetId, @providerType, @consoleBaseUrl, @username, @passwordRef,
        @loginMode, @status, @lastSyncAt, @lastSyncError, @consecutiveAutoFailures,
        @consecutiveFailureKind, @nextSyncAt, @syncIntervalMinutes, @createdAt, @updatedAt)
      ON CONFLICT(target_id) DO UPDATE SET
        provider_type = excluded.provider_type,
        console_base_url = excluded.console_base_url,
        username = excluded.username,
        password_ref = excluded.password_ref,
        login_mode = excluded.login_mode,
        status = excluded.status,
        last_sync_at = excluded.last_sync_at,
        last_sync_error = excluded.last_sync_error,
        consecutive_auto_failures = excluded.consecutive_auto_failures,
        consecutive_failure_kind = excluded.consecutive_failure_kind,
        next_sync_at = excluded.next_sync_at,
        sync_interval_minutes = excluded.sync_interval_minutes,
        updated_at = excluded.updated_at
    `).run({
      ...input,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** 修正 console_accounts 的用户名（老数据曾存脱敏值，自愈为凭据文件明文）。 */
  updateConsoleUsername(targetId: string, username: string): void {
    this.db.prepare(`
      UPDATE console_accounts SET username = ?, updated_at = ? WHERE target_id = ?
    `).run(username, new Date().toISOString(), targetId);
  }

  getConsoleAccount(targetId: string): ConsoleAccountRow | undefined {
    return this.db.prepare(
      `SELECT ${CONSOLE_ACCOUNT_COLUMNS} FROM console_accounts WHERE target_id = ?`,
    ).get(targetId) as ConsoleAccountRow | undefined;
  }

  listConsoleAccounts(): ConsoleAccountRow[] {
    return this.db.prepare(
      `SELECT ${CONSOLE_ACCOUNT_COLUMNS} FROM console_accounts ORDER BY updated_at DESC`,
    ).all() as ConsoleAccountRow[];
  }

  /**
   * 连续自动失败计数的写入操作：increment = 自动失败 +1（可带失败类别，缺省 default）；
   * reset = 任何一次成功清零并清空类别；缺省不动（手动失败不加不清）。
   * 计数只影响「同步失败」红标判定，不影响同步调度本身。
   */
  private static autoFailureCountSql(op: {op: "increment" | "reset"; kind?: string} | undefined): string {
    if (!op) return "";
    if (op.op === "increment") {
      return "consecutive_auto_failures = consecutive_auto_failures + 1,"
        + ` consecutive_failure_kind = ${op.kind === "auth" ? "'auth'" : "'default'"},`;
    }
    return "consecutive_auto_failures = 0, consecutive_failure_kind = NULL,";
  }

  setConsoleAccountStatus(
    targetId: string,
    status: string,
    options: {
      error?: string;
      nextSyncAt?: string | null;
      lastSyncAt?: string;
      autoFailure?: {op: "increment" | "reset"; kind?: string};
    } = {},
  ): void {
    this.db.prepare(`
      UPDATE console_accounts SET
        ${SyncStore.autoFailureCountSql(options.autoFailure)}
        status = @status,
        last_sync_at = COALESCE(@lastSyncAt, last_sync_at),
        last_sync_error = @error,
        next_sync_at = @nextSyncAt,
        updated_at = @updatedAt
      WHERE target_id = @targetId
    `).run({
      targetId,
      status,
      error: options.error ?? null,
      nextSyncAt: options.nextSyncAt ?? null,
      lastSyncAt: options.lastSyncAt ?? null,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 物理删除控制台账号及其全部派生数据：账号行、余额快照、倍率快照、同步记录。
   * 账号信息严格跟随代理供应商：删除供应商（或删除账号）时不再保留任何可被
   * 重建同名供应商复活的残留快照。快照与账号行的外键引用一并删除，不会触发 FK 失败。
   */
  removeConsoleAccount(targetId: string): boolean {
    const remove = this.db.transaction(() => {
      this.db.prepare("DELETE FROM balance_snapshots WHERE target_id = ?").run(targetId);
      this.db.prepare("DELETE FROM credential_rate_snapshots WHERE target_id = ?").run(targetId);
      this.db.prepare("DELETE FROM sync_runs WHERE target_id = ?").run(targetId);
      return this.db.prepare("DELETE FROM console_accounts WHERE target_id = ?").run(targetId).changes > 0;
    });
    return remove();
  }

  /** 删除整个代理供应商时使用，确保控制台与套餐派生数据不会被同名供应商复活。 */
  removeTargetSyncData(targetId: string): boolean {
    const remove = this.db.transaction(() => {
      const planSnapshots = this.db.prepare(
        "DELETE FROM plan_quota_snapshots WHERE target_id = ?",
      ).run(targetId).changes;
      const planConfigs = this.db.prepare(
        "DELETE FROM plan_sync_configs WHERE target_id = ?",
      ).run(targetId).changes;
      const balanceSnapshots = this.db.prepare(
        "DELETE FROM balance_snapshots WHERE target_id = ?",
      ).run(targetId).changes;
      const rateSnapshots = this.db.prepare(
        "DELETE FROM credential_rate_snapshots WHERE target_id = ?",
      ).run(targetId).changes;
      const syncRuns = this.db.prepare(
        "DELETE FROM sync_runs WHERE target_id = ?",
      ).run(targetId).changes;
      const consoleAccounts = this.db.prepare(
        "DELETE FROM console_accounts WHERE target_id = ?",
      ).run(targetId).changes;
      return planSnapshots + planConfigs + balanceSnapshots + rateSnapshots
        + syncRuns + consoleAccounts > 0;
    });
    return remove();
  }

  upsertPlanSyncConfig(
    input: Omit<PlanSyncConfigRow, "createdAt" | "updatedAt">,
  ): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO plan_sync_configs(
        id, target_id, provider_type, credential_id, access_key_ref,
        secret_key_ref, status, last_sync_at, last_sync_error, consecutive_auto_failures,
        consecutive_failure_kind, next_sync_at, sync_interval_minutes, created_at, updated_at
      ) VALUES(
        @id, @targetId, @providerType, @credentialId, @accessKeyRef,
        @secretKeyRef, @status, @lastSyncAt, @lastSyncError, @consecutiveAutoFailures,
        @consecutiveFailureKind, @nextSyncAt, @syncIntervalMinutes, @createdAt, @updatedAt
      )
      ON CONFLICT(target_id) DO UPDATE SET
        provider_type = excluded.provider_type,
        credential_id = excluded.credential_id,
        access_key_ref = excluded.access_key_ref,
        secret_key_ref = excluded.secret_key_ref,
        status = excluded.status,
        last_sync_at = excluded.last_sync_at,
        last_sync_error = excluded.last_sync_error,
        consecutive_auto_failures = excluded.consecutive_auto_failures,
        consecutive_failure_kind = excluded.consecutive_failure_kind,
        next_sync_at = excluded.next_sync_at,
        sync_interval_minutes = excluded.sync_interval_minutes,
        updated_at = excluded.updated_at
    `).run({...input, createdAt: now, updatedAt: now});
  }

  getPlanSyncConfig(targetId: string): PlanSyncConfigRow | undefined {
    return this.db.prepare(`
      SELECT ${PLAN_SYNC_CONFIG_COLUMNS}
      FROM plan_sync_configs
      WHERE target_id = ?
    `).get(targetId) as PlanSyncConfigRow | undefined;
  }

  listPlanSyncConfigs(limit = 50): BoundedSyncRows<PlanSyncConfigRow> {
    const safeLimit = boundedLimit(limit);
    const candidateCount = this.db.prepare(
      "SELECT COUNT(*) FROM plan_sync_configs",
    ).pluck().get() as number;
    const rows = this.db.prepare(`
      SELECT ${PLAN_SYNC_CONFIG_COLUMNS}
      FROM plan_sync_configs
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(safeLimit + 1) as PlanSyncConfigRow[];
    return {
      items: rows.slice(0, safeLimit),
      candidateCount,
      processedCount: rows.length,
      limited: rows.length > safeLimit,
    };
  }

  setPlanSyncConfigStatus(
    targetId: string,
    status: string,
    options: {
      error?: string;
      nextSyncAt?: string | null;
      lastSyncAt?: string;
      autoFailure?: {op: "increment" | "reset"; kind?: string};
    } = {},
  ): void {
    this.db.prepare(`
      UPDATE plan_sync_configs SET
        ${SyncStore.autoFailureCountSql(options.autoFailure)}
        status = @status,
        last_sync_at = COALESCE(@lastSyncAt, last_sync_at),
        last_sync_error = @error,
        next_sync_at = @nextSyncAt,
        updated_at = @updatedAt
      WHERE target_id = @targetId
    `).run({
      targetId,
      status,
      error: options.error ?? null,
      nextSyncAt: options.nextSyncAt ?? null,
      lastSyncAt: options.lastSyncAt ?? null,
      updatedAt: new Date().toISOString(),
    });
  }

  removePlanSyncConfig(targetId: string): boolean {
    const remove = this.db.transaction(() => {
      this.db.prepare("DELETE FROM plan_quota_snapshots WHERE target_id = ?").run(targetId);
      return this.db.prepare(
        "DELETE FROM plan_sync_configs WHERE target_id = ?",
      ).run(targetId).changes > 0;
    });
    return remove();
  }

  /** 到期套餐配置使用 limit+1 哨兵读取，避免调度器无界物化全部供应商。 */
  duePlanConfigs(nowIso: string, limit = 20): BoundedSyncRows<PlanSyncConfigRow> {
    const safeLimit = boundedLimit(limit);
    const staleCutoff = new Date(new Date(nowIso).getTime() - 10 * 60_000).toISOString();
    const whereSql = `
      next_sync_at IS NOT NULL AND next_sync_at <= ?
      AND (status != 'running' OR updated_at <= ?)
    `;
    const candidateCount = this.db.prepare(`
      SELECT COUNT(*) FROM plan_sync_configs WHERE ${whereSql}
    `).pluck().get(nowIso, staleCutoff) as number;
    const rows = this.db.prepare(`
      SELECT ${PLAN_SYNC_CONFIG_COLUMNS}
      FROM plan_sync_configs
      WHERE ${whereSql}
      ORDER BY next_sync_at ASC, id ASC
      LIMIT ?
    `).all(nowIso, staleCutoff, safeLimit + 1) as PlanSyncConfigRow[];
    return {
      items: rows.slice(0, safeLimit),
      candidateCount,
      processedCount: rows.length,
      limited: rows.length > safeLimit,
    };
  }

  insertPlanQuotaSnapshots(input: PlanQuotaSnapshotInsert[]): void {
    const statement = this.db.prepare(`
      INSERT INTO plan_quota_snapshots(
        target_id, plan_sync_id, console_account_id, credential_id,
        provider_type, plan_name, window_label, used, total, remaining, unit,
        plan_family,
        reset_at, raw_json, captured_at
      ) VALUES(
        @targetId, @planSyncId, @consoleAccountId, @credentialId,
        @providerType, @planName, @windowLabel, @used, @total, @remaining, @unit,
        @planFamily,
        @resetAt, @rawJson, @capturedAt
      )
    `);
    const insert = this.db.transaction(
      (rows: Array<Omit<PlanQuotaSnapshotRow, "id">>) => {
        for (const row of rows) statement.run(row);
      },
    );
    insert(input.map(row => ({
      ...row,
      planFamily: row.planFamily ?? null,
      remaining: row.remaining ?? null,
    })));
  }

  latestPlanQuota(
    targetId: string,
    credentialId: string | null,
    windowLabel: string,
  ): PlanQuotaSnapshotRow | undefined {
    return this.db.prepare(`
      SELECT ${PLAN_QUOTA_COLUMNS}
      FROM plan_quota_snapshots
      WHERE target_id = ? AND credential_id IS ? AND window_label = ?
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `).get(targetId, credentialId, windowLabel) as PlanQuotaSnapshotRow | undefined;
  }

  /** 每个套餐时间窗只返回最近一条，窗口数量和读取量均受 limit 约束。 */
  latestPlanQuotas(
    targetId: string,
    options: {credentialId?: string | null; limit?: number} = {},
  ): BoundedSyncRows<PlanQuotaSnapshotRow> {
    const safeLimit = boundedLimit(options.limit ?? 20);
    const credentialFilter = options.credentialId === undefined
      ? ""
      : "AND credential_id IS @credentialId";
    const params = {targetId, credentialId: options.credentialId ?? null};
    const rankedSql = `
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY credential_id, provider_type, COALESCE(plan_family, ''), window_label
          ORDER BY captured_at DESC, id DESC
        ) AS rowNumber
      FROM plan_quota_snapshots
      WHERE target_id = @targetId ${credentialFilter}
    `;
    const candidateCount = this.db.prepare(`
      SELECT COUNT(*) FROM (${rankedSql}) WHERE rowNumber = 1
    `).pluck().get(params) as number;
    const rows = this.db.prepare(`
      SELECT ${PLAN_QUOTA_COLUMNS}
      FROM (${rankedSql})
      WHERE rowNumber = 1
      ORDER BY captured_at DESC,
        CASE window_label WHEN '5h' THEN 0 WHEN 'weekly' THEN 1 WHEN 'monthly' THEN 2 ELSE 3 END,
        id DESC
      LIMIT @limit
    `).all({...params, limit: safeLimit + 1}) as PlanQuotaSnapshotRow[];
    return {
      items: rows.slice(0, safeLimit),
      candidateCount,
      processedCount: rows.length,
      limited: rows.length > safeLimit,
    };
  }

  insertBalance(input: Omit<BalanceSnapshotRow, "id">): void {
    this.db.prepare(`
      INSERT INTO balance_snapshots(
        target_id, console_account_id, provider_type, currency, amount,
        quota, used_quota, source, raw_json, captured_at
      ) VALUES(@targetId, @consoleAccountId, @providerType, @currency, @amount,
        @quota, @usedQuota, @source, @rawJson, @capturedAt)
    `).run(input);
  }

  latestBalance(targetId: string): BalanceSnapshotRow | undefined {
    return this.db.prepare(`
      SELECT ${BALANCE_COLUMNS}
      FROM balance_snapshots
      WHERE target_id = ?
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `).get(targetId) as BalanceSnapshotRow | undefined;
  }

  insertRates(input: Array<Omit<RateSnapshotRow, "id">>): void {
    const statement = this.db.prepare(`
      INSERT INTO credential_rate_snapshots(
        target_id, credential_id, token_group, ratio, source, captured_at
      ) VALUES(@targetId, @credentialId, @tokenGroup, @ratio, @source, @capturedAt)
    `);
    const insert = this.db.transaction((rows: Array<Omit<RateSnapshotRow, "id">>) => {
      for (const row of rows) statement.run(row);
    });
    insert(input);
  }

  latestRate(credentialId: string): RateSnapshotRow | undefined {
    return this.db.prepare(`
      SELECT ${RATE_COLUMNS}
      FROM credential_rate_snapshots
      WHERE credential_id = ?
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `).get(credentialId) as RateSnapshotRow | undefined;
  }

  insertSyncRun(input: Omit<SyncRunRow, "id">): void {
    this.db.prepare(`
      INSERT INTO sync_runs(
        console_account_id, target_id, status, mode, detail_json, started_at, finished_at
      ) VALUES(@consoleAccountId, @targetId, @status, @mode, @detailJson, @startedAt, @finishedAt)
    `).run(input);
  }

  latestSyncRuns(targetId: string, limit = 10): SyncRunRow[] {
    return this.db.prepare(`
      SELECT ${SYNC_RUN_COLUMNS}
      FROM sync_runs
      WHERE target_id = ?
      ORDER BY started_at DESC, id DESC
      LIMIT ?
    `).all(targetId, Math.min(Math.max(limit, 1), 50)) as SyncRunRow[];
  }

  /**
   * 最近一次成功同步的密钥远程对比结果（只读最新一条 ok run 的单行 detail_json）。
   *
   * 与 `latestSyncRuns(targetId, 10)` + 内存查找的区别：这里恒定只读取 1 行，
   * 侧栏/供应商卡这类「每个目标都要算一次」的只读入口才能保持有界。
   * `detail_json` 由同步结果序列化而来（含远端余额原始 JSON），正常在 KB 量级；
   * 仍设 256 KiB 防御上限，异常膨胀时诚实返回「无证据」而不是把它读进内存解析。
   */
  latestCredentialComparison(targetId: string): CredentialComparisonRow[] {
    const row = this.db.prepare(`
      SELECT detail_json AS detailJson
      FROM sync_runs
      WHERE target_id = ? AND status = 'ok'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get(targetId) as {detailJson: string} | undefined;
    if (!row?.detailJson || row.detailJson.length > SYNC_RUN_DETAIL_MAX_CHARS) return [];
    try {
      const parsed = JSON.parse(row.detailJson) as {credentialComparison?: unknown};
      if (!Array.isArray(parsed.credentialComparison)) return [];
      return parsed.credentialComparison
        .filter((item): item is CredentialComparisonRow => (
          Boolean(item) && typeof item === "object"
          && typeof (item as CredentialComparisonRow).credentialId === "string"
          && typeof (item as CredentialComparisonRow).label === "string"
          && typeof (item as CredentialComparisonRow).matched === "boolean"
        ))
        .map(item => ({
          credentialId: item.credentialId,
          label: item.label,
          matched: item.matched,
          ...(typeof item.remoteName === "string" ? {remoteName: item.remoteName} : {}),
          ...(typeof item.remoteKeyId === "string" && /^\d{1,16}$/u.test(item.remoteKeyId)
            ? {remoteKeyId: item.remoteKeyId} : {}),
          ...(typeof item.ratio === "number" && Number.isFinite(item.ratio) ? {ratio: item.ratio} : {}),
          ...(typeof item.reason === "string" ? {reason: item.reason} : {}),
        }));
    } catch {
      return [];
    }
  }

  /**
   * 到期待同步的控制台账号（调度器消费，一次最多 20 个）。
   * status=running 的账号视为执行中；仅当其 updated_at 超过 10 分钟未推进
   * （进程崩溃残留）才重新纳入调度，避免并发重复同步。
   */
  dueAccounts(nowIso: string, limit = 20): ConsoleAccountRow[] {
    const staleCutoff = new Date(new Date(nowIso).getTime() - 10 * 60_000).toISOString();
    return this.db.prepare(`
      SELECT ${CONSOLE_ACCOUNT_COLUMNS}
      FROM console_accounts
      WHERE next_sync_at IS NOT NULL AND next_sync_at <= ?
        AND (status != 'running' OR updated_at <= ?)
      ORDER BY next_sync_at ASC
      LIMIT ?
    `).all(nowIso, staleCutoff, Math.min(Math.max(limit, 1), 50)) as ConsoleAccountRow[];
  }

  /** 保留策略清理：余额/套餐 90 天、倍率与同步记录按每组固定上限。 */
  prune(nowIso: string): void {
    this.db.prepare(`
      DELETE FROM balance_snapshots
      WHERE captured_at < datetime(?, '-90 days')
    `).run(nowIso);
    this.db.prepare(`
      DELETE FROM plan_quota_snapshots
      WHERE captured_at < datetime(?, '-90 days')
    `).run(nowIso);
    this.db.prepare(`
      DELETE FROM reconciliation_windows
      WHERE created_at < datetime(?, '-90 days')
    `).run(nowIso);
    this.db.prepare(`
      DELETE FROM credential_rate_snapshots
      WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY credential_id ORDER BY captured_at DESC, id DESC
          ) AS rn FROM credential_rate_snapshots
        ) WHERE rn <= ?
      )
    `).run(RATE_RETENTION_PER_CREDENTIAL);
    this.db.prepare(`
      DELETE FROM sync_runs
      WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY target_id ORDER BY started_at DESC, id DESC
          ) AS rn FROM sync_runs
        ) WHERE rn <= ?
      )
    `).run(SYNC_RUN_RETENTION_PER_ACCOUNT);
  }
}

/** 保留策略常量导出，供测试断言。 */
export const SYNC_RETENTION = {
  balanceDays: BALANCE_RETENTION_DAYS,
  ratePerCredential: RATE_RETENTION_PER_CREDENTIAL,
  syncRunsPerAccount: SYNC_RUN_RETENTION_PER_ACCOUNT,
  planQuotaDays: PLAN_QUOTA_RETENTION_DAYS,
} as const;
