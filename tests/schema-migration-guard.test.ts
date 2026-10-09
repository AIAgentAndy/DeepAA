import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * 迁移红线守卫（docs/上线前架构升级改造.md §3 / 决策 D7）：
 * schema.ts 中不允许出现新的 DROP TABLE / DROP COLUMN——上线后任何「重建已填充表」
 * 都会触碰「账本一经写入不得重算」「已进 SQLite 的业务投影永不删除」红线。
 * 历史上项目未上线期间确有若干重建，作为文档化例外精确列出；新增例外必须先在此
 * 登记理由，视为一次显式评审动作。
 */

/** 文档化例外：表名 → 出现次数 + 理由（均为项目未上线期的可重算派生表重建）。 */
const DOCUMENTED_DROP_TABLE_EXCEPTIONS: Record<string, {count: number; reason: string}> = {
  "v10_target_auxiliary_exchanges": {
    count: 1,
    reason: "v9→v10 迁移内部临时表，同事务内自建自清",
  },
  "auxiliary_requests": {
    count: 1,
    reason: "v9→v10 目标级辅助请求表重建（项目未上线期）",
  },
  "usage_ledger": {
    count: 1,
    reason: "v9→v10 账本表重建（项目未上线期，历史唯一一次，上线后禁止再出现）",
  },
  "exchange_content_category_stats": {
    count: 1,
    reason: "v13 统一对话语义重建（可由 raw 重算的投影表）",
  },
  "exchange_request_fingerprints": {
    count: 2,
    reason: "v13 统一对话语义重建 + v29 hex→BLOB 瘦身重建（可由 raw 重算的投影表）",
  },
  "exchange_content_filter_status": {
    count: 1,
    reason: "v13 统一对话语义重建（可由 raw 重算的投影表）",
  },
  "relay_reconciliation_matches": {
    count: 1,
    reason: "v46 confidence CHECK 增加 weak 的整表重建：SQLite CHECK 不可 ALTER，先建新表全量复制再原子替换，匹配事实表非账本、行数与金额逐一保留",
  },
};

/** 守卫测试与 schema 版本联动声明：升版本时必须同步审视本文件例外清单。
 * v52：新增 plan_estimate_settlements（额度差分估算结算游标，只增表无重建）。 */
const DECLARED_SCHEMA_VERSION = 52;

describe("schema 迁移红线守卫", () => {
  const schemaPath = join(import.meta.dirname, "..", "src", "lib", "db", "schema.ts");
  const source = readFileSync(schemaPath, "utf8");

  test("SCHEMA_VERSION 与守卫声明一致", async () => {
    const schema = await import(join(import.meta.dirname, "..", "src", "lib", "db", "schema.ts"));
    expect(schema.SCHEMA_VERSION).toBe(DECLARED_SCHEMA_VERSION);
  });

  test("DROP TABLE 只允许命中文档化例外集合", () => {
    const dropped: string[] = [];
    const dropTablePattern = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z0-9_]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = dropTablePattern.exec(source)) !== null) {
      dropped.push(match[1]!.toLowerCase());
    }
    const actual = new Map<string, number>();
    for (const table of dropped) {
      actual.set(table, (actual.get(table) ?? 0) + 1);
    }
    const expected = new Map(
      Object.entries(DOCUMENTED_DROP_TABLE_EXCEPTIONS).map(([table, spec]) => [
        table,
        spec.count,
      ]),
    );
    const violations: string[] = [];
    for (const [table, count] of actual) {
      if (!expected.has(table)) {
        violations.push(`未登记的 DROP TABLE: ${table}（x${count}）`);
      } else if (expected.get(table) !== count) {
        violations.push(
          `DROP TABLE ${table} 出现 ${count} 次，例外清单声明 ${expected.get(table)} 次`,
        );
      }
    }
    for (const table of expected.keys()) {
      if (!actual.has(table)) {
        violations.push(`例外清单中的 ${table} 已不再出现，请从清单移除以保持精确`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("禁止 ALTER TABLE ... DROP COLUMN（受保护表的列只增不删）", () => {
    const dropColumnPattern = /ALTER\s+TABLE\s+[A-Za-z0-9_]+\s+DROP\s+COLUMN/i;
    expect(
      dropColumnPattern.test(source),
      "schema.ts 不允许出现 ALTER TABLE ... DROP COLUMN；列语义变更走 sidecar/JSON 扩展列",
    ).toBe(false);
  });
});
