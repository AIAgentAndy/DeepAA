/**
 * Harness 证据层：Tier A 历史回填（2026-09-11 用户确认 D4，docs/Harness能力建设一期.md §4.5）。
 *
 * 只读 SQLite——`context_snapshots.summary_json` 中的工具名清单（normalizer 一期前就已在派生），
 * 绝不读 raw/blob，绝不触碰 usage_ledger / 价格表 / 聚合表。
 * 行为：分批（默认 500 step/事务）为 `harness_snapshot_hash IS NULL` 且存在 context snapshot 的
 * 存量 step 构建名称级快照并回填引用；rowid 游标持久化于 harness_backfill_state，
 * 幂等可中断重入，与 worker 正常写入并发安全（worker 写入的行带 hash，天然跳过）。
 * 效果边界（Tier A）：历史 step 获得 Tools/MCP 清单与 Invoked/Calls；
 * skills/rules/构成估算/项目目录为升级前不可得（UI 显示「升级前数据」）。
 */

import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { createHash } from "node:crypto";
import { classifyToolName } from "../harness/evidence";
import type { SnapshotRule, SnapshotSkill, SnapshotTool } from "./harness-snapshot-store";
import { HARNESS_SNAPSHOT_JSON_MAX_BYTES } from "./harness-snapshot-store";

export const HARNESS_BACKFILL_BATCH_SIZE = 500;

export interface HarnessBackfillResult {
  /** 本轮实际回填的 step 数。 */
  processedSteps: number;
  /** 本轮新建的快照行数。 */
  createdSnapshots: number;
  /** 本轮已完成的批次数。 */
  batches: number;
  /** 是否已无待回填数据（游标走完）。 */
  finished: boolean;
  lastStepRowid?: number;
}

interface BackfillState {
  id: number;
  last_step_rowid: number | null;
  finished_at: string | null;
}

interface BackfillStepRow {
  rowid: number;
  id: string;
  timestamp: string;
  agent_name: string | null;
  summary_json: string | null;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface StoredToolSchemaLike {
  name?: string;
  kind?: string;
  mcpServer?: string;
  providerType?: string;
  schemaChars?: number;
  schemaTokensEst?: number;
}

function toolsFromStoredSummary(summaryJson: string | null): { tools: SnapshotTool[]; found: boolean } {
  if (!summaryJson) return { tools: [], found: false };
  let tools: StoredToolSchemaLike[] | undefined;
  try {
    const parsed = JSON.parse(summaryJson) as {
      snapshot?: { harnessPayload?: { toolSchemas?: StoredToolSchemaLike[] } };
      harnessPayload?: { toolSchemas?: StoredToolSchemaLike[] };
    };
    tools = parsed.snapshot?.harnessPayload?.toolSchemas ?? parsed.harnessPayload?.toolSchemas;
  } catch {
    return { tools: [], found: false };
  }
  if (!Array.isArray(tools)) return { tools: [], found: true };
  const mapped: SnapshotTool[] = tools.map(schema => {
    const rawName = typeof schema.name === "string" ? schema.name : "";
    const name = rawName
      || (typeof schema.providerType === "string" && schema.providerType ? `@${schema.providerType}` : "@unnamed");
    const classification = classifyToolName(name);
    return {
      name,
      kind: schema.kind === "mcp" || classification.kind === "mcp" ? "mcp" : "tool",
      mcpServer: schema.mcpServer ?? classification.mcpServer,
      schemaChars: typeof schema.schemaChars === "number" ? schema.schemaChars : 0,
      schemaTokensEst: typeof schema.schemaTokensEst === "number" ? schema.schemaTokensEst : 0,
    };
  });
  return { tools: mapped, found: true };
}

function jsonBounded(items: unknown[]): { json: string; truncated: boolean } {
  let json = JSON.stringify(items);
  if (Buffer.byteLength(json) <= HARNESS_SNAPSHOT_JSON_MAX_BYTES) {
    return { json, truncated: false };
  }
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(items.slice(0, middle))) <= HARNESS_SNAPSHOT_JSON_MAX_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { json: JSON.stringify(items.slice(0, low)), truncated: true };
}

function identityHashFor(agentName: string, tools: SnapshotTool[]): string {
  return sha256Hex(JSON.stringify({
    agent: agentName,
    tools: tools.map(tool => [tool.name, tool.kind, tool.mcpServer ?? ""]).sort(),
    skills: [],
    rules: [],
  }));
}

function getState(db: DeepaaDatabase): BackfillState | undefined {
  return db.prepare(
    "SELECT id, last_step_rowid, finished_at FROM harness_backfill_state WHERE id = 1",
  ).get() as BackfillState | undefined;
}

export function readHarnessBackfillState(db: DeepaaDatabase): {
  lastStepRowid: number | null;
  finishedAt: string | null;
} {
  const state = getState(db);
  return { lastStepRowid: state?.last_step_rowid ?? null, finishedAt: state?.finished_at ?? null };
}

/**
 * 执行一批（或至多 maxBatches 批）回填。空库/无 schema 表时安全跳过。
 * finished=true 表示游标已走完；调用方（worker 启动路径）可循环调用直至完成。
 */
export function runHarnessSnapshotBackfill(
  db: DeepaaDatabase,
  options: { batchSize?: number; maxBatches?: number; now?: () => string } = {},
): HarnessBackfillResult {
  if (!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'harness_snapshots'",
  ).get()) {
    return { processedSteps: 0, createdSnapshots: 0, batches: 0, finished: true };
  }
  const batchSize = Math.max(1, options.batchSize ?? HARNESS_BACKFILL_BATCH_SIZE);
  const maxBatches = Math.max(1, options.maxBatches ?? Number.MAX_SAFE_INTEGER);
  const now = options.now ?? (() => new Date().toISOString());

  let processedSteps = 0;
  let createdSnapshots = 0;
  let batches = 0;
  let lastRowid: number | null = readHarnessBackfillState(db).lastStepRowid;

  const insertSnapshot = db.prepare(
    `INSERT INTO harness_snapshots(
      snapshot_hash, agent_name, tool_count, mcp_tool_count, mcp_server_count,
      skill_count, rule_count, tools_json, skills_json, rules_json,
      complete, first_seen_at, last_seen_at, step_ref_count
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', 1, ?, ?, 1)
    ON CONFLICT(snapshot_hash) DO UPDATE SET
      last_seen_at = MAX(harness_snapshots.last_seen_at, excluded.last_seen_at),
      step_ref_count = step_ref_count + 1`,
  );
  const linkStep = db.prepare(
    `UPDATE agent_steps SET harness_snapshot_hash = ? WHERE id = ?`,
  );
  const selectBatch = db.prepare(
    `SELECT s.rowid AS rowid, s.id AS id, s.timestamp AS timestamp,
            sess.agent_name AS agent_name, cs.summary_json AS summary_json
     FROM agent_steps s
     JOIN context_snapshots cs ON cs.agent_step_id = s.id
     LEFT JOIN agent_sessions sess ON sess.id = s.agent_session_id
     WHERE s.harness_snapshot_hash IS NULL
       AND s.rowid > ?
     ORDER BY s.rowid
     LIMIT ?`,
  );

  while (batches < maxBatches) {
    const rows = selectBatch.all(lastRowid ?? 0, batchSize) as BackfillStepRow[];
    if (rows.length === 0) {
      const applyFinished = db.transaction(() => {
        db.prepare(
          `INSERT INTO harness_backfill_state(id, last_step_rowid, finished_at, updated_at)
           VALUES(1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             last_step_rowid = excluded.last_step_rowid,
             finished_at = excluded.finished_at,
             updated_at = excluded.updated_at`,
        ).run(lastRowid, now(), now());
      });
      applyFinished();
      return {
        processedSteps,
        createdSnapshots,
        batches,
        finished: true,
        lastStepRowid: lastRowid ?? undefined,
      };
    }

    const applyBatch = db.transaction(() => {
      for (const row of rows) {
        const agentName = row.agent_name ?? "unknown";
        const { tools } = toolsFromStoredSummary(row.summary_json);
        const hash = identityHashFor(agentName, tools);
        const mcpTools = tools.filter(tool => tool.kind === "mcp");
        const bounded = jsonBounded(tools);
        const before = db.prepare(
          "SELECT 1 FROM harness_snapshots WHERE snapshot_hash = ?",
        ).get(hash);
        insertSnapshot.run(
          hash,
          agentName,
          tools.length,
          mcpTools.length,
          new Set(mcpTools.map(tool => tool.mcpServer).filter(Boolean)).size,
          0,
          0,
          bounded.json,
          row.timestamp,
          row.timestamp,
        );
        if (!before) createdSnapshots++;
        linkStep.run(hash, row.id);
        lastRowid = row.rowid;
        processedSteps++;
      }
      db.prepare(
        `INSERT INTO harness_backfill_state(id, last_step_rowid, finished_at, updated_at)
         VALUES(1, ?, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_step_rowid = excluded.last_step_rowid,
           finished_at = NULL,
           updated_at = excluded.updated_at`,
      ).run(lastRowid, now());
    });
    applyBatch();
    batches++;
  }

  return {
    processedSteps,
    createdSnapshots,
    batches,
    finished: false,
    lastStepRowid: lastRowid ?? undefined,
  };
}
