#!/usr/bin/env node
/**
 * 一次性维护脚本：为历史 context_snapshots 补齐 failover 投影字段（2026-09-13）。
 *
 * 背景：failover 投影字段（routing.failover → context_snapshots.summary_json.$.failover）
 * 上线前已派生的记录不会自动重投影（去重保护）；本脚本直接从 v2 raw capture 提取
 * routing.failover，json_set 到对应 step 的快照摘要里。只补缺失字段，不重算任何
 * 派生数据、不触碰 usage_ledger 账本。
 *
 * 用法：
 *   node scripts/backfill-failover-projections.mjs [--data-dir <dir>]   # 干跑：只统计
 *   node scripts/backfill-failover-projections.mjs --confirm [--data-dir <dir>]  # 实际写入
 *
 * 默认数据目录与运行时一致（~/.deepaa，可用 DEEPAA_DATA_DIR 覆盖）。
 */

import {createReadStream} from "node:fs";
import {createInterface} from "node:readline";
import {join, resolve} from "node:path";
import {homedir} from "node:os";
import {copyFileSync, existsSync, readdirSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";

// better-sqlite3 → node:sqlite 最小兼容层（2026-10-08 切换）：仅覆盖本脚本用到的
// pragma / transaction / run().changes，语义同 src/lib/db/sqlite-driver.ts。
class CompatStatement {
  constructor(raw) { this.raw = raw; }
  get(...args) { const row = this.raw.get(...args); return row && typeof row === "object" ? {...row} : row; }
  run(...args) { return this.raw.run(...args); }
}
class CompatDatabase {
  constructor(path) { this.raw = new DatabaseSync(path); }
  pragma(source) {
    if (source.includes("=")) { this.raw.exec(`PRAGMA ${source}`); return undefined; }
    return this.raw.prepare(`PRAGMA ${source}`).all();
  }
  prepare(sql) { return new CompatStatement(this.raw.prepare(sql)); }
  transaction(fn) {
    return (...args) => {
      let topLevel = false;
      try { this.raw.exec("BEGIN"); topLevel = true; } catch { topLevel = false; }
      if (!topLevel) {
        const savepoint = `compat_sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.raw.exec(`SAVEPOINT ${savepoint}`);
        let nested;
        try { nested = fn(...args); } catch (error) {
          this.raw.exec(`ROLLBACK TO ${savepoint}`);
          this.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
          throw error;
        }
        this.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return nested;
      }
      let result;
      try { result = fn(...args); } catch (error) { this.raw.exec("ROLLBACK"); throw error; }
      this.raw.exec("COMMIT");
      return result;
    };
  }
  close() { this.raw.close(); }
}

const args = process.argv.slice(2);
const confirmed = args.includes("--confirm");
const dataDirIndex = args.indexOf("--data-dir");
const dataDirFlag = dataDirIndex >= 0 ? args[dataDirIndex + 1] : undefined;
const dataDir = resolve(dataDirFlag || process.env.DEEPAA_DATA_DIR || join(homedir(), ".deepaa"));

const dbPath = join(dataDir, "deepaa.sqlite");
const capturesDir = join(dataDir, "captures", "v2");

if (!existsSync(dbPath)) {
  console.error(`数据库不存在: ${dbPath}`);
  process.exit(1);
}
if (!existsSync(capturesDir)) {
  console.error(`capture 目录不存在: ${capturesDir}`);
  process.exit(1);
}

// 写模式先备份数据库（同目录带时间戳副本，防意外）。
if (confirmed) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(dataDir, `deepaa.sqlite.backup-${stamp}`);
  copyFileSync(dbPath, backupPath);
  console.log(`已备份数据库 → ${backupPath}`);
}

const db = new CompatDatabase(dbPath);
db.pragma("journal_mode = WAL");

const selectStep = db.prepare(
  `SELECT id FROM agent_steps WHERE exchange_id = ? LIMIT 1`,
);
const needsFill = db.prepare(
  `SELECT summary_json FROM context_snapshots WHERE agent_step_id = ? LIMIT 1`,
);
const updateSnapshot = db.prepare(
  `UPDATE context_snapshots
   SET summary_json = json_set(summary_json, '$.failover', json(?))
   WHERE agent_step_id = ?
     AND json_extract(summary_json, '$.failover') IS NULL`,
);

let scanned = 0;
let withFailover = 0;
let matched = 0;
let updated = 0;
const missingStep = [];

const updateMany = db.transaction(rows => {
  for (const row of rows) {
    updated += updateSnapshot.run(row.failoverJson, row.stepId).changes;
  }
});
let pending = [];

const files = readdirSync(capturesDir).filter(name => name.endsWith(".jsonl")).sort();
for (const file of files) {
  const filePath = join(capturesDir, file);
  const rl = createInterface({
    input: createReadStream(filePath, {encoding: "utf8"}),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.includes('"failover":{')) continue; // 廉价预筛：绝大多数行不含 failover
    scanned += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const failover = record?.routing?.failover;
    if (!failover || typeof record.exchangeId !== "string") continue;
    withFailover += 1;
    const step = selectStep.get(record.exchangeId);
    if (!step) {
      missingStep.push(record.exchangeId);
      continue;
    }
    const existing = needsFill.get(step.id);
    if (!existing) continue;
    if (JSON.parse(existing.summary_json).failover !== undefined) continue;
    matched += 1;
    pending.push({stepId: step.id, failoverJson: JSON.stringify(failover)});
    if (pending.length >= 500) {
      if (confirmed) updateMany(pending);
      pending = [];
    }
  }
}
if (pending.length > 0 && confirmed) updateMany(pending);

console.log(`扫描含 failover 的 raw 行: ${withFailover}`);
console.log(`找到对应 step 且快照缺字段: ${matched}`);
console.log(`未找到 step 的 exchange: ${missingStep.length}${missingStep.length ? `（示例: ${missingStep.slice(0, 3).join(", ")}）` : ""}`);
console.log(confirmed ? `已更新快照: ${updated}` : "干跑模式（--confirm 实际写入）");
db.close();
process.exit(0);
