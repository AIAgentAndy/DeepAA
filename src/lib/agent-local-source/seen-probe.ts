/**
 * seen 表反联公共探针（2026-10-10 C 修复抽取）。
 *
 * 从 zcode 适配器的分块反联路径抽取的公共能力：对候选 id 集合按
 * `agent_local_import_seen` 主键索引做 IN 批量探测（每候选两键：前缀键 + 裸 id
 * 防御键），返回已导入的候选 id 子集——取代调度器旧路径「整表加载 + JS Set 过滤」
 * 的 O(全量) 物化。zcode（分块备选路径）与 codex（readPendingBatch）共用。
 */
import {deepaaDatabasePath} from "../db/connection";
import {DeepaaDatabase} from "@/lib/db/sqlite-driver";

/** 打开 DeepAA 库的短命只读连接（探测专用；调用方负责 close）。 */
export function openSeenProbeDatabase(dataDir: string, busyTimeoutMs = 5_000): DeepaaDatabase {
  const db = new DeepaaDatabase(deepaaDatabasePath(dataDir), {readonly: true, fileMustExist: true});
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  return db;
}

/**
 * 探测候选 id 中已导入（seen）的子集。返回的 id 已按前缀剥离，可直接与候选 id
 * 比较。空集合直接返回空 Set（空 IN 列表非法）。
 */
export function probeSeenExchangeIds(
  db: DeepaaDatabase,
  prefix: string,
  ids: readonly string[],
): Set<string> {
  if (ids.length === 0) return new Set();
  const keys = ids.flatMap(id => [`${prefix}${id}`, id]);
  const rows = db.prepare(
    `SELECT exchange_id FROM agent_local_import_seen WHERE exchange_id IN (${keys.map(() => "?").join(", ")})`,
  ).all(...keys) as Array<{exchange_id: string}>;
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.exchange_id.startsWith(prefix)
      ? row.exchange_id.slice(prefix.length)
      : row.exchange_id);
  }
  return seen;
}
