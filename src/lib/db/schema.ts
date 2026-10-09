import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";

export const SCHEMA_VERSION = 52;

/**
 * v19：Agent 证据字段。
 * raw_exchange_refs.wire_api 记录请求命中的真实 wire API（responses /
 * chat_completions / messages），供有界查询区分协议；agent_steps 增加
 * native_step_id / identity_source / identity_confidence，记录 Step 外部身份
 * 来源与置信度（OpenCode native-header/exact，dsh structural/high|medium|low）。
 * 只加 nullable 列，不建新索引、不扫描 raw、不重算历史账本；旧行三列保持 NULL。
 */
function migrateAgentIdentityEvidenceV19(db: DeepaaDatabase): void {
  if (hasTable(db, "raw_exchange_refs") && !hasColumn(db, "raw_exchange_refs", "wire_api")) {
    db.exec("ALTER TABLE raw_exchange_refs ADD COLUMN wire_api TEXT");
  }
  if (hasTable(db, "agent_steps") && !hasColumn(db, "agent_steps", "native_step_id")) {
    db.exec("ALTER TABLE agent_steps ADD COLUMN native_step_id TEXT");
  }
  if (hasTable(db, "agent_steps") && !hasColumn(db, "agent_steps", "identity_source")) {
    db.exec("ALTER TABLE agent_steps ADD COLUMN identity_source TEXT");
  }
  if (hasTable(db, "agent_steps") && !hasColumn(db, "agent_steps", "identity_confidence")) {
    db.exec("ALTER TABLE agent_steps ADD COLUMN identity_confidence TEXT");
  }
}

/**
 * v14：代理供应商控制台同步基础表。
 * console_accounts 只存脱敏引用与同步状态，用户名密码明文在
 * ~/.deepaa/config/console-credentials.json（0600）由 web 进程独占；
 * balance/rate 快照是低频小表，按时间索引查询并定期清理。
 */
const MIGRATION_13_TO_14_SQL = `
CREATE TABLE IF NOT EXISTS console_accounts (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL UNIQUE,
  provider_type TEXT NOT NULL,
  console_base_url TEXT NOT NULL,
  username TEXT NOT NULL,
  password_ref TEXT NOT NULL,
  login_mode TEXT NOT NULL DEFAULT 'http',
  status TEXT NOT NULL DEFAULT 'idle',
  last_sync_at TEXT,
  last_sync_error TEXT,
  consecutive_auto_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_failure_kind TEXT,
  next_sync_at TEXT,
  sync_interval_minutes INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_console_accounts_next_sync
  ON console_accounts(next_sync_at);

CREATE TABLE IF NOT EXISTS reconciliation_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  site_spend REAL NOT NULL,
  local_spend REAL NOT NULL,
  diff_amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL,
  ledger_exchange_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(target_id, window_end)
);
CREATE INDEX IF NOT EXISTS idx_reconciliation_windows_target
  ON reconciliation_windows(target_id, window_end DESC);

CREATE TABLE IF NOT EXISTS balance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id TEXT NOT NULL,
  console_account_id TEXT REFERENCES console_accounts(id),
  provider_type TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  amount REAL NOT NULL,
  quota REAL,
  used_quota REAL,
  source TEXT NOT NULL DEFAULT 'api',
  raw_json TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_target_time
  ON balance_snapshots(target_id, captured_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_captured
  ON balance_snapshots(captured_at);

CREATE TABLE IF NOT EXISTS credential_rate_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  token_group TEXT,
  ratio REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'auto_group',
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credential_rate_snapshots_cred_time
  ON credential_rate_snapshots(credential_id, captured_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_credential_rate_snapshots_target_time
  ON credential_rate_snapshots(target_id, captured_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  console_account_id TEXT REFERENCES console_accounts(id),
  target_id TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'http',
  detail_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_account_time
  ON sync_runs(console_account_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_target_time
  ON sync_runs(target_id, started_at DESC, id DESC);
`;

/**
 * v15：供应商级套餐同步配置与低频额度快照。
 * 配置只保存系统凭据引用；AK/SK/API Key 真值仍由 credential-helper 按需解析，
 * raw_json 只允许保存供应商返回的非敏感额度字段。
 */
const MIGRATION_14_TO_15_SQL = `
CREATE TABLE IF NOT EXISTS plan_sync_configs (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL UNIQUE,
  provider_type TEXT NOT NULL,
  credential_id TEXT,
  access_key_ref TEXT,
  secret_key_ref TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  last_sync_at TEXT,
  last_sync_error TEXT,
  consecutive_auto_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_failure_kind TEXT,
  next_sync_at TEXT,
  sync_interval_minutes INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_sync_configs_next_sync
  ON plan_sync_configs(next_sync_at);

CREATE TABLE IF NOT EXISTS plan_quota_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id TEXT NOT NULL,
  plan_sync_id TEXT REFERENCES plan_sync_configs(id),
  console_account_id TEXT REFERENCES console_accounts(id),
  credential_id TEXT,
  provider_type TEXT NOT NULL,
  plan_family TEXT,
  plan_name TEXT,
  window_label TEXT NOT NULL,
  used REAL,
  total REAL,
  remaining REAL,
  unit TEXT,
  reset_at TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_quota_target_time
  ON plan_quota_snapshots(target_id, captured_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_plan_quota_credential_time
  ON plan_quota_snapshots(credential_id, captured_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_plan_quota_lookup
  ON plan_quota_snapshots(
    target_id, credential_id, window_label, captured_at DESC, id DESC
  );
`;

/**
 * v16：usage_ledger 补齐每次请求的基础计费字段。
 * reasoning_tokens 用于推理模型计费分析，total_tokens 与响应 usage 对齐，
 * currency 显式记录原始币种（不做换算），避免历史数据把 CNY 当 USD。
 * 早期测试/开发库可能不含 usage_ledger，必须按列幂等补列。
 */
function migrateUsageLedgerBaseFields(db: DeepaaDatabase): void {
  if (!hasTable(db, "usage_ledger")) return;
  if (!hasColumn(db, "usage_ledger", "reasoning_tokens")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn(db, "usage_ledger", "total_tokens")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0");
  }
  /* 2026-09-05 四层分离：人民币口径物化列 + 写入时锁定的结算系数。
     存量回填=原值（历史账本数字本就是人民币口径），fx=1，不重算历史。 */
  if (!hasColumn(db, "usage_ledger", "vendor_cost_cny")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN vendor_cost_cny REAL");
    db.exec("UPDATE usage_ledger SET vendor_cost_cny = vendor_cost WHERE vendor_cost_cny IS NULL");
  }
  if (!hasColumn(db, "usage_ledger", "actual_cost_cny")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN actual_cost_cny REAL");
    db.exec("UPDATE usage_ledger SET actual_cost_cny = actual_cost WHERE actual_cost_cny IS NULL");
  }
  if (!hasColumn(db, "usage_ledger", "fx_rate_to_cny")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN fx_rate_to_cny REAL NOT NULL DEFAULT 1");
  }
  if (!hasColumn(db, "usage_ledger", "currency")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'");
  }
}

/**
 * v17：usage_ledger 记录每次请求的计费通道与供应商族，支撑按通道统计（B 方案）。
 * 旧行保持 NULL；供应商元数据后续变更不重算历史账本。
 */
function migrateUsageLedgerChannelFields(db: DeepaaDatabase): void {
  if (!hasTable(db, "usage_ledger")) return;
  if (!hasColumn(db, "usage_ledger", "billing_channel")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN billing_channel TEXT");
  }
  if (!hasColumn(db, "usage_ledger", "vendor_family")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN vendor_family TEXT");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_billing_channel
    ON usage_ledger(billing_channel, created_at DESC, exchange_id DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_vendor_family
    ON usage_ledger(vendor_family, created_at DESC, exchange_id DESC)`);
}

/**
 * v18：usage_ledger 记录每次请求的套餐积分折算，支撑套餐维度统计。
 * 旧行保持 NULL；历史账本不重算。
 */
function migrateUsageLedgerPlanCreditFields(db: DeepaaDatabase): void {
  if (!hasTable(db, "usage_ledger")) return;
  if (!hasColumn(db, "usage_ledger", "plan_credit_cost")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN plan_credit_cost REAL");
  }
  if (!hasColumn(db, "usage_ledger", "plan_credit_unit")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN plan_credit_unit TEXT");
  }
  if (!hasColumn(db, "usage_ledger", "plan_credit_formula_version")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN plan_credit_formula_version TEXT");
  }
}

/**
 * v20：冻结请求级分析账本契约，并建立可重建的小时事实与独立 Analytics Worker 状态。
 * 迁移只增加 nullable/default 列和空表/索引，不扫描 raw、不重算历史账本。
 */
function migrateAnalyticsAuditV20(db: DeepaaDatabase): void {
  if (hasTable(db, "usage_ledger")) {
    const columns: Array<[string, string]> = [
      ["request_kind", "TEXT NOT NULL DEFAULT 'model'"],
      ["result_class", "TEXT NOT NULL DEFAULT 'unknown'"],
      ["usage_quality", "TEXT NOT NULL DEFAULT 'unavailable'"],
      ["pricing_status", "TEXT NOT NULL DEFAULT 'not_applicable'"],
      ["audit_eligible", "INTEGER NOT NULL DEFAULT 0"],
      ["audit_exclusion_reason", "TEXT"],
      ["derived_total_tokens", "INTEGER"],
      ["provider_total_tokens", "INTEGER"],
      ["total_tokens_basis", "TEXT NOT NULL DEFAULT 'legacy_unknown'"],
      ["reasoning_semantics", "TEXT NOT NULL DEFAULT 'output_subset'"],
      ["reference_price_entry_id", "TEXT"],
      ["reference_cost_nano", "INTEGER"],
      ["reference_currency", "TEXT"],
      ["reference_cost_status", "TEXT NOT NULL DEFAULT 'unavailable'"],
      ["cost_basis", "TEXT NOT NULL DEFAULT 'unavailable'"],
      ["pricing_revision_id", "INTEGER"],
      ["price_effective_at", "TEXT"],
      ["catalog_hash", "TEXT"],
      ["vendor_cost_nano", "INTEGER"],
      ["actual_cost_nano", "INTEGER"],
      ["money_scale", "INTEGER NOT NULL DEFAULT 9"],
      ["latency_source", "TEXT NOT NULL DEFAULT 'round_trip'"],
      ["duration_sample_eligible", "INTEGER NOT NULL DEFAULT 1"],
      ["ledger_version", "INTEGER NOT NULL DEFAULT 1"],
      ["token_semantics_version", "INTEGER NOT NULL DEFAULT 1"],
      ["projection_version", "INTEGER NOT NULL DEFAULT 4"],
    ];
    for (const [name, definition] of columns) {
      if (!hasColumn(db, "usage_ledger", name)) {
        db.exec(`ALTER TABLE usage_ledger ADD COLUMN ${name} ${definition}`);
      }
    }
    db.exec(`
      DROP INDEX IF EXISTS idx_usage_analytics_dimensions;
      CREATE INDEX IF NOT EXISTS idx_usage_analytics_time
        ON usage_ledger(created_at, target_id, agent_name, model, exchange_id);
      CREATE INDEX IF NOT EXISTS idx_usage_analytics_dimensions
        ON usage_ledger(created_at, agent_name, vendor, vendor_family, billing_channel, model);
      CREATE INDEX IF NOT EXISTS idx_usage_analytics_quality
        ON usage_ledger(created_at, usage_quality, pricing_status, result_class);
    `);
  }
  db.exec(ANALYTICS_TABLES_SQL);
}

/**
 * v21：usage_ledger 记录每次请求的首字时间（转发开始到首个上游响应 chunk 的毫秒数）。
 * 旧行与旧 raw 保持 NULL（无法事后补算）；历史账本不重算。
 */
function migrateUsageLedgerFirstTokenMs(db: DeepaaDatabase): void {
  if (!hasTable(db, "usage_ledger")) return;
  if (!hasColumn(db, "usage_ledger", "first_token_ms")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN first_token_ms INTEGER");
  }
}

/**
 * v22：控制台账号与套餐同步配置支持按供应商自定义同步周期（分钟）。
 * 存量行由列默认值回填 30 分钟保持既有节奏；新保存默认 5 分钟由服务层控制。
 */
function migrateSyncIntervalMinutesV22(db: DeepaaDatabase): void {
  for (const table of ["console_accounts", "plan_sync_configs"]) {
    if (!hasTable(db, table)) continue;
    if (!hasColumn(db, table, "sync_interval_minutes")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN sync_interval_minutes INTEGER NOT NULL DEFAULT 30`);
    }
  }
}

/**
 * v40（2026-09-20）：控制台账号与套餐同步的连续自动失败计数。
 * 只在自动链路失败时 +1、任何一次成功清零（服务层控制）；存量行默认 0。
 * 供供应商列表「同步失败」红标按「连续两次自动失败」判定（target-health-badge）。
 */
function migrateSyncConsecutiveFailuresV40(db: DeepaaDatabase): void {
  for (const table of ["console_accounts", "plan_sync_configs"]) {
    if (!hasTable(db, table)) continue;
    if (!hasColumn(db, table, "consecutive_auto_failures")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN consecutive_auto_failures INTEGER NOT NULL DEFAULT 0`);
    }
  }
}

/**
 * v41（2026-09-20）：连续失败计数附带的失败类别。
 * 「连续两次才亮」只是默认场景：凭证/鉴权类失败（auth）基本会持续失败且需要
 * 尽快人工介入，一次即亮（target-health-badge 的门槛策略表按类别取门槛）。
 * nullable：成功清零 / 从未失败时为 NULL；读取端对未知类别回退默认门槛。
 */
function migrateSyncConsecutiveFailureKindV41(db: DeepaaDatabase): void {
  for (const table of ["console_accounts", "plan_sync_configs"]) {
    if (!hasTable(db, table)) continue;
    if (!hasColumn(db, table, "consecutive_failure_kind")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN consecutive_failure_kind TEXT`);
    }
  }
}

/**
 * v23：套餐时间窗保留供应商返回的原始剩余额度。
 * 只增加 nullable 列，不扫描旧快照，也不重算历史账本。
 */
function migratePlanQuotaRemainingV23(db: DeepaaDatabase): void {
  if (!hasTable(db, "plan_quota_snapshots")) return;
  if (!hasColumn(db, "plan_quota_snapshots", "remaining")) {
    db.exec("ALTER TABLE plan_quota_snapshots ADD COLUMN remaining REAL");
  }
}

/**
 * v24：账本记录请求携带的 service_tier 计费参数（priority/flex/fast）。
 * 只增加 nullable 列；历史行不回填，乘数计价只对之后的新请求生效。
 */
/**
 * v25：官方目录更新通知历史表（2026-09-10 用户决策）。
 * 每次目录同步（小时任务 / 启动 / 价格中心手动触发）把「有变化的模型 Diff」落一行，
 * 供右上角通知栏做列表化查询（版本号/时间/摘要/已阅状态 + 分页 + 筛选）。
 * 与价格中心 JSON 解耦：避免逐字段 Diff 文本撑大 model-pricing.json（8 MiB 上限）；
 * 只增不改、有界保留（由写入端按 200 版裁剪）。items_json 由写入端做条数与长度上限。
 */
const CATALOG_NOTIFICATIONS_V25_SQL = `
CREATE TABLE IF NOT EXISTS catalog_update_notifications (
  catalog_revision TEXT PRIMARY KEY,
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acked_at TEXT,
  effective_from TEXT,
  summary TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  in_use_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'official_preset',
  items_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_catalog_notifications_time
  ON catalog_update_notifications(published_at DESC, catalog_revision DESC);
CREATE INDEX IF NOT EXISTS idx_catalog_notifications_acked
  ON catalog_update_notifications(acked_at, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_catalog_notifications_source
  ON catalog_update_notifications(source, published_at DESC);
`;

function migrateCatalogUpdateNotificationsV25(db: DeepaaDatabase): void {
  db.exec(CATALOG_NOTIFICATIONS_V25_SQL);
}

/**
 * v26：变更来源列（2026-09-10 用户决策）——通知表升级为「模型价格变动通知」聚合表：
 * official_preset（官方预设，版本号 = catalogRevision）/ manual_override（人工覆盖）/
 * litellm_auto（LiteLLM 自动导入，仅记录未被官方或人工覆盖且正在使用的模型）。
 * 人工与 LiteLLM 变更只作流水记录，不影响官方目录映射与目标排序。
 */
function migrateCatalogNotificationSourceV26(db: DeepaaDatabase): void {
  if (hasTable(db, "catalog_update_notifications") && !hasColumn(db, "catalog_update_notifications", "source")) {
    db.exec("ALTER TABLE catalog_update_notifications ADD COLUMN source TEXT NOT NULL DEFAULT 'official_preset'");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_notifications_source
    ON catalog_update_notifications(source, published_at DESC)`);
}

/**
 * v42：官方目录同步后置效果任务。
 * 价格中心写入与效果入队同事务；通知、wire API 物化、CLI 同步和价格版本记录
 * 失败后可按 next_retry_at 重试，不因 catalogSync marker 已前进而永久丢失。
 */
const CATALOG_SYNC_EFFECTS_V42_SQL = `
CREATE TABLE IF NOT EXISTS catalog_sync_effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalog_revision TEXT NOT NULL,
  catalog_hash TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  target_id TEXT,
  agent_id TEXT,
  model_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  locked_by TEXT,
  next_retry_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(catalog_revision, catalog_hash, effect_type, target_id, agent_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_catalog_sync_effects_due
  ON catalog_sync_effects(status, next_retry_at, id);
CREATE INDEX IF NOT EXISTS idx_catalog_sync_effects_revision
  ON catalog_sync_effects(catalog_revision, catalog_hash, effect_type);
`;

function migrateCatalogSyncEffectsV42(db: DeepaaDatabase): void {
  db.exec(CATALOG_SYNC_EFFECTS_V42_SQL);
}

/** v43：官方目录当前推荐集合独立索引；历史价格中心条目不因目录移除而删除。 */
const OFFICIAL_CATALOG_MEMBERSHIP_V43_SQL = `
CREATE TABLE IF NOT EXISTS official_catalog_membership (
  catalog_key TEXT NOT NULL,
  pricing_provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  current_official INTEGER NOT NULL DEFAULT 1,
  first_seen_revision TEXT NOT NULL,
  last_seen_revision TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(catalog_key, model_id)
);
CREATE INDEX IF NOT EXISTS idx_official_catalog_membership_current
  ON official_catalog_membership(catalog_key, current_official, model_id);
CREATE INDEX IF NOT EXISTS idx_official_catalog_membership_identity
  ON official_catalog_membership(pricing_provider_id, model_id, current_official);
`;

function migrateOfficialCatalogMembershipV43(db: DeepaaDatabase): void {
  db.exec(OFFICIAL_CATALOG_MEMBERSHIP_V43_SQL);
}

/** v44：官方/LiteLLM 来源底稿；只服务取消手工覆盖，不参与实时计价。 */
const PRICING_SOURCE_BASELINES_V44_SQL = `
CREATE TABLE IF NOT EXISTS pricing_source_baselines (
  vendor TEXT NOT NULL,
  runtime_model_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('official', 'litellm')),
  source_revision TEXT,
  source_hash TEXT,
  captured_at TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(vendor, runtime_model_id, source_kind)
);
CREATE INDEX IF NOT EXISTS idx_pricing_source_baselines_identity
  ON pricing_source_baselines(vendor, runtime_model_id, source_kind, captured_at DESC);
`;

function migratePricingSourceBaselinesV44(db: DeepaaDatabase): void {
  db.exec(PRICING_SOURCE_BASELINES_V44_SQL);
}

/**
 * v52（2026-10-09 额度差分估算水位线制）：每 (target, 锚窗) 一行的「已结算基线」游标。
 * 记录最近一次成功消费到的快照批（captured_at/used/reset_at/total），保证同一差分段
 * 绝不被重复分摊（派生钩子与低频定时复跑安全幂等），也承载窗口 reset 过渡的开周期基线。
 * 只增表，不触碰账本与聚合。
 */
const PLAN_ESTIMATE_SETTLEMENTS_V52_SQL = `
CREATE TABLE IF NOT EXISTS plan_estimate_settlements (
  target_id TEXT NOT NULL,
  window_label TEXT NOT NULL,
  baseline_captured_at TEXT NOT NULL,
  baseline_used REAL NOT NULL,
  baseline_total REAL NOT NULL,
  baseline_reset_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target_id, window_label)
);`;

/**
 * v45：中转站小时对账独立于旧五分钟窗口。只保存有界金额和计数证据，
 * 不存完整站点响应或真实凭据；历史账本与旧窗口一律不回算。
 */
const RELAY_RECONCILIATION_V45_SQL = `
CREATE TABLE IF NOT EXISTS relay_pending_ingestions (
  exchange_id TEXT PRIMARY KEY REFERENCES ingestion_records(exchange_id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  completed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relay_pending_ingestions_hour
  ON relay_pending_ingestions(target_id, completed_at, exchange_id);
CREATE TABLE IF NOT EXISTS relay_local_usage_events (
  exchange_id TEXT PRIMARY KEY REFERENCES usage_ledger(exchange_id),
  target_id TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  provider_request_id TEXT,
  endpoint TEXT
);
CREATE INDEX IF NOT EXISTS idx_relay_local_usage_hour
  ON relay_local_usage_events(target_id, completed_at, exchange_id);
CREATE TABLE IF NOT EXISTS relay_reconciliation_hours (
  target_id TEXT NOT NULL,
  hour_start_utc TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK(provider_type IN ('sub2api', 'newapi')),
  console_account_id TEXT NOT NULL,
  console_identity_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'incomplete', 'balanced', 'needs_review', 'applied', 'ignored')),
  site_amount_nano INTEGER,
  site_evidence_hash TEXT,
  site_light_check TEXT,
  local_amount_nano INTEGER,
  applied_amount_nano INTEGER NOT NULL DEFAULT 0,
  manual_revision INTEGER NOT NULL DEFAULT 0,
  residual_revision INTEGER NOT NULL DEFAULT 0,
  residual_applied_nano INTEGER NOT NULL DEFAULT 0,
  residual_nano INTEGER,
  site_source TEXT,
  site_candidate_count INTEGER NOT NULL DEFAULT 0,
  site_processed_count INTEGER NOT NULL DEFAULT 0,
  site_limited INTEGER NOT NULL DEFAULT 0,
  site_details_complete INTEGER NOT NULL DEFAULT 0,
  local_candidate_count INTEGER NOT NULL DEFAULT 0,
  local_processed_count INTEGER NOT NULL DEFAULT 0,
  local_limited INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  unmatched_site_count INTEGER NOT NULL DEFAULT 0,
  first_site_amount_nano INTEGER,
  last_site_observed_at TEXT,
  stable_count INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  reason TEXT,
  ignored_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(target_id, hour_start_utc)
);
CREATE INDEX IF NOT EXISTS idx_relay_reconciliation_due
  ON relay_reconciliation_hours(status, last_checked_at, hour_start_utc);
CREATE INDEX IF NOT EXISTS idx_relay_reconciliation_target
  ON relay_reconciliation_hours(target_id, hour_start_utc DESC);
CREATE TABLE IF NOT EXISTS relay_reconciliation_matches (
  target_id TEXT NOT NULL,
  hour_start_utc TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  site_log_id TEXT NOT NULL,
  exchange_id TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK(confidence IN ('exact', 'high', 'weak')),
  site_amount_nano INTEGER NOT NULL,
  local_amount_nano INTEGER NOT NULL,
  adjustment_nano INTEGER NOT NULL,
  adjustment_exchange_id TEXT,
  site_discount_nano INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  usage_carrier INTEGER NOT NULL DEFAULT 0,
  site_input_tokens INTEGER,
  site_cache_read_tokens INTEGER,
  site_cache_write_tokens INTEGER,
  site_output_tokens INTEGER,
  site_duration_ms INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY(target_id, provider_type, site_log_id),
  UNIQUE(exchange_id),
  FOREIGN KEY(target_id, hour_start_utc)
    REFERENCES relay_reconciliation_hours(target_id, hour_start_utc)
);
CREATE INDEX IF NOT EXISTS idx_relay_reconciliation_matches_hour
  ON relay_reconciliation_matches(target_id, hour_start_utc);
CREATE INDEX IF NOT EXISTS idx_relay_reconciliation_matches_adjustment
  ON relay_reconciliation_matches(adjustment_exchange_id);
`;

function migrateRelayReconciliationV45(db: DeepaaDatabase): void {
  if (hasTable(db, "schema_meta") && !hasColumn(db, "schema_meta", "last_source_scan_completed_at")) {
    db.exec("ALTER TABLE schema_meta ADD COLUMN last_source_scan_completed_at TEXT");
  }
  db.exec(RELAY_RECONCILIATION_V45_SQL);
}

/**
 * v46：对账健壮性与弱匹配（2026-09-26 用户确认）。
 * - relay_site_backoff：站点连续失败指数退避（5→15→30→60 分钟封顶），
 *   防止 incomplete 小时 × 固定 5 分钟重试形成登录风暴（catapi 实测自锁）。
 * - relay_reconciliation_hours.site_light_check：已定稿小时轻量复查键
 *   （new-api stat quota / sub2api 日总数），键未变时跳过明细重拉。
 * - relay_reconciliation_matches 的 confidence 增加 'weak'（模型+端点+时间唯一/
 *   等量保序归属，不使用估算 Token），CHECK 变更需整表重建（表小、无外部引用）。
 */
const RELAY_RECONCILIATION_V46_SQL = `
CREATE TABLE IF NOT EXISTS relay_site_backoff (
  target_id TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  retry_after TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
`;

const RELAY_RECONCILIATION_MATCHES_V46_SQL = `
CREATE TABLE relay_reconciliation_matches_v46 (
  target_id TEXT NOT NULL,
  hour_start_utc TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  site_log_id TEXT NOT NULL,
  exchange_id TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK(confidence IN ('exact', 'high', 'weak')),
  site_amount_nano INTEGER NOT NULL,
  local_amount_nano INTEGER NOT NULL,
  adjustment_nano INTEGER NOT NULL,
  adjustment_exchange_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY(target_id, provider_type, site_log_id),
  UNIQUE(exchange_id),
  FOREIGN KEY(target_id, hour_start_utc)
    REFERENCES relay_reconciliation_hours(target_id, hour_start_utc)
);
INSERT INTO relay_reconciliation_matches_v46(
  target_id,hour_start_utc,provider_type,site_log_id,exchange_id,confidence,
  site_amount_nano,local_amount_nano,adjustment_nano,adjustment_exchange_id,
  revision,created_at
)
SELECT target_id,hour_start_utc,provider_type,site_log_id,exchange_id,confidence,
  site_amount_nano,local_amount_nano,adjustment_nano,adjustment_exchange_id,
  revision,created_at
FROM relay_reconciliation_matches;
DROP TABLE relay_reconciliation_matches;
ALTER TABLE relay_reconciliation_matches_v46 RENAME TO relay_reconciliation_matches;
CREATE INDEX IF NOT EXISTS idx_relay_reconciliation_matches_hour
  ON relay_reconciliation_matches(target_id, hour_start_utc);
`;

function migrateRelayReconciliationV46(db: DeepaaDatabase): void {
  if (hasTable(db, "relay_reconciliation_hours")
    && !hasColumn(db, "relay_reconciliation_hours", "site_light_check")) {
    db.exec("ALTER TABLE relay_reconciliation_hours ADD COLUMN site_light_check TEXT");
  }
  db.exec(RELAY_RECONCILIATION_V46_SQL);
  const matchTable = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='relay_reconciliation_matches'",
  ).get() as {sql: string} | undefined;
  if (matchTable && !matchTable.sql.includes("'weak'")) {
    db.exec(RELAY_RECONCILIATION_MATCHES_V46_SQL);
  }
}

/**
 * v47：对账折扣证据列 + 补差行挂靠索引（2026-09-28 用户确认）。
 * - relay_reconciliation_matches.site_discount_nano：站点明细明示的折扣节省额
 *   （sub2api fork 的 night_discount_saved_amount，仅 applied=true 且为非负有限数时写入；
 *   上游 sub2api 与 new-api 无该字段，恒 NULL）。归因展示仅当该值 ≈ |adjustment_nano|
 *   （±2 nano）才标注，禁止任何基于比率巧合的推断。
 * - idx_relay_reconciliation_matches_adjustment：Token 价格页 step 级筛选命中补差行的
 *   EXISTS 子查询需要按 adjustment_exchange_id 命中索引。
 */
function migrateRelayReconciliationDiscountV47(db: DeepaaDatabase): void {
  if (!hasTable(db, "relay_reconciliation_matches")) return;
  if (!hasColumn(db, "relay_reconciliation_matches", "site_discount_nano")) {
    db.exec("ALTER TABLE relay_reconciliation_matches ADD COLUMN site_discount_nano INTEGER");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relay_reconciliation_matches_adjustment
    ON relay_reconciliation_matches(adjustment_exchange_id)`);
}

/**
 * v48：小时残差自动补（2026-09-28 用户确认，取代「小时未解释残差不自动补」）。
 * - relay_reconciliation_hours.residual_revision / residual_applied_nano：小时残差
 *   自动补的幂等序号与累计金额。补差行 uniqueKey 用 `${hourStartUtc}:residual:${rev}`，
 *   站点迟到变化重开小时后再次自动补只追加新行，绝不覆盖或重复旧行；已补偿过的
 *   站点行在新一轮匹配里仍是 unmatched，资格判定用恒等式
 *   `残差 = 未匹配站点行金额之和 − residual_applied_nano`。
 */
function migrateRelayReconciliationResidualV48(db: DeepaaDatabase): void {
  if (hasTable(db, "relay_reconciliation_hours")) {
    if (!hasColumn(db, "relay_reconciliation_hours", "residual_revision")) {
      db.exec(
        "ALTER TABLE relay_reconciliation_hours ADD COLUMN residual_revision INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!hasColumn(db, "relay_reconciliation_hours", "residual_applied_nano")) {
      db.exec(
        "ALTER TABLE relay_reconciliation_hours ADD COLUMN residual_applied_nano INTEGER NOT NULL DEFAULT 0",
      );
    }
  }
}

/**
 * v50：精准补差行升级为「用量载体」（2026-09-29 用户确认）。
 * - relay_reconciliation_matches.usage_carrier：原行无可信用量（失败/取消且估算类，
 *   本地金额为 0）且站点明细提供 token 时置 1；该标记是聚合端「取代语义」的唯一依据
 *   （ledger-cost-exprs.ts 共享表达式：载体行计入请求/Token，被取代原行排他）。
 * - site_input/cache_read/cache_write/output_tokens + site_duration_ms：站点逐条 token
 *   证据持久化（此前只在内存中参与匹配后丢弃）；只对新匹配生效，存量行保持 NULL/0
 *   （2026-09-29 用户确认不回填历史）。
 */
function migrateRelayReconciliationUsageCarrierV50(db: DeepaaDatabase): void {
  if (!hasTable(db, "relay_reconciliation_matches")) return;
  if (!hasColumn(db, "relay_reconciliation_matches", "usage_carrier")) {
    db.exec(
      "ALTER TABLE relay_reconciliation_matches ADD COLUMN usage_carrier INTEGER NOT NULL DEFAULT 0",
    );
  }
  for (const column of [
    "site_input_tokens", "site_cache_read_tokens",
    "site_cache_write_tokens", "site_output_tokens", "site_duration_ms",
  ] as const) {
    if (!hasColumn(db, "relay_reconciliation_matches", column)) {
      db.exec(`ALTER TABLE relay_reconciliation_matches ADD COLUMN ${column} INTEGER`);
    }
  }
}

/**
 * v27：Harness 证据层（2026-09-11 用户确认，docs/Harness能力建设一期.md §4）。
 * - harness_snapshots：内容寻址快照（身份 = 名称级 tools+skills+rules 指纹），同清单只存一行；
 *   各 JSON 由写入端做 64 KiB 有界截断并置 complete=0。
 * - agent_steps 增列 harness_snapshot_hash / project_key（可空，存量不回填，由回填任务推进）。
 * - harness_backfill_state：Tier A 历史回填的游标与完成标记（单行）。
 * 只增表增列，不触碰账本与聚合。
 */
const HARNESS_SNAPSHOTS_V27_SQL = `
CREATE TABLE IF NOT EXISTS harness_snapshots (
  snapshot_hash TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  tool_count INTEGER NOT NULL DEFAULT 0,
  mcp_tool_count INTEGER NOT NULL DEFAULT 0,
  mcp_server_count INTEGER NOT NULL DEFAULT 0,
  skill_count INTEGER NOT NULL DEFAULT 0,
  rule_count INTEGER NOT NULL DEFAULT 0,
  tools_json TEXT NOT NULL DEFAULT '[]',
  skills_json TEXT NOT NULL DEFAULT '[]',
  rules_json TEXT NOT NULL DEFAULT '[]',
  complete INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  step_ref_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_harness_snapshots_agent
  ON harness_snapshots(agent_name, last_seen_at);
CREATE TABLE IF NOT EXISTS harness_backfill_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_step_rowid INTEGER,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
`;

/**
 * v32（2026-09-15 双链路观测）：Agent 官方直连本地导入的 per-agent 导入状态。
 * 游标水位为 zcode 侧 keyset（last_started_at + last_id）；floor 重置与跳过计数
 * 支撑「回看上限 30 天」语义的可观测性；本地 schema 版本快照用于漂移降级。
 */
const AGENT_LOCAL_IMPORT_V32_SQL = `
CREATE TABLE IF NOT EXISTS agent_local_import_state (
  agent_name TEXT PRIMARY KEY,
  last_started_at INTEGER,
  last_record_id TEXT,
  backfill_last_completed_at INTEGER,
  backfill_last_record_id TEXT,
  backfill_finished_at TEXT,
  cursor_reset_count INTEGER NOT NULL DEFAULT 0,
  skipped_older_than_window INTEGER NOT NULL DEFAULT 0,
  skipped_model_not_provisioned INTEGER NOT NULL DEFAULT 0,
  local_schema_version TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  imported_count INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  last_run_started_at TEXT,
  last_run_duration_ms INTEGER,
  last_run_count INTEGER,
  updated_at TEXT NOT NULL
);
`;

/**
 * v34（2026-09-16）：导入即记 seen（先于派生）——pending 反联依据。若反联用
 * raw_exchange_refs（派生时才写），导入与派生之间的窗口会让同一批行被 5 秒节奏
 * 反复重写成合成行（文件膨胀 + 计数虚高）。exchange_id 与导入行确定性对应，
 * 重置重导脚本清空本表即可全量重放。
 */
const AGENT_LOCAL_IMPORT_SEEN_V34_SQL = `
CREATE TABLE IF NOT EXISTS agent_local_import_seen (
  exchange_id TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL
);
`;

/**
 * v36（2026-09-17 用户确认）：
 * ① `agent_prompt_skeletons`——本地导入链路的请求骨架（system + tools）缓存。
 *    Agent 客户端的 model-io 记录是滚动窗口（zcode 单文件 64MiB / 每目录 3 个文件），
 *    骨架取不到时合成的请求体只剩 model+messages，页面上表现为「系统提示与工具定义
 *    凭空新增/整体缺失」。首见即存 + 会话级复用后，无需用户改任何客户端设置。
 * ② `idx_raw_captured`——交互内容页全局（不限 session/thread/turn）按时间倒序的
 *    keyset 分页索引。此前只有 (capture_session_id, ...) 与 (origin, ...) 两个复合索引，
 *    无范围查询会退化为全表扫描 + TEMP B-TREE 排序。
 */
const AGENT_PROMPT_SKELETONS_V36_SQL = `
CREATE TABLE IF NOT EXISTS agent_prompt_skeletons (
  skeleton_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  model_id TEXT,
  provider_id TEXT,
  body_json TEXT NOT NULL,
  tool_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_prompt_skeletons_session
  ON agent_prompt_skeletons(agent_id, session_id, last_seen_at DESC);
`;

const RAW_EXCHANGE_CAPTURED_INDEX_V36_SQL = `
CREATE INDEX IF NOT EXISTS idx_raw_captured
  ON raw_exchange_refs(captured_at DESC, exchange_id DESC);
`;

const AGENT_LOCAL_IDENTITY_LINKS_V37_SQL = `
CREATE TABLE IF NOT EXISTS agent_local_identity_links (
  response_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  external_session_id TEXT NOT NULL,
  parent_external_session_id TEXT,
  root_external_session_id TEXT,
  turn_number INTEGER,
  step_number INTEGER,
  delegation_depth INTEGER,
  model_id TEXT,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_local_identity_links_session
  ON agent_local_identity_links(agent_name, external_session_id);
`;

function migrateAgentLocalIdentityLinksV37(db: DeepaaDatabase): void {
  db.exec(AGENT_LOCAL_IDENTITY_LINKS_V37_SQL);
}

/** v39（2026-09-17 用户确认）：存量重投影机制整体移除——版本号只标记当前派生
 * 版本，新登记行直接按当前版本派生、存量保持原样。本迁移一次性回收已入队的
 * 残留重投影任务（pending/retry_wait 且其 raw ref 已存在＝已派生过的存量行）；
 * raw ref 不存在的新登记任务（正常待派生）不受影响。
 */
function migrateRetireReprojectionJobsV39(db: DeepaaDatabase): void {
  // 守卫：真实旧版库的逐步迁移路径可能尚未建 derivation_jobs（建表步骤在更晚
  // 的迁移段），缺表即无事可回收。
  if (!hasTable(db, "derivation_jobs")) return;
  db.exec(`
    DELETE FROM derivation_jobs
    WHERE job_status IN ('pending', 'retry_wait')
      AND EXISTS(
        SELECT 1
        FROM ingestion_records ir
        JOIN raw_exchange_refs r ON r.exchange_id = ir.exchange_id
        WHERE ir.id = derivation_jobs.ingestion_record_id
      )
  `);
}

/** v38（2026-09-17）：身份标注补顶层祖先列——dsh 子代理（depth 可达 2+）按 root 折叠。 */
function migrateAgentLocalIdentityLinksRootV38(db: DeepaaDatabase): void {
  db.exec(AGENT_LOCAL_IDENTITY_LINKS_V37_SQL);
  if (hasTable(db, "agent_local_identity_links")
    && !hasColumn(db, "agent_local_identity_links", "root_external_session_id")) {
    db.exec("ALTER TABLE agent_local_identity_links ADD COLUMN root_external_session_id TEXT");
  }
}

function migratePromptSkeletonsV36(db: DeepaaDatabase): void {
  db.exec(AGENT_PROMPT_SKELETONS_V36_SQL);
}

function migrateExportGlobalTimeIndexV36(db: DeepaaDatabase): void {
  if (!hasTable(db, "raw_exchange_refs")) return;
  db.exec(RAW_EXCHANGE_CAPTURED_INDEX_V36_SQL);
}

function migrateAgentLocalImportSeenV34(db: DeepaaDatabase): void {
  db.exec(AGENT_LOCAL_IMPORT_SEEN_V34_SQL);
}

/** v33（2026-09-16 用户确认「最新优先」）：两阶段水位——新到尾追高水位 + 历史倒序回补游标。 */
function migrateAgentLocalImportBackfillV33(db: DeepaaDatabase): void {
  if (hasTable(db, "agent_local_import_state")) {
    if (!hasColumn(db, "agent_local_import_state", "backfill_last_completed_at")) {
      db.exec("ALTER TABLE agent_local_import_state ADD COLUMN backfill_last_completed_at INTEGER");
    }
    if (!hasColumn(db, "agent_local_import_state", "backfill_last_record_id")) {
      db.exec("ALTER TABLE agent_local_import_state ADD COLUMN backfill_last_record_id TEXT");
    }
    if (!hasColumn(db, "agent_local_import_state", "backfill_finished_at")) {
      db.exec("ALTER TABLE agent_local_import_state ADD COLUMN backfill_finished_at TEXT");
    }
  }
}

function migrateAgentLocalImportV32(db: DeepaaDatabase): void {
  if (hasTable(db, "raw_exchange_refs") && !hasColumn(db, "raw_exchange_refs", "origin")) {
    db.exec(`ALTER TABLE raw_exchange_refs ADD COLUMN origin TEXT NOT NULL DEFAULT 'gateway'
      CHECK (origin IN ('gateway', 'agent_local_import'))`);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_raw_origin
        ON raw_exchange_refs(origin, captured_at DESC, exchange_id DESC);
    `);
  }
  db.exec(AGENT_LOCAL_IMPORT_V32_SQL);
}

function migrateHarnessEvidenceV27(db: DeepaaDatabase): void {
  db.exec(HARNESS_SNAPSHOTS_V27_SQL);
  if (hasTable(db, "agent_steps")) {
    if (!hasColumn(db, "agent_steps", "harness_snapshot_hash")) {
      db.exec("ALTER TABLE agent_steps ADD COLUMN harness_snapshot_hash TEXT");
    }
    if (!hasColumn(db, "agent_steps", "project_key")) {
      db.exec("ALTER TABLE agent_steps ADD COLUMN project_key TEXT");
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_steps_project
      ON agent_steps(project_key, timestamp)`);
  }
}

/**
 * v28：Step 级响应事实补强（2026-09-11 P1，Step 基础链路调研）。
 * agent_steps 增列 stop_reason（协议原始停止原因，如 tool_use / end_turn / tool_calls），
 * 可空、存量不回填；只增列，不触碰账本与聚合。
 */
function migrateStepStopReasonV28(db: DeepaaDatabase): void {
  if (hasTable(db, "agent_steps") && !hasColumn(db, "agent_steps", "stop_reason")) {
    db.exec("ALTER TABLE agent_steps ADD COLUMN stop_reason TEXT");
  }
}

/**
 * v29：去重指纹改存 32 字节 BLOB（2026-09-11 存储瘦身）。
 * 64 字符 hex 文本让该表（含复合主键索引）占到 894 MB；BLOB 直接把键宽减半。
 * 指纹是 raw 的可重算派生数据，项目未上线且已有重建流程，因此这里直接重建空表
 * （不写 2.9M 行转换逻辑）：重建后由 worker 从 raw 重新派生。
 */
const REQUEST_FINGERPRINTS_V29_SQL = `
DROP TABLE IF EXISTS exchange_request_fingerprints;
CREATE TABLE IF NOT EXISTS exchange_request_fingerprints (
  exchange_id TEXT NOT NULL REFERENCES raw_exchange_refs(exchange_id) ON DELETE CASCADE,
  body_side TEXT NOT NULL CHECK (body_side IN ('request', 'response')),
  category TEXT NOT NULL CHECK (
    category IN (
      'system', 'developer', 'user_real', 'user_injected', 'tool_result',
      'assistant', 'tool_use', 'reasoning', 'refusal', 'control',
      'unknown_input', 'unknown_output'
    )
  ),
  fingerprint BLOB NOT NULL CHECK (length(fingerprint) = 32),
  provider_lineage_key TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL CHECK (occurrence_count > 0),
  PRIMARY KEY (
    exchange_id, body_side, category, fingerprint, provider_lineage_key
  )
);
`;

function migrateRequestFingerprintsBlobV29(db: DeepaaDatabase): void {
  if (!hasTable(db, "exchange_request_fingerprints")) return;
  const columns = db.prepare(
    "SELECT name, type FROM pragma_table_info('exchange_request_fingerprints')",
  ).all() as Array<{name: string; type: string}>;
  const fingerprintColumn = columns.find(column => column.name === "fingerprint");
  if (fingerprintColumn && fingerprintColumn.type.toUpperCase() === "BLOB") return;
  db.exec(REQUEST_FINGERPRINTS_V29_SQL);
}

/**
 * v30：上线前保留策略与 raw 生命周期（docs/上线前架构升级改造.md §3）。
 * - ingestion_sources.last_captured_at：source 数据新近度，驱动派生「文件级最新优先」
 *   排序；generation 重置时清空，迁移内从已有登记一次性回填（只读 SQLite，不扫 raw）。
 * - ingestion_records.projection_state：30 天投影窗口标记，超窗登记 archived 不建 job。
 * - raw_exchange_refs.raw_state：raw 墓碑，清理后 step/账本外键永不失效。
 * - context_snapshots / step_diffs 派生物外置列（>16 KiB 写内容寻址 gz，行内存 hash+size）。
 * - blob GC 引用计数索引。
 * 全部为加列/加索引，不重建任何已填充业务表（迁移红线守卫测试强制）。
 */
const RETENTION_V30_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_ingestion_records_projection_state
  ON ingestion_records(projection_state, captured_at);
CREATE INDEX IF NOT EXISTS idx_ingestion_records_req_blob
  ON ingestion_records(request_body_sha256);
CREATE INDEX IF NOT EXISTS idx_ingestion_records_resp_blob
  ON ingestion_records(response_body_sha256);
CREATE INDEX IF NOT EXISTS idx_media_raw_blob
  ON exchange_media_descriptors(raw_body_sha256);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_artifact
  ON context_snapshots(artifact_hash);
CREATE INDEX IF NOT EXISTS idx_step_diffs_artifact
  ON step_diffs(artifact_hash);
`;

function migrateRetentionWindowAndRawStateV30(db: DeepaaDatabase): void {
  const hasIngestionRecords = hasTable(db, "ingestion_records");
  if (
    hasTable(db, "ingestion_sources")
    && hasIngestionRecords
    && !hasColumn(db, "ingestion_sources", "last_captured_at")
  ) {
    db.exec("ALTER TABLE ingestion_sources ADD COLUMN last_captured_at TEXT");
    db.exec(`
      UPDATE ingestion_sources
      SET last_captured_at = (
        SELECT MAX(ir.captured_at) FROM ingestion_records ir
        WHERE ir.source_id = ingestion_sources.id
      )
      WHERE last_captured_at IS NULL
    `);
  }
  if (hasIngestionRecords && !hasColumn(db, "ingestion_records", "projection_state")) {
    db.exec(`ALTER TABLE ingestion_records ADD COLUMN projection_state TEXT NOT NULL DEFAULT 'active'
      CHECK (projection_state IN ('active', 'archived'))`);
  }
  if (hasTable(db, "raw_exchange_refs") && !hasColumn(db, "raw_exchange_refs", "raw_state")) {
    db.exec(`ALTER TABLE raw_exchange_refs ADD COLUMN raw_state TEXT NOT NULL DEFAULT 'active'
      CHECK (raw_state IN ('active', 'purged'))`);
  }
  if (hasTable(db, "context_snapshots") && !hasColumn(db, "context_snapshots", "artifact_storage")) {
    db.exec(`ALTER TABLE context_snapshots ADD COLUMN artifact_storage TEXT NOT NULL DEFAULT 'inline'
      CHECK (artifact_storage IN ('inline', 'external'))`);
    db.exec("ALTER TABLE context_snapshots ADD COLUMN artifact_hash TEXT");
    db.exec("ALTER TABLE context_snapshots ADD COLUMN artifact_size INTEGER");
  }
  if (hasTable(db, "step_diffs") && !hasColumn(db, "step_diffs", "artifact_storage")) {
    db.exec(`ALTER TABLE step_diffs ADD COLUMN artifact_storage TEXT NOT NULL DEFAULT 'inline'
      CHECK (artifact_storage IN ('inline', 'external'))`);
    db.exec("ALTER TABLE step_diffs ADD COLUMN artifact_hash TEXT");
    db.exec("ALTER TABLE step_diffs ADD COLUMN artifact_size INTEGER");
  }
  if (hasTable(db, "agent_steps") && !hasColumn(db, "agent_steps", "failover_json")) {
    // failover 元数据与派生物正文解耦：context_snapshots 外置后 SQL json_extract
    // 无法读取文件，写入端同步把 failover 落到本列，读取端 COALESCE 优先。
    db.exec("ALTER TABLE agent_steps ADD COLUMN failover_json TEXT");
  }
  if (hasIngestionRecords) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ingestion_records_projection_state
        ON ingestion_records(projection_state, captured_at);
      CREATE INDEX IF NOT EXISTS idx_ingestion_records_req_blob
        ON ingestion_records(request_body_sha256);
      CREATE INDEX IF NOT EXISTS idx_ingestion_records_resp_blob
        ON ingestion_records(response_body_sha256);
    `);
  }
  if (hasTable(db, "exchange_media_descriptors")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_media_raw_blob
        ON exchange_media_descriptors(raw_body_sha256);
    `);
  }
  if (hasTable(db, "context_snapshots")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_context_snapshots_artifact
        ON context_snapshots(artifact_hash);
    `);
  }
  if (hasTable(db, "step_diffs")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_step_diffs_artifact
        ON step_diffs(artifact_hash);
    `);
  }
}

function migrateUsageLedgerServiceTierV24(db: DeepaaDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS reconciliation_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    site_spend REAL NOT NULL,
    local_spend REAL NOT NULL,
    diff_amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL,
    ledger_exchange_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(target_id, window_end)
  )`);
  if (!hasTable(db, "usage_ledger")) return;
  if (!hasColumn(db, "usage_ledger", "service_tier")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN service_tier TEXT");
  }
}

/** v51：缓存写入按 5m/1h TTL 分项保存，旧 cache_write_tokens 继续作为合计兼容列。 */
function migrateCacheTtlUsageV51(db: DeepaaDatabase): void {
  if (hasTable(db, "usage_ledger")) {
    if (!hasColumn(db, "usage_ledger", "cache_write_5m_tokens")) {
      db.exec("ALTER TABLE usage_ledger ADD COLUMN cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0");
    }
    if (!hasColumn(db, "usage_ledger", "cache_write_1h_tokens")) {
      db.exec("ALTER TABLE usage_ledger ADD COLUMN cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0");
    }
  }
  if (hasTable(db, "plan_quota_snapshots") && !hasColumn(db, "plan_quota_snapshots", "plan_family")) {
    db.exec("ALTER TABLE plan_quota_snapshots ADD COLUMN plan_family TEXT");
  }
}

const ANALYTICS_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS analytics_hourly_facts (
  bucket_start_utc TEXT NOT NULL,
  target_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  vendor TEXT NOT NULL,
  vendor_family TEXT NOT NULL,
  billing_channel TEXT NOT NULL,
  model TEXT NOT NULL,
  currency TEXT NOT NULL,
  cost_basis TEXT NOT NULL,
  request_kind TEXT NOT NULL,
  result_class TEXT NOT NULL,
  usage_quality TEXT NOT NULL,
  pricing_status TEXT NOT NULL,
  plan_credit_unit TEXT NOT NULL,
  plan_credit_formula_version TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  model_request_count INTEGER NOT NULL DEFAULT 0,
  auxiliary_request_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  cancelled_count INTEGER NOT NULL DEFAULT 0,
  incomplete_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  exact_token_request_count INTEGER NOT NULL DEFAULT 0,
  estimated_token_request_count INTEGER NOT NULL DEFAULT 0,
  unavailable_token_request_count INTEGER NOT NULL DEFAULT 0,
  priced_request_count INTEGER NOT NULL DEFAULT 0,
  unpriced_request_count INTEGER NOT NULL DEFAULT 0,
  audit_eligible_request_count INTEGER NOT NULL DEFAULT 0,
  vendor_cost_nano INTEGER NOT NULL DEFAULT 0,
  actual_cost_nano INTEGER NOT NULL DEFAULT 0,
  reference_cost_nano INTEGER NOT NULL DEFAULT 0,
  reference_cost_request_count INTEGER NOT NULL DEFAULT 0,
  reference_cost_exact_request_count INTEGER NOT NULL DEFAULT 0,
  reference_cost_estimated_request_count INTEGER NOT NULL DEFAULT 0,
  plan_credit_cost REAL NOT NULL DEFAULT 0,
  /* 套餐估算冻结聚合（2026-09-15）：人民币 nano 与「部分估算」请求数（unavailable
     或旧口径有消耗行）；由 rollup 从 usage_ledger 增量聚合。 */
  plan_estimated_nano INTEGER NOT NULL DEFAULT 0,
  plan_estimated_pending_request_count INTEGER NOT NULL DEFAULT 0,
  duration_sum_ms INTEGER NOT NULL DEFAULT 0,
  duration_sample_count INTEGER NOT NULL DEFAULT 0,
  duration_min_ms INTEGER,
  duration_max_ms INTEGER,
  duration_histogram_json TEXT NOT NULL DEFAULT '{}',
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  last_ledger_created_at TEXT,
  updated_at TEXT NOT NULL,
  projection_version INTEGER NOT NULL DEFAULT 4,
  PRIMARY KEY (
    bucket_start_utc, target_id, agent_id, vendor, vendor_family,
    billing_channel, model, currency, cost_basis, request_kind,
    result_class, usage_quality, pricing_status, plan_credit_unit,
    plan_credit_formula_version
  )
);
CREATE INDEX IF NOT EXISTS idx_analytics_hourly_time
  ON analytics_hourly_facts(bucket_start_utc, updated_at);
CREATE INDEX IF NOT EXISTS idx_analytics_hourly_agent
  ON analytics_hourly_facts(bucket_start_utc, agent_id, target_id, model);
CREATE INDEX IF NOT EXISTS idx_analytics_hourly_vendor
  ON analytics_hourly_facts(bucket_start_utc, vendor, vendor_family, billing_channel);
CREATE INDEX IF NOT EXISTS idx_analytics_hourly_quality
  ON analytics_hourly_facts(bucket_start_utc, usage_quality, pricing_status, result_class);

CREATE TABLE IF NOT EXISTS analytics_dirty_buckets (
  bucket_start_utc TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'ledger_insert',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  locked_by TEXT,
  locked_until TEXT,
  last_error TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_analytics_dirty_claim
  ON analytics_dirty_buckets(status, available_at, bucket_start_utc);

CREATE TABLE IF NOT EXISTS analytics_rollup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  bucket_start_utc TEXT,
  processed_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_analytics_rollup_runs_time
  ON analytics_rollup_runs(started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS analytics_worker_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_worker_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'idle',
  last_started_at TEXT,
  last_success_at TEXT,
  last_error_at TEXT,
  last_error TEXT,
  last_ledger_created_at TEXT,
  rollup_watermark_at TEXT,
  processed_bucket_count INTEGER NOT NULL DEFAULT 0,
  failed_bucket_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_value_windows (
  billing_window_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  billing_channel TEXT NOT NULL,
  vendor_family TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  currency TEXT,
  fee_nano INTEGER,
  fee_source TEXT,
  fee_confidence TEXT,
  plan_name TEXT,
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  reference_cost_nano INTEGER NOT NULL DEFAULT 0,
  reference_token_count INTEGER NOT NULL DEFAULT 0,
  estimated_token_count INTEGER NOT NULL DEFAULT 0,
  unpriced_request_count INTEGER NOT NULL DEFAULT 0,
  plan_credit_cost REAL NOT NULL DEFAULT 0,
  estimated_savings_nano INTEGER,
  value_multiple REAL,
  savings_rate REAL,
  value_estimation_status TEXT NOT NULL DEFAULT 'missing_fee',
  completeness TEXT NOT NULL DEFAULT 'incomplete',
  captured_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_value_target_window
  ON billing_value_windows(target_id, window_start DESC, window_end DESC);
CREATE INDEX IF NOT EXISTS idx_billing_value_channel_window
  ON billing_value_windows(billing_channel, vendor_family, window_start DESC);
`;

const MIGRATION_1_TO_2_SQL = `
ALTER TABLE ingestion_sources
  ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0);
`;

const MIGRATION_2_TO_3_SQL = `
ALTER TABLE ingestion_sources
  ADD COLUMN scan_offset INTEGER NOT NULL DEFAULT 0 CHECK (scan_offset >= 0);
UPDATE ingestion_sources SET scan_offset = byte_offset;
CREATE TRIGGER ingestion_sources_scan_offset_insert
BEFORE INSERT ON ingestion_sources
WHEN NEW.scan_offset < NEW.byte_offset
BEGIN
  SELECT RAISE(ABORT, 'scan_offset must be greater than or equal to byte_offset');
END;
CREATE TRIGGER ingestion_sources_scan_offset_update
BEFORE UPDATE OF byte_offset, scan_offset ON ingestion_sources
WHEN NEW.scan_offset < NEW.byte_offset
BEGIN
  SELECT RAISE(ABORT, 'scan_offset must be greater than or equal to byte_offset');
END;
`;

const MIGRATION_3_TO_4_SQL = `
CREATE INDEX idx_threads_root
  ON agent_threads(agent_session_id, is_root, id);
CREATE INDEX idx_diagnostics_dedupe
  ON derivation_diagnostics(code, details_json, exchange_id, source_id);
`;

const MIGRATION_4_TO_5_SQL = `
CREATE INDEX idx_sessions_conversation
  ON agent_sessions(target_id, agent_name, external_conversation_id);
`;

const MIGRATION_5_TO_6_SQL = `
CREATE INDEX idx_turns_open
  ON agent_turns(agent_thread_id, status, segment_index DESC, id DESC);
CREATE INDEX idx_turns_native
  ON agent_turns(agent_thread_id, native_turn_id, segment_index DESC, id DESC);
CREATE INDEX idx_turns_segment
  ON agent_turns(agent_thread_id, segment_index DESC, id DESC);
CREATE INDEX idx_tools_turn_use
  ON tool_calls(agent_turn_id, tool_use_id, agent_thread_id);
`;

const MIGRATION_6_TO_7_SQL = `
CREATE INDEX idx_sessions_target_agent_latest
  ON agent_sessions(target_id, agent_name, end_time DESC, id DESC);
CREATE INDEX idx_tools_turn_step_name_status
  ON tool_calls(agent_turn_id, agent_step_id, tool_name, status);
`;

const MIGRATION_7_TO_8_SQL = `
CREATE INDEX IF NOT EXISTS idx_steps_session_time
  ON agent_steps(agent_session_id, timestamp DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_steps_thread_time
  ON agent_steps(agent_thread_id, timestamp DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_steps_turn_time
  ON agent_steps(agent_turn_id, timestamp DESC, exchange_id DESC);
`;

const MIGRATION_7_TO_8_AUX_SQL = `
CREATE INDEX IF NOT EXISTS idx_aux_session_time
  ON auxiliary_requests(agent_session_id, timestamp DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_aux_thread_time
  ON auxiliary_requests(agent_thread_id, timestamp DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_aux_turn_time
  ON auxiliary_requests(agent_turn_id, timestamp DESC, exchange_id DESC);
`;

const MIGRATION_8_TO_9_SQL = `
CREATE TABLE IF NOT EXISTS pricing_catalog_blobs (
  hash TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pricing_policy_blobs (
  hash TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pricing_config_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  effective_at TEXT NOT NULL,
  catalog_hash TEXT NOT NULL REFERENCES pricing_catalog_blobs(hash),
  policy_hash TEXT NOT NULL REFERENCES pricing_policy_blobs(hash),
  created_at TEXT NOT NULL,
  UNIQUE (effective_at, catalog_hash, policy_hash)
);
CREATE INDEX IF NOT EXISTS idx_pricing_revisions_effective
  ON pricing_config_revisions(effective_at DESC, id DESC);
`;

const MIGRATION_9_TO_10_SQL = `
CREATE TEMP TABLE v10_target_auxiliary_exchanges AS
SELECT a.exchange_id,
  a.agent_session_id AS session_id,
  a.agent_thread_id AS thread_id
FROM auxiliary_requests a
JOIN agent_sessions s ON s.id = a.agent_session_id
WHERE s.source = 'capture-session'
  AND NOT EXISTS(
    SELECT 1 FROM agent_steps st
    WHERE st.agent_session_id = a.agent_session_id LIMIT 1
  )
  AND NOT EXISTS(
    SELECT 1 FROM agent_turns tr
    WHERE tr.agent_session_id = a.agent_session_id LIMIT 1
  );
CREATE UNIQUE INDEX v10_target_auxiliary_exchange
  ON v10_target_auxiliary_exchanges(exchange_id);
CREATE INDEX v10_target_auxiliary_session
  ON v10_target_auxiliary_exchanges(session_id);
CREATE INDEX v10_target_auxiliary_thread
  ON v10_target_auxiliary_exchanges(thread_id);

CREATE TABLE auxiliary_requests_v10 (
  id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL UNIQUE REFERENCES raw_exchange_refs(exchange_id),
  agent_session_id TEXT REFERENCES agent_sessions(id),
  agent_thread_id TEXT REFERENCES agent_threads(id),
  agent_turn_id TEXT REFERENCES agent_turns(id),
  target_id TEXT NOT NULL,
  agent_fingerprint_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0
);
INSERT INTO auxiliary_requests_v10(
  id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
  target_id, agent_fingerprint_id, agent_name, kind, timestamp, duration_ms
)
SELECT a.id, a.exchange_id,
  CASE WHEN target.exchange_id IS NULL THEN a.agent_session_id ELSE NULL END,
  CASE WHEN target.exchange_id IS NULL THEN a.agent_thread_id ELSE NULL END,
  CASE WHEN target.exchange_id IS NULL THEN a.agent_turn_id ELSE NULL END,
  raw.target_id, raw.agent_fingerprint_id, raw.agent_name,
  a.kind, a.timestamp, a.duration_ms
FROM auxiliary_requests a
JOIN raw_exchange_refs raw ON raw.exchange_id = a.exchange_id
LEFT JOIN v10_target_auxiliary_exchanges target
  ON target.exchange_id = a.exchange_id;

CREATE TABLE usage_ledger_v10 (
  exchange_id TEXT PRIMARY KEY REFERENCES raw_exchange_refs(exchange_id),
  agent_session_id TEXT REFERENCES agent_sessions(id),
  agent_thread_id TEXT REFERENCES agent_threads(id),
  agent_turn_id TEXT REFERENCES agent_turns(id),
  agent_step_id TEXT REFERENCES agent_steps(id),
  target_id TEXT NOT NULL,
  agent_fingerprint_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  model TEXT NOT NULL,
  vendor TEXT NOT NULL,
  rate_multiplier REAL NOT NULL,
  input_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL,
  vendor_cost REAL NOT NULL,
  actual_cost REAL NOT NULL,
  duration_ms INTEGER NOT NULL,
  usage_source TEXT NOT NULL,
  usage_confidence TEXT NOT NULL,
  pricing_snapshot_json TEXT NOT NULL,
  plan_credit_cost REAL,
  plan_credit_unit TEXT,
  plan_credit_formula_version TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO usage_ledger_v10
SELECT u.exchange_id,
  CASE WHEN target.exchange_id IS NULL THEN u.agent_session_id ELSE NULL END,
  CASE WHEN target.exchange_id IS NULL THEN u.agent_thread_id ELSE NULL END,
  CASE WHEN target.exchange_id IS NULL THEN u.agent_turn_id ELSE NULL END,
  CASE WHEN target.exchange_id IS NULL THEN u.agent_step_id ELSE NULL END,
  u.target_id, u.agent_fingerprint_id, u.agent_name, u.model, u.vendor,
  u.rate_multiplier, u.input_tokens, u.cache_read_tokens,
  u.cache_write_tokens, 0, 0, u.output_tokens, u.vendor_cost, u.actual_cost,
  u.duration_ms, u.usage_source, u.usage_confidence,
  u.pricing_snapshot_json, NULL, NULL, NULL, u.created_at
FROM usage_ledger u
LEFT JOIN v10_target_auxiliary_exchanges target
  ON target.exchange_id = u.exchange_id;

DROP TABLE auxiliary_requests;
ALTER TABLE auxiliary_requests_v10 RENAME TO auxiliary_requests;
DROP TABLE usage_ledger;
ALTER TABLE usage_ledger_v10 RENAME TO usage_ledger;

CREATE INDEX idx_aux_session_time
  ON auxiliary_requests(agent_session_id, timestamp DESC, exchange_id DESC);
CREATE INDEX idx_aux_thread_time
  ON auxiliary_requests(agent_thread_id, timestamp DESC, exchange_id DESC);
CREATE INDEX idx_aux_turn_time
  ON auxiliary_requests(agent_turn_id, timestamp DESC, exchange_id DESC);
CREATE INDEX idx_aux_target_time
  ON auxiliary_requests(target_id, timestamp DESC, exchange_id DESC);
CREATE INDEX idx_usage_session_time
  ON usage_ledger(agent_session_id, created_at DESC, exchange_id DESC);
CREATE INDEX idx_usage_global_time
  ON usage_ledger(created_at DESC, exchange_id DESC);
CREATE INDEX idx_usage_thread_time
  ON usage_ledger(agent_thread_id, created_at DESC, exchange_id DESC);
CREATE INDEX idx_usage_turn_time
  ON usage_ledger(agent_turn_id, created_at DESC, exchange_id DESC);
CREATE INDEX idx_usage_step ON usage_ledger(agent_step_id);

DELETE FROM scope_aggregates
WHERE (scope_type = 'session' AND scope_id IN (
  SELECT session_id FROM v10_target_auxiliary_exchanges
)) OR (scope_type = 'thread' AND scope_id IN (
  SELECT thread_id FROM v10_target_auxiliary_exchanges
));
DELETE FROM agent_threads
WHERE id IN (SELECT thread_id FROM v10_target_auxiliary_exchanges);
DELETE FROM agent_sessions
WHERE id IN (SELECT session_id FROM v10_target_auxiliary_exchanges)
  AND NOT EXISTS(
    SELECT 1 FROM agent_threads t WHERE t.agent_session_id = agent_sessions.id
  );
DROP TABLE v10_target_auxiliary_exchanges;
`;

const INGESTION_RECORDS_SQL = `
CREATE TABLE IF NOT EXISTS ingestion_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange_id TEXT NOT NULL UNIQUE,
  source_id INTEGER NOT NULL REFERENCES ingestion_sources(id),
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  source_file_id TEXT NOT NULL,
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  line_length_bytes INTEGER NOT NULL CHECK (line_length_bytes > 0),
  line_sha256 TEXT NOT NULL CHECK (length(line_sha256) = 64),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  captured_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  request_body_bytes INTEGER NOT NULL CHECK (request_body_bytes >= 0),
  response_body_bytes INTEGER NOT NULL CHECK (response_body_bytes >= 0),
  request_body_sha256 TEXT NOT NULL CHECK (length(request_body_sha256) = 64),
  response_body_sha256 TEXT NOT NULL CHECK (length(response_body_sha256) = 64),
  request_body_storage TEXT NOT NULL CHECK (
    request_body_storage IN ('inline', 'compressed-inline', 'external-blob', 'none')
  ),
  response_body_storage TEXT NOT NULL CHECK (
    response_body_storage IN ('inline', 'compressed-inline', 'external-blob', 'none')
  ),
  request_body_state TEXT NOT NULL CHECK (
    request_body_state IN ('available', 'empty', 'missing_declared')
  ),
  response_body_state TEXT NOT NULL CHECK (
    response_body_state IN ('available', 'empty', 'missing_declared')
  ),
  registered_at TEXT NOT NULL,
  projection_state TEXT NOT NULL DEFAULT 'active' CHECK (
    projection_state IN ('active', 'archived')
  ),
  UNIQUE (source_id, source_generation, byte_offset)
);
CREATE TABLE IF NOT EXISTS derivation_jobs (
  ingestion_record_id INTEGER NOT NULL REFERENCES ingestion_records(id) ON DELETE CASCADE,
  projection_version INTEGER NOT NULL CHECK (projection_version > 0),
  job_status TEXT NOT NULL CHECK (
    job_status IN ('pending', 'running', 'retry_wait', 'succeeded', 'permanent_error')
  ),
  projection_completeness TEXT CHECK (
    projection_completeness IN ('complete', 'limited', 'unavailable')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TEXT NOT NULL,
  locked_by TEXT,
  locked_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT CHECK (
    last_error_message IS NULL OR length(CAST(last_error_message AS BLOB)) <= 2048
  ),
  limited_dimensions_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(limited_dimensions_json)
    AND json_type(limited_dimensions_json) = 'array'
    AND length(CAST(limited_dimensions_json AS BLOB)) <= 4096
  ),
  request_verification TEXT NOT NULL CHECK (
    request_verification IN (
      'pending', 'verified', 'empty', 'not_verified_budget',
      'missing_declared', 'failed'
    )
  ),
  response_verification TEXT NOT NULL CHECK (
    response_verification IN (
      'pending', 'verified', 'empty', 'not_verified_budget',
      'missing_declared', 'failed'
    )
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (ingestion_record_id, projection_version),
  CHECK (
    (
      job_status IN ('pending', 'running', 'retry_wait')
      AND projection_completeness IS NULL
      AND completed_at IS NULL
    ) OR (
      job_status = 'succeeded'
      AND projection_completeness IS NOT NULL
      AND projection_completeness IN ('complete', 'limited')
      AND completed_at IS NOT NULL
    ) OR (
      job_status = 'permanent_error'
      AND projection_completeness IS NOT NULL
      AND projection_completeness = 'unavailable'
      AND completed_at IS NOT NULL
    )
  ),
  CHECK (
    projection_completeness <> 'complete'
    OR (
      request_verification IN ('verified', 'empty')
      AND response_verification IN ('verified', 'empty')
    )
  )
);
`;

const LARGE_BODY_PROJECTIONS_SQL = `
CREATE TABLE IF NOT EXISTS exchange_media_descriptors (
  exchange_id TEXT NOT NULL REFERENCES raw_exchange_refs(exchange_id) ON DELETE CASCADE,
  body_side TEXT NOT NULL CHECK (body_side IN ('request', 'response')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 256),
  json_path TEXT NOT NULL CHECK (length(CAST(json_path AS BLOB)) <= 512),
  media_type TEXT NOT NULL CHECK (length(CAST(media_type AS BLOB)) <= 128),
  encoded_bytes INTEGER NOT NULL CHECK (encoded_bytes >= 0),
  decoded_bytes INTEGER NOT NULL CHECK (decoded_bytes >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  raw_body_sha256 TEXT NOT NULL CHECK (length(raw_body_sha256) = 64),
  source_storage TEXT NOT NULL CHECK (
    source_storage IN ('inline', 'compressed-inline', 'external-blob')
  ),
  PRIMARY KEY (exchange_id, body_side, ordinal)
);
CREATE TABLE IF NOT EXISTS exchange_content_previews (
  exchange_id TEXT PRIMARY KEY REFERENCES raw_exchange_refs(exchange_id) ON DELETE CASCADE,
  projection_version INTEGER NOT NULL CHECK (projection_version > 0),
  preview_state TEXT NOT NULL CHECK (
    preview_state IN ('complete', 'limited', 'unavailable')
  ),
  preview_json TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (
    size_bytes >= 0
    AND size_bytes <= 262144
    AND size_bytes = length(CAST(preview_json AS BLOB))
  ),
  candidate_item_count INTEGER NOT NULL CHECK (candidate_item_count >= 0),
  processed_item_count INTEGER NOT NULL CHECK (
    processed_item_count >= 0 AND processed_item_count <= candidate_item_count
  ),
  candidate_text_bytes INTEGER NOT NULL CHECK (candidate_text_bytes >= 0),
  processed_text_bytes INTEGER NOT NULL CHECK (
    processed_text_bytes >= 0 AND processed_text_bytes <= candidate_text_bytes
  ),
  candidate_count_exact INTEGER NOT NULL CHECK (candidate_count_exact IN (0, 1)),
  limited INTEGER NOT NULL CHECK (limited IN (0, 1)),
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  limited_dimensions_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(limited_dimensions_json)
    AND json_type(limited_dimensions_json) = 'array'
    AND length(CAST(limited_dimensions_json AS BLOB)) <= 4096
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (preview_state = 'complete' AND limited = 0 AND truncated = 0)
    OR preview_state IN ('limited', 'unavailable')
  )
);
`;

const CONTENT_FILTER_PROJECTIONS_SQL = `
CREATE TABLE IF NOT EXISTS exchange_content_filter_status (
  exchange_id TEXT PRIMARY KEY REFERENCES raw_exchange_refs(exchange_id) ON DELETE CASCADE,
  projection_version INTEGER NOT NULL CHECK (projection_version > 0),
  filter_state TEXT NOT NULL CHECK (filter_state IN ('complete', 'limited')),
  request_filter_state TEXT NOT NULL CHECK (
    request_filter_state IN ('complete', 'limited')
  ),
  response_filter_state TEXT NOT NULL CHECK (
    response_filter_state IN ('complete', 'limited')
  ),
  request_dedupe_state TEXT NOT NULL CHECK (
    request_dedupe_state IN ('not_required', 'compared', 'unconfirmed', 'not_applicable')
  ),
  request_context_mode TEXT NOT NULL CHECK (
    request_context_mode IN ('full_replay', 'stateful_delta', 'unknown')
  ),
  request_comparison_kind TEXT NOT NULL CHECK (
    request_comparison_kind IN ('none', 'same_epoch', 'boundary_carryover')
  ),
  request_context_epoch INTEGER CHECK (request_context_epoch >= 0),
  effective_context_boundary_id TEXT,
  produced_context_boundary_id TEXT,
  baseline_exchange_id TEXT,
  request_fingerprint_count INTEGER NOT NULL CHECK (
    request_fingerprint_count >= 0 AND request_fingerprint_count <= 4096
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exchange_request_fingerprints (
  exchange_id TEXT NOT NULL REFERENCES raw_exchange_refs(exchange_id) ON DELETE CASCADE,
  body_side TEXT NOT NULL CHECK (body_side IN ('request', 'response')),
  category TEXT NOT NULL CHECK (
    category IN (
      'system', 'developer', 'user_real', 'user_injected', 'tool_result',
      'assistant', 'tool_use', 'reasoning', 'refusal', 'control',
      'unknown_input', 'unknown_output'
    )
  ),
  fingerprint BLOB NOT NULL CHECK (length(fingerprint) = 32),
  provider_lineage_key TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL CHECK (occurrence_count > 0),
  PRIMARY KEY (
    exchange_id, body_side, category, fingerprint, provider_lineage_key
  )
);
CREATE TABLE IF NOT EXISTS exchange_content_category_stats (
  exchange_id TEXT NOT NULL REFERENCES raw_exchange_refs(exchange_id) ON DELETE CASCADE,
  body_side TEXT NOT NULL CHECK (body_side IN ('request', 'response')),
  category TEXT NOT NULL CHECK (
    category IN (
      'system', 'developer', 'user_real', 'user_injected', 'tool_result',
      'assistant', 'tool_use', 'reasoning', 'refusal', 'control',
      'unknown_input', 'unknown_output'
    )
  ),
  total_count INTEGER NOT NULL CHECK (total_count >= 0),
  unique_count INTEGER NOT NULL CHECK (unique_count >= 0),
  inherited_count INTEGER NOT NULL CHECK (inherited_count >= 0),
  unconfirmed_count INTEGER NOT NULL CHECK (unconfirmed_count >= 0),
  PRIMARY KEY (exchange_id, body_side, category),
  CHECK (total_count = unique_count + inherited_count + unconfirmed_count)
);
CREATE INDEX IF NOT EXISTS idx_content_filter_status_state
  ON exchange_content_filter_status(filter_state, exchange_id);
CREATE INDEX IF NOT EXISTS idx_content_filter_context
  ON exchange_content_filter_status(
    request_context_mode, request_context_epoch, request_comparison_kind,
    baseline_exchange_id, exchange_id
  );
CREATE INDEX IF NOT EXISTS idx_content_category_match
  ON exchange_content_category_stats(
    category, body_side, unique_count, unconfirmed_count, total_count, exchange_id
  );
CREATE INDEX IF NOT EXISTS idx_content_category_side_match
  ON exchange_content_category_stats(
    body_side, category, unique_count, unconfirmed_count, exchange_id
  );
`;

const LARGE_BODY_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_ingestion_records_source_order
  ON ingestion_records(source_id, source_generation, byte_offset);
CREATE INDEX IF NOT EXISTS idx_ingestion_records_registered
  ON ingestion_records(registered_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_derivation_jobs_claim
  ON derivation_jobs(job_status, available_at, ingestion_record_id);
CREATE INDEX IF NOT EXISTS idx_derivation_jobs_completeness
  ON derivation_jobs(projection_completeness, updated_at);
CREATE INDEX IF NOT EXISTS idx_derivation_jobs_status_created
  ON derivation_jobs(job_status, created_at, ingestion_record_id);
CREATE INDEX IF NOT EXISTS idx_derivation_jobs_status_completed
  ON derivation_jobs(job_status, completed_at DESC, ingestion_record_id DESC);
CREATE INDEX IF NOT EXISTS idx_derivation_jobs_recent_error
  ON derivation_jobs(updated_at DESC, ingestion_record_id DESC)
  WHERE last_error_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_descriptors_hash
  ON exchange_media_descriptors(sha256, media_type);
CREATE INDEX IF NOT EXISTS idx_content_previews_state
  ON exchange_content_previews(preview_state, updated_at);
`;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  initialized_at TEXT NOT NULL,
  data_version INTEGER NOT NULL DEFAULT 0,
  worker_status TEXT NOT NULL DEFAULT 'idle',
  worker_error TEXT,
  last_source_scan_completed_at TEXT
);
CREATE TABLE IF NOT EXISTS worker_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ingestion_sources (
  id INTEGER PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  file_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  byte_offset INTEGER NOT NULL DEFAULT 0 CHECK (byte_offset >= 0),
  scan_offset INTEGER NOT NULL DEFAULT 0 CHECK (scan_offset >= 0),
  file_size INTEGER NOT NULL DEFAULT 0 CHECK (file_size >= 0),
  processed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready',
  error TEXT,
  updated_at TEXT NOT NULL,
  last_captured_at TEXT
);
CREATE TRIGGER IF NOT EXISTS ingestion_sources_scan_offset_insert
BEFORE INSERT ON ingestion_sources
WHEN NEW.scan_offset < NEW.byte_offset
BEGIN
  SELECT RAISE(ABORT, 'scan_offset must be greater than or equal to byte_offset');
END;
CREATE TRIGGER IF NOT EXISTS ingestion_sources_scan_offset_update
BEFORE UPDATE OF byte_offset, scan_offset ON ingestion_sources
WHEN NEW.scan_offset < NEW.byte_offset
BEGIN
  SELECT RAISE(ABORT, 'scan_offset must be greater than or equal to byte_offset');
END;
${INGESTION_RECORDS_SQL}
CREATE TABLE IF NOT EXISTS agent_prompt_skeletons (
  skeleton_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  model_id TEXT,
  provider_id TEXT,
  body_json TEXT NOT NULL,
  tool_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_prompt_skeletons_session
  ON agent_prompt_skeletons(agent_id, session_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS agent_local_identity_links (
  response_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  external_session_id TEXT NOT NULL,
  parent_external_session_id TEXT,
  root_external_session_id TEXT,
  turn_number INTEGER,
  step_number INTEGER,
  delegation_depth INTEGER,
  model_id TEXT,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_local_identity_links_session
  ON agent_local_identity_links(agent_name, external_session_id);

CREATE TABLE IF NOT EXISTS raw_exchange_refs (
  exchange_id TEXT PRIMARY KEY,
  capture_session_id TEXT NOT NULL,
  source_id INTEGER NOT NULL REFERENCES ingestion_sources(id),
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  line_length_bytes INTEGER NOT NULL CHECK (line_length_bytes > 0),
  captured_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_name TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_fingerprint_id TEXT NOT NULL,
  model TEXT,
  wire_api TEXT,
  status INTEGER NOT NULL,
  is_streaming INTEGER NOT NULL CHECK (is_streaming IN (0, 1)),
  request_body_bytes INTEGER NOT NULL,
  response_body_bytes INTEGER NOT NULL,
  diagnostic_codes_json TEXT NOT NULL DEFAULT '[]',
  ingestion_record_id INTEGER UNIQUE REFERENCES ingestion_records(id),
  raw_state TEXT NOT NULL DEFAULT 'active' CHECK (
    raw_state IN ('active', 'purged')
  ),
  origin TEXT NOT NULL DEFAULT 'gateway' CHECK (
    origin IN ('gateway', 'agent_local_import')
  )
);
${LARGE_BODY_PROJECTIONS_SQL}
${CONTENT_FILTER_PROJECTIONS_SQL}
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  target_name TEXT NOT NULL,
  agent_fingerprint_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  external_session_id TEXT,
  external_conversation_id TEXT,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  model_set_json TEXT NOT NULL DEFAULT '[]',
  request_count INTEGER NOT NULL DEFAULT 0,
  thread_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_threads (
  id TEXT PRIMARY KEY,
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  parent_agent_thread_id TEXT REFERENCES agent_threads(id),
  external_thread_id TEXT,
  external_agent_id TEXT,
  external_parent_thread_id TEXT,
  external_parent_agent_id TEXT,
  source TEXT NOT NULL,
  display_name TEXT NOT NULL,
  confidence TEXT NOT NULL,
  is_root INTEGER NOT NULL CHECK (is_root IN (0, 1)),
  is_placeholder INTEGER NOT NULL DEFAULT 0 CHECK (is_placeholder IN (0, 1)),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  model_set_json TEXT NOT NULL DEFAULT '[]',
  request_count INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS thread_closure (
  ancestor_thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  descendant_thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  PRIMARY KEY (ancestor_thread_id, descendant_thread_id)
);
CREATE TABLE IF NOT EXISTS agent_turns (
  id TEXT PRIMARY KEY,
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  agent_thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  native_turn_id TEXT,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  segment_index INTEGER NOT NULL,
  start_exchange_id TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  model_set_json TEXT NOT NULL DEFAULT '[]',
  step_count INTEGER NOT NULL DEFAULT 0,
  auxiliary_request_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_steps (
  id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL UNIQUE REFERENCES raw_exchange_refs(exchange_id),
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  agent_thread_id TEXT NOT NULL REFERENCES agent_threads(id),
  agent_turn_id TEXT NOT NULL REFERENCES agent_turns(id),
  step_index INTEGER NOT NULL,
  native_step_id TEXT,
  identity_source TEXT,
  identity_confidence TEXT,
  timestamp TEXT NOT NULL,
  phase TEXT NOT NULL,
  request_action TEXT NOT NULL,
  response_action TEXT NOT NULL,
  request_intent_label TEXT,
  response_status_label TEXT,
  tool_schema_count INTEGER NOT NULL DEFAULT 0,
  context_compressed INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  vendor_cost REAL NOT NULL DEFAULT 0,
  actual_cost REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  harness_snapshot_hash TEXT,
  project_key TEXT,
  stop_reason TEXT,
  failover_json TEXT,
  UNIQUE (agent_turn_id, step_index)
);
CREATE TABLE IF NOT EXISTS auxiliary_requests (
  id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL UNIQUE REFERENCES raw_exchange_refs(exchange_id),
  agent_session_id TEXT REFERENCES agent_sessions(id),
  agent_thread_id TEXT REFERENCES agent_threads(id),
  agent_turn_id TEXT REFERENCES agent_turns(id),
  target_id TEXT NOT NULL,
  agent_fingerprint_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL REFERENCES raw_exchange_refs(exchange_id),
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  agent_thread_id TEXT NOT NULL REFERENCES agent_threads(id),
  agent_turn_id TEXT NOT NULL REFERENCES agent_turns(id),
  agent_step_id TEXT NOT NULL REFERENCES agent_steps(id),
  tool_use_id TEXT,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_ledger (
  exchange_id TEXT PRIMARY KEY REFERENCES raw_exchange_refs(exchange_id),
  agent_session_id TEXT REFERENCES agent_sessions(id),
  agent_thread_id TEXT REFERENCES agent_threads(id),
  agent_turn_id TEXT REFERENCES agent_turns(id),
  agent_step_id TEXT REFERENCES agent_steps(id),
  target_id TEXT NOT NULL,
  agent_fingerprint_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  model TEXT NOT NULL,
  vendor TEXT NOT NULL,
  billing_channel TEXT,
  vendor_family TEXT,
  rate_multiplier REAL NOT NULL,
  input_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  vendor_cost REAL NOT NULL,
  actual_cost REAL NOT NULL,
  vendor_cost_cny REAL,
  actual_cost_cny REAL,
  fx_rate_to_cny REAL NOT NULL DEFAULT 1,
  duration_ms INTEGER NOT NULL,
  usage_source TEXT NOT NULL,
  usage_confidence TEXT NOT NULL,
  pricing_snapshot_json TEXT NOT NULL,
  plan_credit_cost REAL,
  plan_credit_unit TEXT,
  plan_credit_formula_version TEXT,
  request_kind TEXT NOT NULL DEFAULT 'model',
  result_class TEXT NOT NULL DEFAULT 'unknown',
  usage_quality TEXT NOT NULL DEFAULT 'unavailable',
  pricing_status TEXT NOT NULL DEFAULT 'not_applicable',
  audit_eligible INTEGER NOT NULL DEFAULT 0,
  audit_exclusion_reason TEXT,
  derived_total_tokens INTEGER,
  provider_total_tokens INTEGER,
  total_tokens_basis TEXT NOT NULL DEFAULT 'legacy_unknown',
  reasoning_semantics TEXT NOT NULL DEFAULT 'output_subset',
  reference_price_entry_id TEXT,
  reference_cost_nano INTEGER,
  reference_currency TEXT,
  reference_cost_status TEXT NOT NULL DEFAULT 'unavailable',
  cost_basis TEXT NOT NULL DEFAULT 'unavailable',
  pricing_revision_id INTEGER,
  price_effective_at TEXT,
  catalog_hash TEXT,
  vendor_cost_nano INTEGER,
  actual_cost_nano INTEGER,
  money_scale INTEGER NOT NULL DEFAULT 9,
  latency_source TEXT NOT NULL DEFAULT 'round_trip',
  duration_sample_eligible INTEGER NOT NULL DEFAULT 1,
  ledger_version INTEGER NOT NULL DEFAULT 1,
  token_semantics_version INTEGER NOT NULL DEFAULT 1,
  projection_version INTEGER NOT NULL DEFAULT 4,
  first_token_ms INTEGER,
  service_tier TEXT,
  /* 套餐成本估算（2026-09-15 入账冻结）：派生期按当次价格版本汇率与最新额度快照计算，
     查询端只读冻结值；NULL 状态 = 旧口径行（不回填，前端标注部分估算）。 */
  plan_estimated_cost REAL,
  plan_estimated_currency TEXT,
  plan_estimated_fx REAL,
  plan_estimated_cost_nano INTEGER,
  plan_estimated_status TEXT,
  plan_estimate_detail_json TEXT,
  /* 估算来源（v49，2026-09-29 额度差分回填）：NULL=旧数据、formula=派生期公式、quota_delta=差分回填。 */
  plan_estimated_method TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scope_aggregates (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('session', 'thread', 'turn')),
  scope_id TEXT NOT NULL,
  step_request_count INTEGER NOT NULL DEFAULT 0,
  auxiliary_request_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  vendor_cost REAL NOT NULL DEFAULT 0,
  actual_cost REAL NOT NULL DEFAULT 0,
  duration_total_ms INTEGER NOT NULL DEFAULT 0,
  duration_sample_count INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_type, scope_id)
);
CREATE TABLE IF NOT EXISTS context_snapshots (
  agent_step_id TEXT PRIMARY KEY REFERENCES agent_steps(id) ON DELETE CASCADE,
  summary_json TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  artifact_storage TEXT NOT NULL DEFAULT 'inline' CHECK (
    artifact_storage IN ('inline', 'external')
  ),
  artifact_hash TEXT,
  artifact_size INTEGER
);
CREATE TABLE IF NOT EXISTS step_diffs (
  agent_step_id TEXT PRIMARY KEY REFERENCES agent_steps(id) ON DELETE CASCADE,
  diff_json TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  artifact_storage TEXT NOT NULL DEFAULT 'inline' CHECK (
    artifact_storage IN ('inline', 'external')
  ),
  artifact_hash TEXT,
  artifact_size INTEGER
);
CREATE TABLE IF NOT EXISTS learning_insights (
  agent_turn_id TEXT PRIMARY KEY REFERENCES agent_turns(id) ON DELETE CASCADE,
  insight_json TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS derivation_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange_id TEXT,
  source_id INTEGER REFERENCES ingestion_sources(id),
  ingestion_record_id INTEGER REFERENCES ingestion_records(id),
  projection_version INTEGER,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pricing_catalog_blobs (
  hash TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pricing_policy_blobs (
  hash TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pricing_config_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  effective_at TEXT NOT NULL,
  catalog_hash TEXT NOT NULL REFERENCES pricing_catalog_blobs(hash),
  policy_hash TEXT NOT NULL REFERENCES pricing_policy_blobs(hash),
  created_at TEXT NOT NULL,
  UNIQUE (effective_at, catalog_hash, policy_hash)
);
CREATE INDEX IF NOT EXISTS idx_sessions_latest
  ON agent_sessions(target_id, agent_fingerprint_id, end_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_target_agent_latest
  ON agent_sessions(target_id, agent_name, end_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_global_latest
  ON agent_sessions(end_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_external
  ON agent_sessions(target_id, agent_name, external_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_conversation
  ON agent_sessions(target_id, agent_name, external_conversation_id);
CREATE INDEX IF NOT EXISTS idx_threads_children
  ON agent_threads(agent_session_id, parent_agent_thread_id, end_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_threads_external
  ON agent_threads(agent_session_id, external_thread_id);
CREATE INDEX IF NOT EXISTS idx_threads_agent
  ON agent_threads(agent_session_id, external_agent_id);
CREATE INDEX IF NOT EXISTS idx_threads_root
  ON agent_threads(agent_session_id, is_root, id);
CREATE INDEX IF NOT EXISTS idx_thread_closure_descendant
  ON thread_closure(descendant_thread_id, ancestor_thread_id, depth);
CREATE INDEX IF NOT EXISTS idx_turns_latest
  ON agent_turns(agent_thread_id, end_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_turns_open
  ON agent_turns(agent_thread_id, status, segment_index DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_turns_native
  ON agent_turns(agent_thread_id, native_turn_id, segment_index DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_turns_segment
  ON agent_turns(agent_thread_id, segment_index DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_steps_latest
  ON agent_steps(agent_turn_id, step_index DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_steps_session_time
  ON agent_steps(agent_session_id, timestamp DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_steps_thread_time
  ON agent_steps(agent_thread_id, timestamp DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_steps_turn_time
  ON agent_steps(agent_turn_id, timestamp DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_aux_session_time
  ON auxiliary_requests(agent_session_id, timestamp DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_aux_thread_time
  ON auxiliary_requests(agent_thread_id, timestamp DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_aux_turn_time
  ON auxiliary_requests(agent_turn_id, timestamp DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_aux_target_time
  ON auxiliary_requests(target_id, timestamp DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_usage_session_time
  ON usage_ledger(agent_session_id, created_at DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_usage_global_time
  ON usage_ledger(created_at DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_usage_thread_time
  ON usage_ledger(agent_thread_id, created_at DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_usage_turn_time
  ON usage_ledger(agent_turn_id, created_at DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_usage_step
  ON usage_ledger(agent_step_id);
CREATE INDEX IF NOT EXISTS idx_usage_billing_channel
  ON usage_ledger(billing_channel, created_at DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_usage_vendor_family
  ON usage_ledger(vendor_family, created_at DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_usage_analytics_time
  ON usage_ledger(created_at, target_id, agent_name, model, exchange_id);
CREATE INDEX IF NOT EXISTS idx_usage_analytics_dimensions
  ON usage_ledger(created_at, agent_name, vendor, model);
CREATE INDEX IF NOT EXISTS idx_usage_analytics_quality
  ON usage_ledger(created_at, usage_quality, pricing_status, result_class);
CREATE INDEX IF NOT EXISTS idx_tools_thread_name
  ON tool_calls(agent_thread_id, tool_name);
CREATE INDEX IF NOT EXISTS idx_tools_session_name
  ON tool_calls(agent_session_id, tool_name);
CREATE INDEX IF NOT EXISTS idx_tools_turn_name
  ON tool_calls(agent_turn_id, tool_name);
CREATE INDEX IF NOT EXISTS idx_tools_turn_use
  ON tool_calls(agent_turn_id, tool_use_id, agent_thread_id);
CREATE INDEX IF NOT EXISTS idx_tools_turn_step_name_status
  ON tool_calls(agent_turn_id, agent_step_id, tool_name, status);
CREATE INDEX IF NOT EXISTS idx_tools_step_name_status
  ON tool_calls(agent_step_id, tool_name, status);
CREATE INDEX IF NOT EXISTS idx_raw_capture_time
  ON raw_exchange_refs(capture_session_id, captured_at DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_raw_origin
  ON raw_exchange_refs(origin, captured_at DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_raw_captured
  ON raw_exchange_refs(captured_at DESC, exchange_id DESC);
CREATE INDEX IF NOT EXISTS idx_diagnostics_dedupe
  ON derivation_diagnostics(code, details_json, exchange_id, source_id);
CREATE INDEX IF NOT EXISTS idx_pricing_revisions_effective
  ON pricing_config_revisions(effective_at DESC, id DESC);
${RETENTION_V30_INDEXES_SQL}
${MIGRATION_13_TO_14_SQL}
${MIGRATION_14_TO_15_SQL}
${CATALOG_NOTIFICATIONS_V25_SQL}
${CATALOG_SYNC_EFFECTS_V42_SQL}
${OFFICIAL_CATALOG_MEMBERSHIP_V43_SQL}
${PRICING_SOURCE_BASELINES_V44_SQL}
${RELAY_RECONCILIATION_V45_SQL}
${RELAY_RECONCILIATION_V46_SQL}
${PLAN_ESTIMATE_SETTLEMENTS_V52_SQL}
${LARGE_BODY_INDEXES_SQL}
${ANALYTICS_TABLES_SQL}
${HARNESS_SNAPSHOTS_V27_SQL}
${AGENT_LOCAL_IMPORT_V32_SQL}
${AGENT_LOCAL_IMPORT_SEEN_V34_SQL}
`;

/**
 * 在修改连接或数据库前拒绝未来 schema，读写连接必须共用同一错误语义。
 */
export function assertDeepaaSchemaCompatible(
  db: DeepaaDatabase,
): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `数据库版本 ${current} 高于程序版本 ${SCHEMA_VERSION}`,
    );
  }
  return current;
}

/**
 * 在单个事务中完成迁移，任何 SQL 失败都不会留下半升级 schema。
 */
export function migrateDeepaaDatabase(db: DeepaaDatabase): void {
  const migrate = db.transaction(() => {
    const current = assertDeepaaSchemaCompatible(db);
    if (current === SCHEMA_VERSION) {
      return;
    }

    if (current === 0) {
      db.exec(SCHEMA_SQL);
    } else {
      if (current < 2) {
        db.exec(MIGRATION_1_TO_2_SQL);
      }
      if (current < 3) {
        db.exec(MIGRATION_2_TO_3_SQL);
      }
      if (current < 4) {
        db.exec(MIGRATION_3_TO_4_SQL);
      }
      if (current < 5) {
        db.exec(MIGRATION_4_TO_5_SQL);
      }
      if (current < 6) {
        db.exec(MIGRATION_5_TO_6_SQL);
      }
      if (current < 7) {
        db.exec(MIGRATION_6_TO_7_SQL);
      }
      if (current < 8) {
        migrateExportQueryIndexes(db);
      }
      if (current < 9) {
        db.exec(MIGRATION_8_TO_9_SQL);
      }
      if (current < 10) {
        migrateTargetLevelAuxiliaryRequests(db);
      }
      if (current < 11) {
        migrateLargeBodyIngestion(db);
      }
      if (current < 12) {
        migrateContentFilterProjections(db);
      }
      if (current < 13) {
        migrateUnifiedConversationSemanticsV13(db);
      }
      if (current < 14) {
        db.exec(MIGRATION_13_TO_14_SQL);
      }
      if (current < 15) {
        db.exec(MIGRATION_14_TO_15_SQL);
      }
      if (current < 16) {
        migrateUsageLedgerBaseFields(db);
      }
      if (current < 17) {
        migrateUsageLedgerChannelFields(db);
      }
      if (current < 18) {
        migrateUsageLedgerPlanCreditFields(db);
      }
      if (current < 19) {
        migrateAgentIdentityEvidenceV19(db);
      }
      if (current < 20) {
        migrateAnalyticsAuditV20(db);
      }
      if (current < 21) {
        migrateUsageLedgerFirstTokenMs(db);
      }
      if (current < 22) {
        migrateSyncIntervalMinutesV22(db);
      }
      if (current < 23) {
        migratePlanQuotaRemainingV23(db);
      }
      if (current < 24) {
        migrateUsageLedgerServiceTierV24(db);
      }
      if (current < 25) {
        migrateCatalogUpdateNotificationsV25(db);
      }
      if (current < 26) {
        migrateCatalogNotificationSourceV26(db);
      }
      if (current < 27) {
        migrateHarnessEvidenceV27(db);
      }
      if (current < 28) {
        migrateStepStopReasonV28(db);
      }
      if (current < 29) {
        migrateRequestFingerprintsBlobV29(db);
      }
      if (current < 30) {
        migrateRetentionWindowAndRawStateV30(db);
      }
      if (current < 31) {
        migratePlanEstimatedV31(db);
      }
      if (current < 32) {
        migrateAgentLocalImportV32(db);
      }
      if (current < 33) {
        migrateAgentLocalImportBackfillV33(db);
      }
      if (current < 34) {
        migrateAgentLocalImportSeenV34(db);
      }
      if (current < 35) {
        migrateLedgerCostGateV35(db);
      }
      if (current < 36) {
        migratePromptSkeletonsV36(db);
        migrateExportGlobalTimeIndexV36(db);
      }
      if (current < 37) {
        migrateAgentLocalIdentityLinksV37(db);
      }
      if (current < 38) {
        migrateAgentLocalIdentityLinksRootV38(db);
      }
      if (current < 39) {
        migrateRetireReprojectionJobsV39(db);
      }
      if (current < 40) {
        migrateSyncConsecutiveFailuresV40(db);
      }
      if (current < 41) {
        migrateSyncConsecutiveFailureKindV41(db);
      }
      if (current < 42) {
        migrateCatalogSyncEffectsV42(db);
      }
      if (current < 43) {
        migrateOfficialCatalogMembershipV43(db);
      }
      if (current < 44) {
        migratePricingSourceBaselinesV44(db);
      }
      if (current < 45) {
        migrateRelayReconciliationV45(db);
      }
      if (current < 46) {
        migrateRelayReconciliationV46(db);
      }
      if (current < 47) {
        migrateRelayReconciliationDiscountV47(db);
      }
      if (current < 48) {
        migrateRelayReconciliationResidualV48(db);
      }
      if (current < 49) {
        migratePlanEstimatedMethodV49(db);
      }
      if (current < 50) {
        migrateRelayReconciliationUsageCarrierV50(db);
      }
      if (current < 51) {
        migrateCacheTtlUsageV51(db);
      }
      if (current < 52) {
        migratePlanEstimateSettlementsV52(db);
      }
    }
    db.prepare(
      `INSERT INTO schema_meta(
        id, schema_version, initialized_at, data_version, worker_status
      ) VALUES(1, ?, ?, 0, 'idle')
      ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version`,
    ).run(SCHEMA_VERSION, new Date().toISOString());
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });

  migrate();

  /* 2026-09-05 四层分离列（vendor_cost_cny/actual_cost_cny/fx_rate_to_cny）：
     幂等补齐——已迁移到当前版本但缺列的存量库（如本次发布前的 v24 库）也需要补齐，
     因此放在版本闸门之外无条件执行（hasColumn 守卫）。 */
  migrateUsageLedgerSettlementColumns(db);
}

function migrateUsageLedgerSettlementColumns(db: DeepaaDatabase): void {
  /* 兼容「版本已达标但 usage_ledger 尚未建立」的极简/半初始化库：跳过即可，
     建表 SQL 已包含新列，后续正常建库路径自带。 */
  if (!hasTable(db, "usage_ledger")) return;
  if (!hasColumn(db, "usage_ledger", "vendor_cost_cny")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN vendor_cost_cny REAL");
    db.exec("UPDATE usage_ledger SET vendor_cost_cny = vendor_cost WHERE vendor_cost_cny IS NULL");
  }
  if (!hasColumn(db, "usage_ledger", "actual_cost_cny")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN actual_cost_cny REAL");
    db.exec("UPDATE usage_ledger SET actual_cost_cny = actual_cost WHERE actual_cost_cny IS NULL");
  }
  if (!hasColumn(db, "usage_ledger", "fx_rate_to_cny")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN fx_rate_to_cny REAL NOT NULL DEFAULT 1");
  }
}

/** v31（2026-09-15）：套餐成本估算入账冻结——账本冻结列 + facts 聚合列。 */
function migratePlanEstimatedV31(db: DeepaaDatabase): void {
  const now = new Date().toISOString();
  if (hasTable(db, "usage_ledger")) {
    if (!hasColumn(db, "usage_ledger", "plan_estimated_cost")) {
      db.exec("ALTER TABLE usage_ledger ADD COLUMN plan_estimated_cost REAL");
    }
    if (!hasColumn(db, "usage_ledger", "plan_estimated_currency")) {
      db.exec("ALTER TABLE usage_ledger ADD COLUMN plan_estimated_currency TEXT");
    }
    if (!hasColumn(db, "usage_ledger", "plan_estimated_fx")) {
      db.exec("ALTER TABLE usage_ledger ADD COLUMN plan_estimated_fx REAL");
    }
    if (!hasColumn(db, "usage_ledger", "plan_estimated_cost_nano")) {
      db.exec("ALTER TABLE usage_ledger ADD COLUMN plan_estimated_cost_nano INTEGER");
    }
    if (!hasColumn(db, "usage_ledger", "plan_estimated_status")) {
      db.exec("ALTER TABLE usage_ledger ADD COLUMN plan_estimated_status TEXT");
    }
    if (!hasColumn(db, "usage_ledger", "plan_estimate_detail_json")) {
      db.exec("ALTER TABLE usage_ledger ADD COLUMN plan_estimate_detail_json TEXT");
    }
  }
  if (hasTable(db, "analytics_hourly_facts")) {
    if (!hasColumn(db, "analytics_hourly_facts", "plan_estimated_nano")) {
      db.exec("ALTER TABLE analytics_hourly_facts ADD COLUMN plan_estimated_nano INTEGER NOT NULL DEFAULT 0");
    }
    if (!hasColumn(db, "analytics_hourly_facts", "plan_estimated_pending_request_count")) {
      db.exec("ALTER TABLE analytics_hourly_facts ADD COLUMN plan_estimated_pending_request_count INTEGER NOT NULL DEFAULT 0");
    }
    // 既有桶按新聚合口径重滚（rollup 从 usage_ledger 重新聚合，不重算价格、不动账本）；
    // 旧口径行在聚合中计入 pending，前端标注「部分估算」。INSERT OR IGNORE 保证可重入
    // （INSERT..SELECT..ON CONFLICT 有解析歧义，必须避免）。
    db.prepare(`INSERT OR IGNORE INTO analytics_dirty_buckets(bucket_start_utc, reason, first_seen_at, last_seen_at, available_at)
      SELECT DISTINCT bucket_start_utc, 'schema_v31_plan_estimated', ?, ?, ?
      FROM analytics_hourly_facts`)
      .run(now, now, now);
  }
}

/**
 * v35（2026-09-16 用户确认）：按量金额物化口径对齐 Token 价格页——facts 倍率后改用与
 * 账本一致的共享表达式（ledger-cost-exprs.ts），估算/不可用用量行记 0。既有桶全部标脏，
 * 由 rollup worker 从 usage_ledger 重滚（不重算价格、不动账本，与 v31 同一机制）。
 */
/** v49（2026-09-29 额度差分估算回填）：估算来源标记列。NULL=旧数据、formula=派生期公式、
 *  quota_delta=差分回填补写；仅来源标记不改变聚合值，无需重滚既有桶。 */
function migratePlanEstimatedMethodV49(db: DeepaaDatabase): void {
  if (hasTable(db, "usage_ledger") && !hasColumn(db, "usage_ledger", "plan_estimated_method")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN plan_estimated_method TEXT");
  }
}

/**
 * v52（2026-10-09 额度差分估算水位线制）：每 (target, 锚窗) 一行的「已结算基线」游标。
 * 记录最近一次成功消费到的快照批（captured_at/used/reset_at/total），保证同一差分段
 * 绝不被重复分摊（派生钩子与低频定时复跑安全幂等），也承载窗口 reset 过渡的开周期基线。
 * 只增表，不触碰账本与聚合。
 */
function migratePlanEstimateSettlementsV52(db: DeepaaDatabase): void {
  db.exec(PLAN_ESTIMATE_SETTLEMENTS_V52_SQL);
}

function migrateLedgerCostGateV35(db: DeepaaDatabase): void {
  if (!hasTable(db, "analytics_hourly_facts")) {
    return;
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO analytics_dirty_buckets(bucket_start_utc, reason, first_seen_at, last_seen_at, available_at)
    SELECT DISTINCT bucket_start_utc, 'schema_v35_ledger_cost_gate', ?, ?, ?
    FROM analytics_hourly_facts`)
    .run(now, now, now);
}

/** 早期测试 schema 不含业务账本；只有完整 v9 数据库才执行表重建。 */
function migrateTargetLevelAuxiliaryRequests(db: DeepaaDatabase): void {
  if (
    !hasTable(db, "auxiliary_requests")
    || !hasTable(db, "usage_ledger")
    || !hasTable(db, "raw_exchange_refs")
    || !hasTable(db, "agent_steps")
    || !hasTable(db, "agent_turns")
  ) {
    return;
  }
  db.exec(MIGRATION_9_TO_10_SQL);
}

/** 旧测试和早期开发库可能只包含部分 v1-v9 表；只对完整摄取 schema 增量升级。 */
function migrateLargeBodyIngestion(db: DeepaaDatabase): void {
  if (
    !hasTable(db, "ingestion_sources")
    || !hasTable(db, "raw_exchange_refs")
    || !hasTable(db, "derivation_diagnostics")
  ) {
    return;
  }
  db.exec(INGESTION_RECORDS_SQL);
  if (!hasColumn(db, "raw_exchange_refs", "ingestion_record_id")) {
    db.exec(`ALTER TABLE raw_exchange_refs ADD COLUMN ingestion_record_id INTEGER
      REFERENCES ingestion_records(id)`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_ingestion_record
    ON raw_exchange_refs(ingestion_record_id)
    WHERE ingestion_record_id IS NOT NULL`);
  db.exec(LARGE_BODY_PROJECTIONS_SQL);
  if (!hasColumn(db, "derivation_diagnostics", "ingestion_record_id")) {
    db.exec(`ALTER TABLE derivation_diagnostics ADD COLUMN ingestion_record_id INTEGER
      REFERENCES ingestion_records(id)`);
  }
  if (!hasColumn(db, "derivation_diagnostics", "projection_version")) {
    db.exec("ALTER TABLE derivation_diagnostics ADD COLUMN projection_version INTEGER");
  }
  db.exec(LARGE_BODY_INDEXES_SQL);
}

/** 极早期测试 schema 可能还没有业务明细表，迁移只能为已存在的表补索引。 */
function migrateExportQueryIndexes(db: DeepaaDatabase): void {
  if (hasTable(db, "agent_steps")) {
    db.exec(MIGRATION_7_TO_8_SQL);
  }
  if (hasTable(db, "auxiliary_requests")) {
    db.exec(MIGRATION_7_TO_8_AUX_SQL);
  }
}

/** v12 只增加空的筛选投影；历史 Exchange 不在 schema 迁移期间回填。 */
function migrateContentFilterProjections(db: DeepaaDatabase): void {
  if (!hasTable(db, "raw_exchange_refs")) return;
  db.exec(CONTENT_FILTER_PROJECTIONS_SQL);
}

/**
 * v12 曾在开发阶段复用版本号但使用旧筛选表结构。
 * v13 只重建可派生的筛选投影，不迁移或回填历史行。
 */
function migrateUnifiedConversationSemanticsV13(
  db: DeepaaDatabase,
): void {
  if (!hasTable(db, "raw_exchange_refs")) return;
  db.exec(`
    DROP TABLE IF EXISTS exchange_content_category_stats;
    DROP TABLE IF EXISTS exchange_request_fingerprints;
    DROP TABLE IF EXISTS exchange_content_filter_status;
  `);
  db.exec(CONTENT_FILTER_PROJECTIONS_SQL);
}

function hasTable(db: DeepaaDatabase, tableName: string): boolean {
  return db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName) !== undefined;
}

function hasColumn(
  db: DeepaaDatabase,
  tableName: string,
  columnName: string,
): boolean {
  return (db.pragma(`table_info(${tableName})`) as Array<{ name: string }>)
    .some(column => column.name === columnName);
}
