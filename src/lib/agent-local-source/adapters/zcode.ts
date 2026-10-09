/**
 * zcode 本地数据源适配器（双链路观测首实例）：只读 `~/.zcode/cli/db/db.sqlite` 的
 * model_usage/session 与 `~/.zcode/cli/rollout/model-io-*.jsonl` 正文，产出标准
 * LocalUsageRecord。红线：全程只读——readonly 连接 + busy 重试，绝不 checkpoint、
 * 绝不写任何 `~/.zcode` 文件（刻意区别于 zcode-monitor 的 WAL 折叠策略）。
 *
 * 实测依据（2026-09-15）：model_usage.session_id 即请求头 x-session-id 的值，
 * trace_id 即 x-zcode-trace-id；provider_id 经网关为 deepaa-gateway/历史名，
 * 直连为 builtin:*；rollout 文件短命（会话结束后即被 zcode 清理），正文必须趁热读。
 */

import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {createHash} from "node:crypto";
import {existsSync, statSync, createReadStream} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {createInterface} from "node:readline";
import type {
  AgentLocalSourceAdapter,
  LocalExchangeDetail,
  LocalExchangeRef,
  LocalSourceStatus,
  LocalUsageBatch,
  LocalUsageRecord,
  PendingBatchQuery,
  PendingBatchResult,
  PendingImportCandidate,
  SessionTimeline,
  TimelineMessage,
  TimelinePart,
} from "../types";
import {deepaaDatabasePath} from "../../db/connection";

/** 网关 provider 标记（config-sync 写入的自有条目键 + 历史名）；黑名单作防御性双保险。 */
const ZCODE_GATEWAY_PROVIDER_MARKERS = ["deepaa-gateway", "llm-inspector-gateway"] as const;

/**
 * 计费白名单（2026-09-16 用户确认）：只导入正式 Coding Plan 的请求——
 * builtin:bigmodel-start-plan（体验套餐）与任何未列出的 provider（含用户自建
 * 第三方）一律不入账本，保证 token/账本与供应商管理的 zhipu-cn coding plan 对齐。
 * 2026-09-28 zcode 0.16.5 升级：直连用量 provider_id 从 builtin:<套餐> 改为
 * account:<套餐> 且 slug 细化（实测 account:bigmodel-individual-coding-plan）；
 * 旧值保留覆盖 ≤0.15.x 行与旧客户端环境，体验套餐在两套命名下均不在名单。
 */
const ZCODE_ALLOWED_PROVIDER_IDS = [
  "builtin:bigmodel-coding-plan",
  "account:bigmodel-individual-coding-plan",
] as const;

/** 单 session 时间线防御上限（用户确认 64MB）：超限降级为「仅用量」入账，绝不丢行。 */
const MAX_SESSION_TIMELINE_BYTES = 64 * 1024 * 1024;

interface ZcodeAdapterOptions {
  /** 测试注入；缺省 ~/.zcode/cli。 */
  cliDir?: string;
  busyTimeoutMs?: number;
  /** 测试注入：尾部窗口字节上限（缺省 32MiB，与 ZCode 客户端一致）。 */
  rolloutTailBytes?: number;
  /** 测试注入：单次扫描记录上限（缺省 200）。 */
  rolloutScanRecords?: number;
  /** 测试注入：候选查询路径（缺省 "auto" = 跨库下推、环境不支持自动落分块；"chunked" 强制分块）。 */
  candidateQueryMode?: "auto" | "chunked";
}

interface ModelUsageRow {
  id: string;
  attempt_index: number;
  session_id: string;
  turn_id: string | null;
  trace_id: string | null;
  parent_user_message_id: string | null;
  assistant_message_id: string | null;
  query_source: string;
  provider_id: string;
  model_id: string;
  status: string;
  started_at: number;
  first_token_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  finish_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

interface SessionRow {
  id: string;
  directory: string;
}

export function createZcodeLocalSourceAdapter(options: ZcodeAdapterOptions = {}): AgentLocalSourceAdapter {
  // ZCODE_CLI_DIR：测试/多环境隔离入口（与 zcode-monitor 惯例一致）；缺省真实主目录。
  const cliDir = options.cliDir
    ?? process.env.ZCODE_CLI_DIR
    ?? join(homedir(), ".zcode", "cli");
  const dbPath = join(cliDir, "db", "db.sqlite");
  const rolloutDir = join(cliDir, "rollout");
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  const rolloutTailBytes = options.rolloutTailBytes ?? MAX_ROLLOUT_TAIL_BYTES;
  const rolloutScanRecords = options.rolloutScanRecords ?? MAX_ROLLOUT_SCAN_RECORDS;

  const openReadonly = (): DeepaaDatabase => {
    const db = new DeepaaDatabase(dbPath, {readonly: true, timeout: busyTimeoutMs});
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    return db;
  };

  const pushdownEnabled = (options.candidateQueryMode ?? "auto") === "auto";

  /**
   * D2 主案（2026-10-05 用户确认）：DeepAA 库开只读连接 + `PRAGMA query_only`
   * （连接级写阻断）+ 纯路径 ATTACH 本库（SQLite 语义：挂载库继承主库的只读打开
   * 标志）——双向结构性只读，源库绝无被写、被 checkpoint 的可能（红线）。单条
   * SQL 完成 seen 反联 + 目标顺序 + LIMIT，JS 侧只见 ≤limit 行；目标顺序与
   * readPendingCandidates 的 JS 排序逐语义对齐：会话按窗口内最新活动倒序
   * （session_latest = 分组最大 completed_at，对应旧 JS 的 list.at(-1)），并列按
   * 会话最早完成时刻稳定（对应旧 JS 稳定排序的首次相遇序），会话内
   * (completed_at, id) 正序。任何打开/查询失败返回 undefined，调用方自动落
   * 分块备选（语义等价，仅执行路径不同）。
   */
  const readPendingViaPushdown = (query: PendingBatchQuery): PendingBatchResult | undefined => {
    let joinDb: DeepaaDatabase | undefined;
    try {
      joinDb = new DeepaaDatabase(deepaaDatabasePath(query.dataDir), {readonly: true, fileMustExist: true});
      joinDb.pragma(`busy_timeout = ${busyTimeoutMs}`);
      joinDb.pragma("query_only = ON");
      joinDb.exec(`ATTACH DATABASE '${dbPath.replaceAll("'", "''")}' AS src`);
      // seen 反联拆成两个 NOT EXISTS（而非 OR 合写）：两条分支各自命中
      // agent_local_import_seen 主键索引；裸 id 分支为旧路径前缀剥离语义的防御保留。
      const rows = joinDb.prepare(
        `SELECT id, session_id, model_id, completed_at FROM (
           SELECT id, session_id, model_id, completed_at,
                  MAX(completed_at) OVER (PARTITION BY session_id) AS session_latest,
                  MIN(completed_at) OVER (PARTITION BY session_id) AS session_first
           FROM src.model_usage
           WHERE completed_at IS NOT NULL
             AND completed_at >= ?
             AND provider_id IN (${ZCODE_ALLOWED_PROVIDER_IDS.map(() => "?").join(", ")})
             AND provider_id NOT IN (${ZCODE_GATEWAY_PROVIDER_MARKERS.map(() => "?").join(", ")})
             AND LOWER(model_id) IN (${[...query.allowedModels].map(() => "?").join(", ")})
             AND NOT EXISTS (
               SELECT 1 FROM main.agent_local_import_seen s WHERE s.exchange_id = ? || id
             )
             AND NOT EXISTS (
               SELECT 1 FROM main.agent_local_import_seen s WHERE s.exchange_id = id
             )
         )
         ORDER BY session_latest DESC, session_first ASC, completed_at ASC, id ASC
         LIMIT ?`,
      ).all(
        query.floorEpochMs,
        ...ZCODE_ALLOWED_PROVIDER_IDS,
        ...ZCODE_GATEWAY_PROVIDER_MARKERS,
        ...query.allowedModels,
        query.seenExchangeIdPrefix,
        query.limit,
      ) as Array<{id: string; session_id: string; model_id: string; completed_at: number}>;
      return {
        records: rows.map(row => ({
          id: row.id,
          sessionId: row.session_id,
          completedAt: row.completed_at,
          modelId: row.model_id,
        })),
        mode: "pushdown",
      };
    } catch {
      return undefined;
    } finally {
      try { joinDb?.close(); } catch { /* 短命连接，关闭失败无害（下一批重开）。 */ }
    }
  };

  /**
   * D2 备选：分块键集 + seen 批量探测（免跨库挂载；语义与主案逐条等价——同一
   * 候选集、同一顺序、同一幂等反联）。会话清单查询有界（行数 = 窗口内会话数）；
   * 会话内按 (completed_at, id) 键集每块 ≤ CHUNKED_PROBE_ROWS 行，seen 侧每块
   * 一次 IN 批量探测（主键索引），凑满 limit 即停——内存有界，无全量物化、无
   * 全表 Set 构造。最坏情况（无新数据）仍是 O(窗口) 行的顺序访读，但全部经由
   * SQLite 游标逐行流出，不再整窗进 JS。
   */
  const readPendingViaChunkedProbe = (query: PendingBatchQuery): PendingBatchResult => {
    const records: PendingImportCandidate[] = [];
    let seenDb: DeepaaDatabase | undefined;
    let src: DeepaaDatabase | undefined;
    try {
      seenDb = new DeepaaDatabase(deepaaDatabasePath(query.dataDir), {readonly: true, fileMustExist: true});
      seenDb.pragma(`busy_timeout = ${busyTimeoutMs}`);
      src = openReadonly();
      const probeSeen = (ids: readonly string[]): Set<string> => {
        const keys = ids.flatMap(id => [`${query.seenExchangeIdPrefix}${id}`, id]);
        const rows = seenDb!.prepare(
          `SELECT exchange_id FROM agent_local_import_seen WHERE exchange_id IN (${keys.map(() => "?").join(", ")})`,
        ).all(...keys) as Array<{exchange_id: string}>;
        const seen = new Set<string>();
        for (const row of rows) {
          seen.add(row.exchange_id.startsWith(query.seenExchangeIdPrefix)
            ? row.exchange_id.slice(query.seenExchangeIdPrefix.length)
            : row.exchange_id);
        }
        return seen;
      };
      const providerArgs = [...ZCODE_ALLOWED_PROVIDER_IDS, ...ZCODE_GATEWAY_PROVIDER_MARKERS];
      const modelHoles = [...query.allowedModels].map(() => "?").join(", ");
      // 会话清单（有界）：最新活动倒序，并列按会话最早完成时刻稳定（对齐主案排序）。
      const sessions = src.prepare(
        `SELECT session_id FROM model_usage
         WHERE completed_at IS NOT NULL AND completed_at >= ?
           AND provider_id IN (${ZCODE_ALLOWED_PROVIDER_IDS.map(() => "?").join(", ")})
           AND provider_id NOT IN (${ZCODE_GATEWAY_PROVIDER_MARKERS.map(() => "?").join(", ")})
           AND LOWER(model_id) IN (${modelHoles})
         GROUP BY session_id
         ORDER BY MAX(completed_at) DESC, MIN(completed_at) ASC`,
      ).all(query.floorEpochMs, ...providerArgs, ...query.allowedModels) as Array<{session_id: string}>;
      const chunk = src.prepare(
        `SELECT id, session_id, model_id, completed_at FROM model_usage
         WHERE session_id = ? AND completed_at IS NOT NULL AND completed_at >= ?
           AND provider_id IN (${ZCODE_ALLOWED_PROVIDER_IDS.map(() => "?").join(", ")})
           AND provider_id NOT IN (${ZCODE_GATEWAY_PROVIDER_MARKERS.map(() => "?").join(", ")})
           AND LOWER(model_id) IN (${modelHoles})
           AND (completed_at > ? OR (completed_at = ? AND id > ?))
         ORDER BY completed_at ASC, id ASC
         LIMIT ${CHUNKED_PROBE_ROWS}`,
      );
      for (const session of sessions) {
        if (records.length >= query.limit) break;
        // 键集游标从 (0, "") 起步：completed_at 恒为正 epoch 毫秒，首轮全命中。
        let cursorCompletedAt = 0;
        let cursorId = "";
        for (;;) {
          const rows = chunk.all(
            session.session_id, query.floorEpochMs, ...providerArgs, ...query.allowedModels,
            cursorCompletedAt, cursorCompletedAt, cursorId,
          ) as Array<{id: string; session_id: string; model_id: string; completed_at: number}>;
          if (rows.length === 0) break;
          const seen = probeSeen(rows.map(row => row.id));
          for (const row of rows) {
            if (seen.has(row.id)) continue;
            records.push({
              id: row.id,
              sessionId: row.session_id,
              completedAt: row.completed_at,
              modelId: row.model_id,
            });
            if (records.length >= query.limit) break;
          }
          const last = rows.at(-1)!;
          cursorCompletedAt = last.completed_at;
          cursorId = last.id;
          if (rows.length < CHUNKED_PROBE_ROWS) break;
        }
      }
      return {records, mode: "chunked"};
    } finally {
      try { src?.close(); } catch { /* 短命连接 */ }
      try { seenDb?.close(); } catch { /* 短命连接 */ }
    }
  };

  /** D3：批内尾窗复用——同一文件在批内只做一次尾部读取；无缓存时行为与旧路径一致。 */
  const cachedRolloutWindow = async (
    cache: ZcodeRolloutCache | undefined,
    filePath: string,
  ): Promise<{lines: string[]; truncated: boolean} | undefined> => {
    if (!cache) return readRolloutTailWindow(filePath, rolloutTailBytes);
    if (cache.windows.has(filePath)) {
      const hit = cache.windows.get(filePath);
      return hit === undefined ? undefined : {lines: hit.lines, truncated: hit.truncated};
    }
    const window = await readRolloutTailWindow(filePath, rolloutTailBytes);
    cache.windowReads += 1;
    cache.windows.set(filePath, window === undefined
      ? undefined
      : {
          lines: window.lines,
          truncated: window.truncated,
          parsed: new Array(window.lines.length).fill(undefined),
        });
    return window;
  };

  /** D3：尾窗行懒解析缓存（undefined = 未解析 → 解析一次；null = 解析失败复用跳过）。 */
  const cachedParsedAt = (
    cache: ZcodeRolloutCache | undefined,
    filePath: string,
    index: number,
  ): RolloutRecord | null => {
    const entry = cache?.windows.get(filePath);
    if (!entry) return null;
    let value = entry.parsed[index];
    if (value === undefined) {
      try {
        value = JSON.parse(entry.lines[index] ?? "") as RolloutRecord;
      } catch {
        value = null;
      }
      entry.parsed[index] = value;
    }
    return value;
  };

  // 会话时间线读取（64MB 有界；只读）。消息与 parts 各一条有界查询，按 sequence 排序。
  const loadSessionTimeline = (sessionId: string): SessionTimeline | undefined => {
    const db = openReadonly();
    try {
      // WAL 下每条语句各自取快照：message 与 part 必须放进同一个读事务，
      // 否则可能读到「消息已存在、parts 还没写完」的撕裂状态。
      const read = db.transaction((): SessionTimeline | undefined => {
        const size = db.prepare(
          `SELECT (SELECT COALESCE(sum(length(data)),0) FROM message WHERE session_id = ?)
                + (SELECT COALESCE(sum(length(p.data)),0) FROM part p JOIN message m ON m.id = p.message_id
                   WHERE m.session_id = ?) AS total`,
        ).get(sessionId, sessionId) as {total: number};
        if ((size?.total ?? 0) > MAX_SESSION_TIMELINE_BYTES) return undefined;
        const messageRows = db.prepare(
          `SELECT id, data FROM message WHERE session_id = ?
           ORDER BY COALESCE(sequence, 0) ASC, time_created ASC`,
        ).all(sessionId) as Array<{id: string; data: string}>;
        if (messageRows.length === 0) return undefined;
        const ids = messageRows.map(row => row.id);
        const partRows = db.prepare(
          `SELECT message_id, data FROM part
           WHERE message_id IN (${ids.map(() => "?").join(",")})
           ORDER BY message_id ASC, COALESCE(sequence, 0) ASC, time_created ASC`,
        ).all(...ids) as Array<{message_id: string; data: string}>;
        const partsByMessage = new Map<string, TimelinePart[]>();
        for (const row of partRows) {
          const part = mapTimelinePart(row.data);
          if (part) {
            let list = partsByMessage.get(row.message_id);
            if (!list) partsByMessage.set(row.message_id, list = []);
            list.push(part);
          }
        }
        const messages: TimelineMessage[] = [];
        for (const row of messageRows) {
          let parsed: {
            role?: string;
            time?: {completed?: number};
            semantics?: {providerVisibility?: string; origin?: string};
          };
          try {
            parsed = JSON.parse(row.data) as typeof parsed;
          } catch {
            continue;
          }
          const role = parsed.role === "assistant" ? "assistant" : parsed.role === "user" ? "user" : undefined;
          if (!role) continue;
          const parts = partsByMessage.get(row.id) ?? [];
          // 终态：assistant 必须先写 parts（含 step-finish）再写 time.completed。
          const finalized = role !== "assistant"
            || (
              typeof parsed.time?.completed === "number"
              && parts.some(part => part.kind === "step_finish")
            );
          messages.push({
            messageId: row.id,
            role,
            visible: parsed.semantics?.providerVisibility !== "hidden",
            finalized,
            // 注入判定（2026-09-16）：zcode 以 semantics.origin 区分真实用户
            // （real_user）与运行时注入（agent_runtime，如 todo_reminder）。
            ...(role === "user" && parsed.semantics?.origin !== undefined
              ? {injected: parsed.semantics.origin !== "real_user"}
              : {}),
            parts,
          });
        }
        return {messages};
      });
      return read();
    } catch {
      return undefined;
    } finally {
      db.close();
    }
  };

  return {
    agentId: "zcode",
    label: "ZCode",
    // 直连导入必须开启：zcode 客户端专属权益要求直连（代理模式拿不到），直连行
    // 是该 Agent 套餐用量的唯一权威记录。
    directImportEnabled: true,
    gatewayProviderMarkers: ZCODE_GATEWAY_PROVIDER_MARKERS,
    allowedProviderIds: ZCODE_ALLOWED_PROVIDER_IDS,
    officialUpstreamBaseUrl: "https://open.bigmodel.cn/api/anthropic",
    protocolPath: "/v1/messages",
    readSessionTimeline: async (sessionId) => loadSessionTimeline(sessionId),

    async discover(): Promise<LocalSourceStatus> {
      if (!existsSync(cliDir)) {
        return {availability: {state: "missing", reason: "ZCODE_CLI_DIR_MISSING"}, dataDir: cliDir};
      }
      if (!existsSync(dbPath)) {
        return {availability: {state: "missing", reason: "ZCODE_DB_MISSING"}, dataDir: cliDir};
      }
      try {
        const db = openReadonly();
        try {
          const row = db.prepare(
            "SELECT app_version FROM schema_migration ORDER BY rowid DESC LIMIT 1",
          ).get() as {app_version?: string} | undefined;
          return {
            availability: {state: "available"},
            dataDir: cliDir,
            ...(row?.app_version ? {localSchemaVersion: row.app_version} : {}),
          };
        } finally {
          db.close();
        }
      } catch (error) {
        return {
          availability: {state: "unreadable", reason: error instanceof Error ? error.message : String(error)},
          dataDir: cliDir,
        };
      }
    },

    readPendingCandidates(floorEpochMs: number, allowedModels: ReadonlySet<string>): PendingImportCandidate[] {
      const db = openReadonly();
      try {
        const markers = ZCODE_GATEWAY_PROVIDER_MARKERS;
        // 轻量候选列（排序/筛选所需），全量水合走 hydrateUsageRecords。
        const rows = db.prepare(
          `SELECT id, session_id, model_id, completed_at
           FROM model_usage
           WHERE completed_at IS NOT NULL
             AND completed_at >= ?
             AND provider_id IN (${ZCODE_ALLOWED_PROVIDER_IDS.map(() => "?").join(", ")})
             AND provider_id NOT IN (${markers.map(() => "?").join(", ")})
             AND LOWER(model_id) IN (${[...allowedModels].map(() => "?").join(", ")})
           ORDER BY completed_at ASC, id ASC`,
        ).all(
          floorEpochMs,
          ...ZCODE_ALLOWED_PROVIDER_IDS,
          ...markers,
          ...allowedModels,
        ) as Array<{id: string; session_id: string; model_id: string; completed_at: number}>;
        // 目标顺序：session 按组内最新活动倒序（用户最先看到最新会话），
        // 同 session 内按完成时间正序（步骤号/标签/差分的派生序依赖，用户确认）。
        const bySession = new Map<string, PendingImportCandidate[]>();
        for (const row of rows) {
          const candidate: PendingImportCandidate = {
            id: row.id,
            sessionId: row.session_id,
            completedAt: row.completed_at,
            modelId: row.model_id,
          };
          let list = bySession.get(row.session_id);
          if (!list) bySession.set(row.session_id, list = []);
          list.push(candidate);
        }
        const sessions = [...bySession.values()];
        sessions.sort((left, right) => {
          const leftLatest = left.at(-1)?.completedAt ?? 0;
          const rightLatest = right.at(-1)?.completedAt ?? 0;
          return rightLatest - leftLatest;
        });
        return sessions.flat();
      } finally {
        db.close();
      }
    },

    readPendingBatch(query: PendingBatchQuery): PendingBatchResult {
      // 防御：空模型面在绑定推导层已排除（bound 态保证非空）；直连调用空集时
      // 直接返回空批（SQL 空 IN 列表非法，且语义上不存在候选）。
      if (query.allowedModels.size === 0) return {records: [], mode: "chunked"};
      if (pushdownEnabled) {
        const pushed = readPendingViaPushdown(query);
        if (pushed !== undefined) return pushed;
      }
      return readPendingViaChunkedProbe(query);
    },

    hydrateUsageRecords(ids: readonly string[]): LocalUsageBatch {
      if (ids.length === 0) return {records: []};
      const db = openReadonly();
      try {
        const rows = db.prepare(
          `SELECT id, attempt_index, session_id, turn_id, trace_id, parent_user_message_id, assistant_message_id, query_source,
                  provider_id, model_id, status, started_at, first_token_at,
                  completed_at, duration_ms, finish_reason, error_code, error_message,
                  input_tokens, output_tokens, reasoning_tokens,
                  cache_creation_input_tokens, cache_read_input_tokens
           FROM model_usage
           WHERE id IN (${ids.map(() => "?").join(", ")})`,
        ).all(...ids) as ModelUsageRow[];
        const byId = new Map(rows.map(row => [row.id, row]));
        return {records: ids.map(id => byId.get(id)).filter((row): row is ModelUsageRow => row !== undefined).map(hydrateUsageRow)};
      } finally {
        db.close();
      }
    },

    normalizeModelId(modelId: string): string {
      return modelId.trim().toLowerCase();
    },

    createRolloutCache(): ZcodeRolloutCache {
      return {windows: new Map(), windowReads: 0};
    },

    async readExchangeDetail(ref: LocalExchangeRef, rolloutCache?: unknown): Promise<LocalExchangeDetail | undefined> {
      const cache = rolloutCache as ZcodeRolloutCache | undefined;
      const filePath = join(rolloutDir, `model-io-${ref.sessionId}.jsonl`);
      const window = await cachedRolloutWindow(cache, filePath);
      if (!window) return undefined;
      // 从尾部（最新）向前扫描：命中即停，单次读取上限 32MiB / 200 条。
      // 与 ZCode 自身读取器同构（readTrajectoryFileTail + 尾部 200 条），
      // 但不再因为文件超过 64MiB 就整段放弃——那正是导入缺骨架的主因。
      let scanned = 0;
      let best: {record: RolloutRecord; score: number} | undefined;
      for (let index = window.lines.length - 1; index >= 0; index -= 1) {
        const line = window.lines[index]!;
        if (!line.trim()) continue;
        scanned += 1;
        if (scanned > rolloutScanRecords) break;
        let parsed: RolloutRecord | null;
        if (cache) {
          parsed = cachedParsedAt(cache, filePath, index);
        } else {
          try {
            parsed = JSON.parse(line) as RolloutRecord;
          } catch {
            continue;
          }
        }
        if (parsed === null) continue;
        if (ref.requestId) {
          if (parsed.requestId === ref.requestId) {
            best = {record: parsed, score: Number.MIN_SAFE_INTEGER};
            break;
          }
          continue;
        }
        // 主匹配键 turnId（model_usage.turn_id 与 rollout.turnId 同值，实测零反例）；
        // 同 Turn 多记录时按 startedAt 邻近度取最优；无 turnId 退回时间邻近。
        const candidateAt = epochMsOf(parsed.startedAt);
        let score: number;
        if (ref.turnId && parsed.turnId) {
          if (parsed.turnId !== ref.turnId) continue;
          score = candidateAt !== undefined && ref.startedAt !== undefined
            ? Math.abs(candidateAt - ref.startedAt)
            : 0;
        } else if (candidateAt !== undefined && ref.startedAt !== undefined) {
          score = Math.abs(candidateAt - ref.startedAt);
        } else {
          continue;
        }
        if (!matchesRefIdentity(parsed, ref)) continue;
        if (score <= TOLERANCE_MS && (!best || score < best.score)) {
          best = {record: parsed, score};
        }
      }
      return best ? toDetail(best.record) : undefined;
    },

    /**
     * 幂等列出尾部窗口内的全部记录（骨架清扫用）：一次尾部读取即可为窗口内
     * 所有记录补齐 system/tools，不必等到逐条导入。
     */
    async readRecentRecords(sessionId: string, rolloutCache?: unknown): Promise<LocalExchangeDetail[]> {
      const cache = rolloutCache as ZcodeRolloutCache | undefined;
      const filePath = join(rolloutDir, `model-io-${sessionId}.jsonl`);
      const window = await cachedRolloutWindow(cache, filePath);
      if (!window) return [];
      const details: LocalExchangeDetail[] = [];
      for (let index = window.lines.length - 1; index >= 0; index -= 1) {
        if (details.length >= rolloutScanRecords) break;
        const line = window.lines[index]!;
        if (!line.trim()) continue;
        let parsed: RolloutRecord | null;
        if (cache) {
          parsed = cachedParsedAt(cache, filePath, index);
        } else {
          try {
            parsed = JSON.parse(line) as RolloutRecord;
          } catch {
            continue;
          }
        }
        if (parsed === null) continue;
        details.push(toDetail(parsed));
      }
      return details;
    },
  };
}

/**
 * 批内 rollout 尾窗缓存（2026-10-05 D3 去重，用户确认）：骨架清扫与逐条正文
 * 读取共享同一次尾部窗口读取与逐行懒解析。生命周期 = 一个批次（由调度器创建、
 * 批内透传）；批内文件追加不影响正确性——批内候选在缓存建立前已完成，其正文
 * 行必然已在窗口内。
 */
export interface ZcodeRolloutCache {
  /** filePath → 尾窗条目；值为 undefined = 文件缺失（同样缓存，避免逐条重复探测）。 */
  windows: Map<string, {
    lines: string[];
    truncated: boolean;
    /** 懒解析行缓冲：undefined = 未解析；null = 解析失败；对象 = 已解析。 */
    parsed: Array<RolloutRecord | null | undefined>;
  } | undefined>;
  /** 观测：实际尾窗读取次数（测试断言批内去重：一批 15 条 + 骨架清扫 = 每会话 1 次）。 */
  windowReads: number;
}

/** 尾部窗口读取上限：与 ZCode 客户端一致（32MiB），避免整文件扫描。 */
const MAX_ROLLOUT_TAIL_BYTES = 32 * 1024 * 1024;
/** 单次扫描的记录上限（ZCode 客户端取尾部 200 条）。 */
const MAX_ROLLOUT_SCAN_RECORDS = 200;
/** 分块反联（pushdown 不可用时的备选路径）单块候选行数上限。 */
const CHUNKED_PROBE_ROWS = 500;

/**
 * 记录身份判别（2026-09-17）：同一 Turn 内的 session_title 与 main_turn 记录可能只差
 * 几毫秒（实测 title 23:20:54.306 / main 23:20:54.315，而 usage.started_at 23:20:54.301），
 * 仅按时间邻近会把标题请求的正文当成主请求的正文——请求体于是丢掉 tools 与真实
 * system，交互内容与排重链一起失真。querySource / modelId 是 rollout 记录里可
 * 直接对上的判别键，任一不一致即排除。
 */
function matchesRefIdentity(record: RolloutRecord, ref: LocalExchangeRef): boolean {
  if (ref.querySource && record.querySource && record.querySource !== ref.querySource) {
    return false;
  }
  const recordModel = record.model?.modelId;
  if (ref.modelId && recordModel
    && recordModel.trim().toLowerCase() !== ref.modelId.trim().toLowerCase()) {
    return false;
  }
  return true;
}

/**
 * 只读文件尾部窗口（绝不整文件读取）：超过 32MiB 时从中间开始，首行可能是半行，
 * 解析失败会被逐行 JSON.parse 自然跳过。
 */
async function readRolloutTailWindow(
  filePath: string,
  maxBytes: number = MAX_ROLLOUT_TAIL_BYTES,
): Promise<{lines: string[]; truncated: boolean} | undefined> {
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    return undefined;
  }
  if (size <= 0) return undefined;
  const start = Math.max(0, size - maxBytes);
  try {
    const stream = createReadStream(filePath, {encoding: "utf8", start});
    let text = "";
    for await (const chunk of stream) text += chunk as string;
    return {lines: text.split("\n"), truncated: start > 0};
  } catch {
    return undefined;
  }
}

/** 用户输入文本上限（预览层还有 256KiB 收敛，这里防异常大粘贴撑爆合成行）。 */
const MAX_USER_TEXT_CHARS = 16_000;


/** startedAt 邻近容差：同一 Turn 的请求与本地行的时间差上限（时钟序的正常差异远小于此）。 */
const TOLERANCE_MS = 30_000;

/** 按主键集合水合完整用量记录（顺序由调用方的候选顺序决定）。 */
function hydrateUsageRow(row: ModelUsageRow): LocalUsageRecord {
  return {
    id: row.id,
    attemptIndex: row.attempt_index ?? 0,
    providerId: row.provider_id,
    modelId: row.model_id,
    querySource: row.query_source,
    status: row.status as LocalUsageRecord["status"],
    startedAt: row.started_at,
    ...(row.completed_at !== null ? {completedAt: row.completed_at} : {}),
    ...(row.duration_ms !== null ? {durationMs: row.duration_ms} : {}),
    ...(row.first_token_at !== null ? {firstTokenMs: Math.max(0, row.first_token_at - row.started_at)} : {}),
    ...(row.finish_reason !== null ? {finishReason: row.finish_reason} : {}),
    ...(row.error_code !== null ? {errorCode: row.error_code} : {}),
    ...(row.error_message !== null ? {errorMessage: row.error_message} : {}),
    usage: {
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      reasoningTokens: row.reasoning_tokens ?? 0,
      cacheCreationTokens: row.cache_creation_input_tokens ?? 0,
      cacheReadTokens: row.cache_read_input_tokens ?? 0,
    },
    sessionId: row.session_id,
    ...(row.turn_id !== null ? {turnId: row.turn_id} : {}),
    ...(row.trace_id !== null ? {traceId: row.trace_id} : {}),
    ...(row.assistant_message_id !== null ? {assistantMessageId: row.assistant_message_id} : {}),
    detailRef: {
      sessionId: row.session_id,
      ...(row.turn_id !== null ? {turnId: row.turn_id} : {}),
      startedAt: row.started_at,
      // 消歧键：同 Turn 内 session_title 与 main_turn 记录可能只差几毫秒。
      ...(row.query_source ? {querySource: row.query_source} : {}),
      ...(row.model_id ? {modelId: row.model_id} : {}),
    },
  };
}

function mapTimelinePart(raw: string): TimelinePart | undefined {
  let part: {
    type?: string;
    text?: string;
    reason?: string;
    tool?: string;
    callID?: string;
    state?: {status?: string; input?: unknown; output?: unknown};
    timelineType?: string;
    compactBoundary?: {tailStartMessageId?: string};
    tail_start_id?: string;
  };
  try {
    part = JSON.parse(raw) as typeof part;
  } catch {
    return undefined;
  }
  switch (part.type) {
    case "text":
      return {kind: "text", ...(typeof part.text === "string" ? {text: part.text} : {})};
    case "reasoning":
      return {kind: "reasoning", ...(typeof part.text === "string" ? {text: part.text} : {})};
    case "tool":
      return {
        kind: "tool",
        ...(typeof part.tool === "string" ? {toolName: part.tool} : {}),
        ...(typeof part.callID === "string" ? {callId: part.callID} : {}),
        toolStatus: typeof part.state?.status === "string" ? part.state.status : undefined,
        ...(part.state?.input !== undefined ? {toolInput: part.state.input} : {}),
        ...(part.state?.output !== undefined
          ? {toolOutput: typeof part.state.output === "string" ? part.state.output : JSON.stringify(part.state.output)}
          : {}),
      };
    case "step-finish":
      return {kind: "step_finish", ...(typeof part.reason === "string" ? {reason: part.reason} : {})};
    case "compaction":
      return {
        kind: "compaction",
        ...(typeof part.tail_start_id === "string" ? {tailMessageId: part.tail_start_id} : {}),
      };
    default:
      return {kind: "other"};
  }
}

function epochMsOf(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : undefined;
}

interface RolloutUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface RolloutRecord {
  requestId?: string;
  sessionId?: string;
  turnId?: string;
  /** ISO 时刻字符串（rollout 实测形态）。 */
  startedAt?: string;
  request?: {
    headers?: Record<string, string>;
    body?: unknown;
    /** 非 full-retention 模式也会保留的工具名清单。 */
    toolNames?: unknown[];
  };
  /** 记录自带的调用来源与模型身份（消歧键）。 */
  querySource?: string;
  model?: {modelId?: string; providerId?: string};
  response?: {
    finishReason?: string;
    reasoningText?: string;
    headers?: Record<string, string>;
    responseId?: string;
    text?: string;
    /** 实测结构 {id, name, input}；toolCallId/toolName 为防御性兼容。 */
    toolCalls?: Array<{id?: string; name?: string; toolCallId?: string; toolName?: string; input?: unknown}>;
    usage?: RolloutUsage;
  };
}

/**
 * 请求骨架摘要：只对 system + tools 取 sha256（消息历史不参与）。
 * 用于判断两条记录是否共享同一份系统提示/工具定义，供骨架缓存与借用判等。
 */
function promptHashOfBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (record.system === undefined && !Array.isArray(record.tools)) return undefined;
  try {
    return createHash("sha256")
      .update(JSON.stringify({system: record.system ?? null, tools: record.tools ?? null}))
      .digest("hex");
  } catch {
    return undefined;
  }
}

function toDetail(record: RolloutRecord): LocalExchangeDetail {
  const detail: LocalExchangeDetail = {};
  const body = record.request?.body;
  if (body !== undefined && body !== null) {
    try {
      detail.requestRawBody = typeof body === "string" ? body : JSON.stringify(body);
    } catch {
      /* 序列化失败视为无正文，走 missing 降级。 */
    }
  }
  if (record.request?.headers) detail.requestHeaders = record.request.headers;
  if (Array.isArray(record.request?.toolNames)) {
    detail.toolNames = record.request.toolNames
      .filter((name): name is string => typeof name === "string")
      .slice(0, 512);
  }
  const promptHash = promptHashOfBody(body);
  if (promptHash !== undefined) detail.promptHash = promptHash;
  if (record.response) {
    detail.response = {
      ...(record.response.finishReason !== undefined ? {finishReason: record.response.finishReason} : {}),
      ...(record.response.text !== undefined ? {text: record.response.text} : {}),
      // 推理链文本：历史上被丢弃，导致「思考过程」在 rollout 兜底路径下整体缺失。
      ...(typeof record.response.reasoningText === "string"
        ? {reasoningText: record.response.reasoningText}
        : {}),
      ...(Array.isArray(record.response.toolCalls) ? {
        toolCalls: record.response.toolCalls.map(call => ({
          id: call.id ?? call.toolCallId,
          name: call.name ?? call.toolName,
          ...(call.input !== undefined ? {input: call.input} : {}),
        })),
      } : {}),
      ...(record.response.usage !== undefined ? {usage: record.response.usage} : {}),
    };
    if (record.response.headers) detail.responseHeaders = record.response.headers;
    if (record.response.responseId) detail.responseId = record.response.responseId;
  }
  return detail;
}
