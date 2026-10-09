import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, test } from "node:test";
import { join } from "node:path";
import type { ResolvedAgentPath } from "../src/lib/db/models.js";
import { selectExportExchangeRefs } from "../src/lib/db/export-queries.js";
import { resolveDerivedArtifactJson } from "../src/lib/ingestion/derived-artifact-store.js";
import { normalizeExchange } from "../src/lib/harness/normalizer.js";
import { createParamsFingerprint } from "../src/lib/harness/params-fingerprint.js";
import { hydrateRawCapturedExchange } from "../src/lib/harness/raw-capture.js";
import { normalizeStoredContextSnapshot } from "../src/lib/ingestion/harness-payload-compact.js";
import type { RawCapturedExchangeV2 } from "../src/lib/harness/types.js";
import type { PricingConfigV2 } from "../src/lib/pricing.js";
import { createExchangeProcessor } from "../src/lib/ingestion/exchange-processor.js";
import { ensurePricingConfigRevision } from "../src/lib/ingestion/pricing-revisions.js";
import { upsertAgentPath } from "../src/lib/ingestion/hierarchy-repository.js";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture.js";

const BASE_TIME = "2026-07-17T08:00:00.000Z";

interface ArtifactCompletenessView {
  complete: boolean;
  originalEstimatedBytes: number;
  candidateItemCount: number;
  processedItemCount: number;
  candidateTextBytes: number;
  processedTextBytes: number;
}

interface StoredArtifactEnvelope {
  truncated?: boolean;
  completeness?: ArtifactCompletenessView;
  sourceCompleteness?: {
    previous?: ArtifactCompletenessView;
    current?: ArtifactCompletenessView;
  };
}

describe("SQLite Session/Thread 层级仓储", () => {
  const fixtures: SqliteFixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  });

  test("child 先到时立即建立唯一真根且不会把 child 标为根", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const child = agentPath({
      threadId: "thread-child",
      parentThreadId: "thread-root",
    });

    upsertAgentPath(fixture.db, child, BASE_TIME);

    const threads = fixture.db.prepare(
      `SELECT id, parent_agent_thread_id, is_root, is_placeholder
       FROM agent_threads ORDER BY id`,
    ).all() as Array<{
      id: string;
      parent_agent_thread_id: string | null;
      is_root: number;
      is_placeholder: number;
    }>;
    assert.deepEqual(threads, [
      {
        id: "thread-child",
        parent_agent_thread_id: "thread-root",
        is_root: 0,
        is_placeholder: 0,
      },
      {
        id: "thread-root",
        parent_agent_thread_id: null,
        is_root: 1,
        is_placeholder: 1,
      },
    ]);
    assert.equal(threads.filter(thread => thread.is_root === 1).length, 1);
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM thread_closure").pluck().get(),
      3,
    );
  });

  test("upsert 返回 canonical Session/Thread 身份且不改变既有写入语义", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const path = agentPath({
      rootThreadId: "thread-root-returned",
      threadId: "thread-child-returned",
      parentThreadId: "thread-root-returned",
    });

    const written = upsertAgentPath(fixture.db, path, BASE_TIME);

    assert.deepEqual(written, {
      sessionId: "session-1",
      threadId: "thread-child-returned",
      rootThreadId: "thread-root-returned",
    });
    assert.equal(parentOf(fixture, "thread-child-returned"), "thread-root-returned");
  });

  test("Task 4 path diagnostics 以稳定层级上下文持久化", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      threadId: "thread-diagnostic-child",
      parentThreadId: "thread-root",
      diagnostics: [{
        code: "task4-probe",
        message: "Task 4 身份诊断",
      }],
    }), BASE_TIME);

    assert.deepEqual(diagnosticByCode(fixture, "task4-probe"), {
      code: "task4-probe",
      severity: "warning",
      details_json: JSON.stringify({
        origin: "thread-identity",
        session: "session-1",
        current: "thread-diagnostic-child",
        parent: "thread-root",
        root: "thread-root",
      }),
      created_at: BASE_TIME,
    });
  });

  test("同一 Session 后到的不同根降级为 canonical root 的普通子 Thread", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const canonicalRoot = agentPath({
      rootThreadId: "thread-root-first",
      threadId: "thread-root-first",
      displayName: "首个 canonical root",
    });
    const conflictingRoot = agentPath({
      rootThreadId: "thread-root-second",
      threadId: "thread-root-second",
      displayName: "冲突 root metadata",
    });

    upsertAgentPath(fixture.db, canonicalRoot, BASE_TIME);
    upsertAgentPath(fixture.db, conflictingRoot, BASE_TIME);
    upsertAgentPath(fixture.db, conflictingRoot, BASE_TIME);

    assert.deepEqual(
      fixture.db.prepare(
        `SELECT id, parent_agent_thread_id, display_name, is_root
         FROM agent_threads ORDER BY id`,
      ).all(),
      [
        {
          id: "thread-root-first",
          parent_agent_thread_id: null,
          display_name: "首个 canonical root",
          is_root: 1,
        },
        {
          id: "thread-root-second",
          parent_agent_thread_id: "thread-root-first",
          display_name: "冲突 root metadata",
          is_root: 0,
        },
      ],
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT depth FROM thread_closure
         WHERE ancestor_thread_id = 'thread-root-first'
           AND descendant_thread_id = 'thread-root-second'`,
      ).pluck().get(),
      1,
    );
    assert.deepEqual(diagnosticByCode(fixture, "thread-root-conflict"), {
      code: "thread-root-conflict",
      severity: "warning",
      details_json: JSON.stringify({
        origin: "hierarchy-repository",
        session: "session-1",
        current: "thread-root-second",
        parent: "thread-root-first",
        root: "thread-root-first",
        requested: "thread-root-second",
        existing: "thread-root-first",
      }),
      created_at: BASE_TIME,
    });
    assert.equal(diagnosticCount(fixture), 1);

    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "thread-root-second",
      threadId: "thread-conflicting-child",
    }), BASE_TIME);

    assert.equal(
      parentOf(fixture, "thread-conflicting-child"),
      "thread-root-first",
    );
    assert.equal(
      fixture.db.prepare(
        "SELECT COUNT(*) FROM agent_threads WHERE is_root = 1",
      ).pluck().get(),
      1,
    );
  });

  test("根冲突 path 不得覆盖既有 canonical root metadata", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "thread-root-canonical",
      threadId: "thread-root-canonical",
      displayName: "canonical metadata",
    }), BASE_TIME, { model: "model-canonical" });

    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "thread-root-conflicting",
      threadId: "thread-root-canonical",
      displayName: "不得覆盖的冲突 metadata",
    }), BASE_TIME, { model: "model-conflicting" });

    assert.deepEqual(
      fixture.db.prepare(
        `SELECT display_name, model_set_json, is_root
         FROM agent_threads WHERE id = 'thread-root-canonical'`,
      ).get(),
      {
        display_name: "canonical metadata",
        model_set_json: '["model-canonical"]',
        is_root: 1,
      },
    );
    assert.deepEqual(
      JSON.parse(
        diagnosticByCode(fixture, "thread-root-conflict")
          ?.details_json ?? "{}",
      ),
      {
        origin: "hierarchy-repository",
        session: "session-1",
        current: "thread-root-canonical",
        parent: "thread-root-canonical",
        root: "thread-root-canonical",
        requested: "thread-root-conflicting",
        existing: "thread-root-canonical",
      },
    );
  });

  test("无关联脏双根收敛到稳定 canonical 并补齐 extra 子树 closure", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-a",
      threadId: "root-a",
      displayName: "canonical metadata",
    }), BASE_TIME);
    insertDirtyThread(fixture, {
      id: "root-z",
      isRoot: true,
      displayName: "extra root metadata",
      modelSetJson: '["extra-model"]',
    });
    insertDirtyThread(fixture, {
      id: "extra-descendant",
      parentId: "root-z",
      displayName: "extra descendant metadata",
    });

    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-a",
      threadId: "new-child",
    }), BASE_TIME);

    assert.equal(
      fixture.db.prepare(
        "SELECT COUNT(*) FROM agent_threads WHERE is_root = 1",
      ).pluck().get(),
      1,
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT parent_agent_thread_id, display_name, model_set_json, is_root
         FROM agent_threads WHERE id = 'root-z'`,
      ).get(),
      {
        parent_agent_thread_id: "root-a",
        display_name: "extra root metadata",
        model_set_json: '["extra-model"]',
        is_root: 0,
      },
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT depth FROM thread_closure
         WHERE ancestor_thread_id = 'root-a'
           AND descendant_thread_id = 'root-z'`,
      ).pluck().get(),
      1,
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT depth FROM thread_closure
         WHERE ancestor_thread_id = 'root-a'
           AND descendant_thread_id = 'extra-descendant'`,
      ).pluck().get(),
      2,
    );
    assert.equal(
      diagnosticByCode(fixture, "thread-root-reconciled")?.severity,
      "warning",
    );
  });

  test("脏双根优先选择真实 parent 链中位于其他根祖先的 top root", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-a",
      threadId: "root-a",
    }), BASE_TIME);
    insertDirtyThread(fixture, {
      id: "root-z-top",
      isRoot: true,
      displayName: "top root metadata",
    });
    fixture.db.prepare(
      `UPDATE agent_threads SET parent_agent_thread_id = 'root-z-top'
       WHERE id = 'root-a'`,
    ).run();
    fixture.db.prepare(
      `INSERT INTO thread_closure(
        ancestor_thread_id, descendant_thread_id, depth
      ) VALUES('root-z-top', 'root-a', 1)`,
    ).run();

    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-z-top",
      threadId: "top-root-child",
    }), BASE_TIME);

    assert.deepEqual(
      fixture.db.prepare(
        `SELECT id FROM agent_threads WHERE is_root = 1 ORDER BY id`,
      ).pluck().all(),
      ["root-z-top"],
    );
    assert.equal(parentOf(fixture, "root-a"), "root-z-top");
    assert.equal(parentOf(fixture, "top-root-child"), "root-z-top");
  });

  test("canonical root 候选查询使用根索引且不创建临时排序", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);

    const plan = queryPlanDetails(
      fixture,
      `SELECT id FROM agent_threads
       WHERE agent_session_id = ? AND is_root = 1
       ORDER BY id ASC`,
      "session-1",
    );

    assert.ok(
      plan.some((detail) =>
        /SEARCH agent_threads USING (?:COVERING )?INDEX idx_threads_root/.test(
          detail,
        )
      ),
      plan.join("\n"),
    );
    assert.equal(plan.some((detail) => detail.includes("USE TEMP B-TREE")), false);
  });

  test("canonical fallback 查询使用根索引且不创建临时排序", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);

    const plan = queryPlanDetails(
      fixture,
      `SELECT id FROM agent_threads
       WHERE agent_session_id = ? AND is_root = 1
       ORDER BY id ASC
       LIMIT 1`,
      "session-1",
    );

    assert.ok(
      plan.some((detail) =>
        /SEARCH agent_threads USING (?:COVERING )?INDEX idx_threads_root/.test(
          detail,
        )
      ),
      plan.join("\n"),
    );
    assert.equal(plan.some((detail) => detail.includes("USE TEMP B-TREE")), false);
  });

  test("诊断去重查询使用复合索引且不全表扫描", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);

    const plan = queryPlanDetails(
      fixture,
      `SELECT 1 FROM derivation_diagnostics
       WHERE exchange_id IS ? AND source_id IS ?
         AND code = ? AND details_json = ?`,
      null,
      null,
      "thread-root-conflict",
      "{}",
    );

    assert.ok(
      plan.some((detail) =>
        /SEARCH derivation_diagnostics USING (?:COVERING )?INDEX idx_diagnostics_dedupe/.test(
          detail,
        )
      ),
      plan.join("\n"),
    );
    assert.equal(
      plan.some((detail) => detail === "SCAN derivation_diagnostics"),
      false,
    );
  });

  test("extra root 子树挂载后超过 32 层时 demote 并隔离", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-a",
      threadId: "root-a",
    }), BASE_TIME);
    insertDirtyThread(fixture, {
      id: "root-z-deep",
      isRoot: true,
      displayName: "deep extra root",
    });
    let parentId = "root-z-deep";
    for (let depth = 1; depth <= 32; depth += 1) {
      const id = `dirty-depth-${depth}`;
      insertDirtyThread(fixture, {
        id,
        parentId,
        displayName: `dirty depth ${depth}`,
      });
      fixture.db.prepare(
        `INSERT OR REPLACE INTO thread_closure(
          ancestor_thread_id, descendant_thread_id, depth
        ) VALUES('root-z-deep', ?, ?)`,
      ).run(id, depth);
      parentId = id;
    }

    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-a",
      threadId: "deep-check-child",
    }), BASE_TIME);

    assert.equal(
      fixture.db.prepare(
        "SELECT COUNT(*) FROM agent_threads WHERE is_root = 1",
      ).pluck().get(),
      1,
    );
    assert.equal(parentOf(fixture, "root-z-deep"), null);
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) FROM thread_closure
         WHERE ancestor_thread_id = 'root-a'
           AND descendant_thread_id = 'root-z-deep'`,
      ).pluck().get(),
      0,
    );
    assert.equal(
      fixture.db.prepare("SELECT MAX(depth) FROM thread_closure").pluck().get(),
      32,
    );
    assert.equal(
      diagnosticByCode(fixture, "thread-root-reconcile-failed")?.severity,
      "warning",
    );
  });

  test("extra root 已是 canonical 祖先且 closure 成环时只 demote 隔离", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-a-cycle",
      threadId: "root-a-cycle",
    }), BASE_TIME);
    insertDirtyThread(fixture, {
      id: "root-z-cycle",
      isRoot: true,
      displayName: "cycle extra root",
    });
    fixture.db.prepare(
      `UPDATE agent_threads
       SET parent_agent_thread_id = CASE id
         WHEN 'root-a-cycle' THEN 'root-z-cycle'
         WHEN 'root-z-cycle' THEN 'root-a-cycle'
       END
       WHERE id IN ('root-a-cycle', 'root-z-cycle')`,
    ).run();
    fixture.db.prepare(
      `INSERT INTO thread_closure(
        ancestor_thread_id, descendant_thread_id, depth
      ) VALUES
        ('root-a-cycle', 'root-z-cycle', 1),
        ('root-z-cycle', 'root-a-cycle', 1)`,
    ).run();
    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-a-cycle",
      threadId: "cycle-check-child",
    }), BASE_TIME);

    assert.equal(
      fixture.db.prepare(
        "SELECT COUNT(*) FROM agent_threads WHERE is_root = 1",
      ).pluck().get(),
      1,
    );
    assert.equal(parentOf(fixture, "root-z-cycle"), null);
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) FROM thread_closure
         WHERE (ancestor_thread_id = 'root-a-cycle'
                AND descendant_thread_id = 'root-z-cycle')
            OR (ancestor_thread_id = 'root-z-cycle'
                AND descendant_thread_id = 'root-a-cycle')`,
      ).pluck().get(),
      0,
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT depth FROM thread_closure
         WHERE ancestor_thread_id = 'root-a-cycle'
           AND descendant_thread_id = 'cycle-check-child'`,
      ).pluck().get(),
      1,
    );
    const diagnostic = diagnosticByCode(
      fixture,
      "thread-root-reconcile-failed",
    );
    assert.equal(diagnostic?.severity, "warning");
    assert.equal(JSON.parse(diagnostic?.details_json ?? "{}").result, "cycle");
  });

  test("隔离的深层 extra 作为 current 重放时保持无父且不追加冲突诊断", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-a-replay",
      threadId: "root-a-replay",
    }), BASE_TIME);
    insertDirtyThread(fixture, {
      id: "root-z-replay",
      isRoot: true,
      displayName: "replayed deep extra",
    });
    let parentId = "root-z-replay";
    for (let depth = 1; depth <= 32; depth += 1) {
      const id = `replay-depth-${depth}`;
      insertDirtyThread(fixture, {
        id,
        parentId,
        displayName: `replay depth ${depth}`,
      });
      fixture.db.prepare(
        `INSERT OR REPLACE INTO thread_closure(
          ancestor_thread_id, descendant_thread_id, depth
        ) VALUES('root-z-replay', ?, ?)`,
      ).run(id, depth);
      parentId = id;
    }

    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-z-replay",
      threadId: "root-z-replay",
      displayName: "updated isolated metadata",
    }), BASE_TIME);

    assert.deepEqual(
      fixture.db.prepare(
        `SELECT parent_agent_thread_id, is_root, display_name
         FROM agent_threads WHERE id = 'root-z-replay'`,
      ).get(),
      {
        parent_agent_thread_id: null,
        is_root: 0,
        display_name: "updated isolated metadata",
      },
    );
    assert.equal(
      fixture.db.prepare("SELECT MAX(depth) FROM thread_closure").pluck().get(),
      32,
    );
    assert.deepEqual(
      fixture.db.prepare(
        "SELECT code FROM derivation_diagnostics ORDER BY id",
      ).pluck().all(),
      ["thread-root-reconcile-failed"],
    );
  });

  test("path 已指向 canonical 时仍保留本轮 isolated current 状态", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-a-isolated-state",
      threadId: "root-a-isolated-state",
    }), BASE_TIME);
    insertDirtyThread(fixture, {
      id: "isolated-conflicting-parent",
      displayName: "conflicting parent",
    });
    insertDirtyThread(fixture, {
      id: "root-z-isolated-state",
      parentId: "isolated-conflicting-parent",
      isRoot: true,
      displayName: "isolated current",
    });

    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-a-isolated-state",
      threadId: "root-z-isolated-state",
      displayName: "updated isolated current",
    }), BASE_TIME);

    assert.deepEqual(
      fixture.db.prepare(
        `SELECT parent_agent_thread_id, is_root, display_name
         FROM agent_threads WHERE id = 'root-z-isolated-state'`,
      ).get(),
      {
        parent_agent_thread_id: null,
        is_root: 0,
        display_name: "updated isolated current",
      },
    );
  });

  test("预置 depth 33 的 canonical 到 extra closure 按真实 parent 修复", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-a-depth-repair",
      threadId: "root-a-depth-repair",
    }), BASE_TIME);
    insertDirtyThread(fixture, {
      id: "root-z-depth-repair",
      isRoot: true,
      displayName: "depth repair extra",
    });
    fixture.db.prepare(
      `INSERT INTO thread_closure(
        ancestor_thread_id, descendant_thread_id, depth
      ) VALUES('root-a-depth-repair', 'root-z-depth-repair', 33)`,
    ).run();

    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-a-depth-repair",
      threadId: "depth-repair-child",
    }), BASE_TIME);

    assert.equal(parentOf(fixture, "root-z-depth-repair"), "root-a-depth-repair");
    assert.equal(
      fixture.db.prepare(
        `SELECT depth FROM thread_closure
         WHERE ancestor_thread_id = 'root-a-depth-repair'
           AND descendant_thread_id = 'root-z-depth-repair'`,
      ).pluck().get(),
      1,
    );
    const maxDepth = fixture.db.prepare(
      "SELECT MAX(depth) FROM thread_closure",
    ).pluck().get() as number;
    assert.ok(maxDepth <= 32);
  });

  test("隔离脏 root cycle 后 stale ancestor 不再传播到 canonical 新 child", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-a-stale",
      threadId: "root-a-stale",
    }), BASE_TIME);
    insertDirtyThread(fixture, {
      id: "root-z-stale",
      isRoot: true,
      displayName: "stale cycle extra",
    });
    insertDirtyThread(fixture, {
      id: "stale-d",
      displayName: "stale parent d",
    });
    insertDirtyThread(fixture, {
      id: "stale-c",
      parentId: "stale-d",
      displayName: "stale ancestor c",
    });
    fixture.db.prepare(
      `UPDATE agent_threads
       SET parent_agent_thread_id = CASE id
         WHEN 'root-a-stale' THEN 'root-z-stale'
         WHEN 'root-z-stale' THEN 'root-a-stale'
       END
       WHERE id IN ('root-a-stale', 'root-z-stale')`,
    ).run();
    fixture.db.prepare(
      `INSERT INTO thread_closure(
        ancestor_thread_id, descendant_thread_id, depth
      ) VALUES
        ('root-a-stale', 'root-z-stale', 1),
        ('root-z-stale', 'root-a-stale', 1),
        ('stale-c', 'root-z-stale', 1),
        ('stale-c', 'root-a-stale', 2)`,
    ).run();

    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-a-stale",
      threadId: "stale-check-child",
    }), BASE_TIME);

    assert.equal(parentOf(fixture, "root-z-stale"), null);
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) FROM thread_closure
         WHERE ancestor_thread_id = 'stale-c'
           AND descendant_thread_id = 'stale-check-child'`,
      ).pluck().get(),
      0,
    );
  });

  test("固定种子脏树收敛后 closure 与真实 parent 链逐行一致", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-random-canonical",
      threadId: "root-random-canonical",
    }), BASE_TIME);
    insertDirtyThread(fixture, {
      id: "root-random-extra",
      isRoot: true,
      displayName: "random extra root",
    });
    const knownIds = ["root-random-canonical", "root-random-extra"];
    let seed = 0x5eed1234;
    for (let index = 0; index < 24; index += 1) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      const parentId = knownIds[seed % knownIds.length];
      const id = `random-thread-${index}`;
      insertDirtyThread(fixture, {
        id,
        parentId,
        displayName: `random thread ${index}`,
      });
      knownIds.push(id);
    }
    fixture.db.prepare(
      `INSERT INTO thread_closure(
        ancestor_thread_id, descendant_thread_id, depth
      ) VALUES('random-thread-23', 'root-random-canonical', 31)`,
    ).run();

    upsertAgentPath(fixture.db, agentPath({
      rootThreadId: "root-random-canonical",
      threadId: "random-check-child",
    }), BASE_TIME);

    const threads = fixture.db.prepare(
      `SELECT id, parent_agent_thread_id
       FROM agent_threads WHERE agent_session_id = 'session-1'`,
    ).all() as Array<{ id: string; parent_agent_thread_id: string | null }>;
    const parentById = new Map(
      threads.map((thread) => [thread.id, thread.parent_agent_thread_id]),
    );
    const expected: Array<{
      ancestor_thread_id: string;
      descendant_thread_id: string;
      depth: number;
    }> = [];
    for (const thread of threads) {
      expected.push({
        ancestor_thread_id: thread.id,
        descendant_thread_id: thread.id,
        depth: 0,
      });
      const visited = new Set([thread.id]);
      let ancestorId = thread.parent_agent_thread_id;
      let depth = 1;
      while (ancestorId && depth <= 32 && !visited.has(ancestorId)) {
        expected.push({
          ancestor_thread_id: ancestorId,
          descendant_thread_id: thread.id,
          depth,
        });
        visited.add(ancestorId);
        ancestorId = parentById.get(ancestorId) ?? null;
        depth += 1;
      }
    }
    expected.sort(compareClosureRows);
    const actual = fixture.db.prepare(
      `SELECT ancestor_thread_id, descendant_thread_id, depth
       FROM thread_closure ORDER BY ancestor_thread_id, descendant_thread_id`,
    ).all();

    assert.deepEqual(actual, expected);
  });

  test("grandchild 先到且父 metadata 晚到时补齐传递 closure 并清除占位", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const grandchild = agentPath({
      threadId: "thread-grandchild",
      parentThreadId: "thread-child",
      displayName: "孙 Thread",
    });
    const child = agentPath({
      threadId: "thread-child",
      parentThreadId: "thread-root",
      displayName: "子 Thread",
    });
    const root = agentPath({
      threadId: "thread-root",
      displayName: "真实根 Thread",
    });

    upsertAgentPath(fixture.db, grandchild, "2026-07-17T08:02:00.000Z");
    upsertAgentPath(fixture.db, child, "2026-07-17T08:01:00.000Z");
    upsertAgentPath(fixture.db, root, "2026-07-17T08:00:00.000Z");

    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM agent_sessions").pluck().get(),
      1,
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT id, parent_agent_thread_id, display_name, is_placeholder,
                start_time, end_time
         FROM agent_threads ORDER BY id`,
      ).all(),
      [
        {
          id: "thread-child",
          parent_agent_thread_id: "thread-root",
          display_name: "子 Thread",
          is_placeholder: 0,
          start_time: "2026-07-17T08:01:00.000Z",
          end_time: "2026-07-17T08:02:00.000Z",
        },
        {
          id: "thread-grandchild",
          parent_agent_thread_id: "thread-child",
          display_name: "孙 Thread",
          is_placeholder: 0,
          start_time: "2026-07-17T08:02:00.000Z",
          end_time: "2026-07-17T08:02:00.000Z",
        },
        {
          id: "thread-root",
          parent_agent_thread_id: null,
          display_name: "真实根 Thread",
          is_placeholder: 0,
          start_time: "2026-07-17T08:00:00.000Z",
          end_time: "2026-07-17T08:02:00.000Z",
        },
      ],
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT depth FROM thread_closure
         WHERE ancestor_thread_id = 'thread-root'
           AND descendant_thread_id = 'thread-grandchild'`,
      ).pluck().get(),
      2,
    );
    assert.equal(
      fixture.db.prepare("SELECT MAX(depth) FROM thread_closure").pluck().get(),
      2,
    );
  });

  test("同一路径重放只扩展时间边界且不更新 Task 6 计数", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const child = agentPath({
      threadId: "thread-child",
      parentThreadId: "thread-root",
    });

    upsertAgentPath(fixture.db, child, BASE_TIME);
    upsertAgentPath(fixture.db, child, "2026-07-17T07:00:00.000Z");
    upsertAgentPath(fixture.db, child, "2026-07-17T09:00:00.000Z");

    assert.deepEqual(
      fixture.db.prepare(
        `SELECT start_time, end_time, model_set_json, request_count,
                thread_count
         FROM agent_sessions`,
      ).get(),
      {
        start_time: "2026-07-17T07:00:00.000Z",
        end_time: "2026-07-17T09:00:00.000Z",
        model_set_json: "[]",
        request_count: 0,
        thread_count: 0,
      },
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT start_time, end_time, model_set_json, request_count,
                turn_count
         FROM agent_threads WHERE id = 'thread-child'`,
      ).get(),
      {
        start_time: "2026-07-17T07:00:00.000Z",
        end_time: "2026-07-17T09:00:00.000Z",
        model_set_json: "[]",
        request_count: 0,
        turn_count: 0,
      },
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT start_time, end_time, model_set_json, request_count,
                turn_count
         FROM agent_threads WHERE id = 'thread-root'`,
      ).get(),
      {
        start_time: "2026-07-17T07:00:00.000Z",
        end_time: "2026-07-17T09:00:00.000Z",
        model_set_json: "[]",
        request_count: 0,
        turn_count: 0,
      },
    );
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM agent_threads").pluck().get(),
      2,
    );
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM thread_closure").pluck().get(),
      3,
    );
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM derivation_diagnostics").pluck().get(),
      0,
    );
  });

  test("父身份自引用时降级到真根并幂等写入 self diagnostic", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const child = agentPath({
      threadId: "thread-self",
      parentThreadId: "thread-self",
    });

    upsertAgentPath(fixture.db, child, BASE_TIME);
    upsertAgentPath(fixture.db, child, BASE_TIME);

    assert.equal(parentOf(fixture, "thread-self"), "thread-root");
    assert.deepEqual(diagnosticByCode(fixture, "thread-hierarchy-self"), {
      code: "thread-hierarchy-self",
      severity: "warning",
      details_json: JSON.stringify({
        origin: "hierarchy-repository",
        session: "session-1",
        current: "thread-self",
        parent: "thread-self",
        root: "thread-root",
        fallbackOutcome: "attached-root",
      }),
      created_at: BASE_TIME,
    });
    assert.deepEqual(
      diagnosticMessageAndDetails(fixture, "thread-hierarchy-self"),
      {
        message: "父 Thread 与当前 Thread 相同。已挂到当前 Session 真根。",
        details_json: JSON.stringify({
          origin: "hierarchy-repository",
          session: "session-1",
          current: "thread-self",
          parent: "thread-self",
          root: "thread-root",
          fallbackOutcome: "attached-root",
        }),
      },
    );
    assert.equal(diagnosticCount(fixture), 1);
  });

  test("关系异常按 Exchange 区分且同一 Exchange 重放去重", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const selfPath = agentPath({
      threadId: "thread-event-self",
      parentThreadId: "thread-event-self",
    });

    upsertAgentPath(fixture.db, selfPath, BASE_TIME, { exchangeId: "ex-1" });
    upsertAgentPath(fixture.db, selfPath, BASE_TIME, { exchangeId: "ex-1" });
    upsertAgentPath(fixture.db, selfPath, BASE_TIME, { exchangeId: "ex-2" });

    const detailsJson = JSON.stringify({
      origin: "hierarchy-repository",
      session: "session-1",
      current: "thread-event-self",
      parent: "thread-event-self",
      root: "thread-root",
      fallbackOutcome: "attached-root",
    });
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT exchange_id, source_id, details_json
         FROM derivation_diagnostics
         WHERE code = 'thread-hierarchy-self'
         ORDER BY exchange_id`,
      ).all(),
      [
        { exchange_id: "ex-1", source_id: null, details_json: detailsJson },
        { exchange_id: "ex-2", source_id: null, details_json: detailsJson },
      ],
    );
  });

  test("self fallback 有既有父时记录 kept-existing-parent outcome", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      threadId: "fallback-stable-parent",
      parentThreadId: "thread-root",
    }), BASE_TIME);
    upsertAgentPath(fixture.db, agentPath({
      threadId: "fallback-stable-current",
      parentThreadId: "fallback-stable-parent",
    }), BASE_TIME);

    upsertAgentPath(fixture.db, agentPath({
      threadId: "fallback-stable-current",
      parentThreadId: "fallback-stable-current",
    }), BASE_TIME);

    assert.equal(
      parentOf(fixture, "fallback-stable-current"),
      "fallback-stable-parent",
    );
    assert.deepEqual(
      diagnosticMessageAndDetails(fixture, "thread-hierarchy-self"),
      {
        message: "父 Thread 与当前 Thread 相同。已保留既有稳定父关系。",
        details_json: JSON.stringify({
          origin: "hierarchy-repository",
          session: "session-1",
          current: "fallback-stable-current",
          parent: "fallback-stable-current",
          root: "thread-root",
          fallbackOutcome: "kept-existing-parent",
        }),
      },
    );
  });

  test("max-depth fallback 无安全根时保持隔离并记录 isolated outcome", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      threadId: "thread-root",
    }), BASE_TIME);
    insertDirtyThread(fixture, {
      id: "fallback-deep-current",
      displayName: "fallback deep current",
    });
    insertDirtyThread(fixture, {
      id: "fallback-deep-parent",
      parentId: "thread-root",
      displayName: "fallback deep parent",
    });
    let parentId = "fallback-deep-current";
    for (let depth = 1; depth <= 32; depth += 1) {
      const id = `fallback-depth-${depth}`;
      insertDirtyThread(fixture, {
        id,
        parentId,
        displayName: `fallback depth ${depth}`,
      });
      fixture.db.prepare(
        `INSERT OR REPLACE INTO thread_closure(
          ancestor_thread_id, descendant_thread_id, depth
        ) VALUES('fallback-deep-current', ?, ?)`,
      ).run(id, depth);
      parentId = id;
    }

    upsertAgentPath(fixture.db, agentPath({
      threadId: "fallback-deep-current",
      parentThreadId: "fallback-deep-parent",
    }), BASE_TIME);

    assert.equal(parentOf(fixture, "fallback-deep-current"), null);
    assert.equal(
      fixture.db.prepare("SELECT MAX(depth) FROM thread_closure").pluck().get(),
      32,
    );
    assert.deepEqual(
      diagnosticMessageAndDetails(fixture, "thread-hierarchy-max-depth"),
      {
        message: "父关系超过最大层级 32。无安全 fallback，已保持隔离。",
        details_json: JSON.stringify({
          origin: "hierarchy-repository",
          session: "session-1",
          current: "fallback-deep-current",
          parent: "fallback-deep-parent",
          root: "thread-root",
          fallbackOutcome: "isolated",
        }),
      },
    );
  });

  test("self fallback 会成真实循环时保持隔离并记录 isolated outcome", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      threadId: "thread-root",
    }), BASE_TIME);
    insertDirtyThread(fixture, {
      id: "fallback-cycle-current",
      displayName: "fallback cycle current",
    });
    fixture.db.prepare(
      `UPDATE agent_threads SET parent_agent_thread_id = 'fallback-cycle-current'
       WHERE id = 'thread-root'`,
    ).run();

    upsertAgentPath(fixture.db, agentPath({
      threadId: "fallback-cycle-current",
      parentThreadId: "fallback-cycle-current",
    }), BASE_TIME);

    assert.equal(parentOf(fixture, "fallback-cycle-current"), null);
    assert.deepEqual(
      diagnosticMessageAndDetails(fixture, "thread-hierarchy-self"),
      {
        message: "父 Thread 与当前 Thread 相同。无安全 fallback，已保持隔离。",
        details_json: JSON.stringify({
          origin: "hierarchy-repository",
          session: "session-1",
          current: "fallback-cycle-current",
          parent: "fallback-cycle-current",
          root: "thread-root",
          fallbackOutcome: "isolated",
        }),
      },
    );
  });

  test("真根自引用时保持 parent NULL 并写入 self diagnostic", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      threadId: "thread-root",
      parentThreadId: "thread-root",
    }), BASE_TIME);

    assert.equal(parentOf(fixture, "thread-root"), null);
    assert.equal(
      diagnosticByCode(fixture, "thread-hierarchy-self")?.severity,
      "warning",
    );
    assert.equal(diagnosticCount(fixture), 1);
  });

  test("父 Thread 属于其他 Session 时降级到当前 Session 真根", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      sessionId: "session-foreign",
      rootThreadId: "thread-foreign",
      threadId: "thread-foreign",
    }), BASE_TIME);
    const localChild = agentPath({
      sessionId: "session-local",
      rootThreadId: "thread-local-root",
      threadId: "thread-local-child",
      parentThreadId: "thread-foreign",
    });

    upsertAgentPath(fixture.db, localChild, BASE_TIME);

    assert.equal(parentOf(fixture, "thread-local-child"), "thread-local-root");
    assert.equal(
      diagnosticByCode(fixture, "thread-hierarchy-cross-session")?.severity,
      "warning",
    );
    assert.deepEqual(
      JSON.parse(
        diagnosticByCode(fixture, "thread-hierarchy-cross-session")
          ?.details_json ?? "{}",
      ),
      {
        origin: "hierarchy-repository",
        session: "session-local",
        current: "thread-local-child",
        parent: "thread-foreign",
        root: "thread-local-root",
        fallbackOutcome: "attached-root",
      },
    );
  });

  test("A 指向 B 后再让 B 指向 A 时拒绝成环并降级到根", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      threadId: "thread-a",
      parentThreadId: "thread-b",
    }), BASE_TIME);
    upsertAgentPath(fixture.db, agentPath({
      threadId: "thread-b",
      parentThreadId: "thread-a",
    }), BASE_TIME);

    assert.equal(parentOf(fixture, "thread-b"), "thread-root");
    assert.equal(
      diagnosticByCode(fixture, "thread-hierarchy-cycle")?.severity,
      "warning",
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) FROM thread_closure
         WHERE ancestor_thread_id <> descendant_thread_id
           AND ancestor_thread_id = 'thread-a'
           AND descendant_thread_id = 'thread-b'`,
      ).pluck().get(),
      0,
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT depth FROM thread_closure
         WHERE ancestor_thread_id = 'thread-root'
           AND descendant_thread_id = 'thread-a'`,
      ).pluck().get(),
      2,
    );
  });

  test("第 33 层父关系超过预算时降级到根且 closure 深度不超过 32", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    let parentThreadId = "thread-root";
    for (let depth = 1; depth <= 33; depth += 1) {
      const threadId = `thread-depth-${depth}`;
      upsertAgentPath(fixture.db, agentPath({
        threadId,
        parentThreadId,
      }), BASE_TIME);
      parentThreadId = threadId;
    }

    assert.equal(parentOf(fixture, "thread-depth-33"), "thread-root");
    assert.equal(
      fixture.db.prepare("SELECT MAX(depth) FROM thread_closure").pluck().get(),
      32,
    );
    assert.equal(
      diagnosticByCode(fixture, "thread-hierarchy-max-depth")?.severity,
      "warning",
    );
    assert.equal(diagnosticCount(fixture), 1);
  });

  test("33 层从叶到根反向到达时为尚未建立的根关系预留深度", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    for (let depth = 33; depth >= 1; depth -= 1) {
      upsertAgentPath(fixture.db, agentPath({
        threadId: `thread-reverse-${depth}`,
        parentThreadId: depth === 1
          ? "thread-root"
          : `thread-reverse-${depth - 1}`,
      }), BASE_TIME);
    }

    assert.equal(parentOf(fixture, "thread-reverse-2"), "thread-root");
    assert.equal(
      fixture.db.prepare("SELECT MAX(depth) FROM thread_closure").pluck().get(),
      32,
    );
    assert.equal(
      diagnosticByCode(fixture, "thread-hierarchy-max-depth")?.severity,
      "warning",
    );
  });

  test("已有不同真实父时保留首个稳定父且不污染 closure", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      threadId: "thread-parent-first",
      parentThreadId: "thread-root",
    }), BASE_TIME);
    upsertAgentPath(fixture.db, agentPath({
      threadId: "thread-child",
      parentThreadId: "thread-parent-first",
    }), BASE_TIME);
    const conflicting = agentPath({
      threadId: "thread-child",
      parentThreadId: "thread-parent-other",
    });

    upsertAgentPath(fixture.db, conflicting, BASE_TIME);
    upsertAgentPath(fixture.db, conflicting, BASE_TIME);

    assert.equal(parentOf(fixture, "thread-child"), "thread-parent-first");
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) FROM thread_closure
         WHERE ancestor_thread_id = 'thread-parent-other'
           AND descendant_thread_id = 'thread-child'`,
      ).pluck().get(),
      0,
    );
    assert.equal(
      diagnosticByCode(fixture, "thread-hierarchy-parent-conflict")?.severity,
      "warning",
    );
    assert.equal(diagnosticCount(fixture), 1);
  });

  test("model 仅合并到 Session 与当前真实 Thread 而不污染占位节点", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    upsertAgentPath(fixture.db, agentPath({
      threadId: "thread-child",
      parentThreadId: "thread-parent",
    }), BASE_TIME, { model: "model-b" });

    assert.deepEqual(
      fixture.db.prepare(
        `SELECT id, model_set_json FROM agent_threads ORDER BY id`,
      ).all(),
      [
        { id: "thread-child", model_set_json: '["model-b"]' },
        { id: "thread-parent", model_set_json: "[]" },
        { id: "thread-root", model_set_json: "[]" },
      ],
    );

    upsertAgentPath(fixture.db, agentPath({
      threadId: "thread-parent",
      parentThreadId: "thread-root",
    }), BASE_TIME, { model: "model-a" });
    upsertAgentPath(fixture.db, agentPath({
      threadId: "thread-child",
      parentThreadId: "thread-parent",
    }), BASE_TIME, { model: "model-b" });

    assert.equal(
      fixture.db.prepare(
        "SELECT model_set_json FROM agent_sessions",
      ).pluck().get(),
      '["model-a","model-b"]',
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT model_set_json FROM agent_threads
         WHERE id = 'thread-parent'`,
      ).pluck().get(),
      '["model-a"]',
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT model_set_json FROM agent_threads
         WHERE id = 'thread-root'`,
      ).pluck().get(),
      "[]",
    );
  });
});

describe("SQLite 单 Exchange 事务派生", () => {
  const fixtures: SqliteFixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  });

  test("params fingerprint 在第 65 个对象键后停止枚举", () => {
    const keys = Array.from({ length: 100 }, (_, index) => `key-${index}`);
    const inspectedKeys = new Set<PropertyKey>();
    const params = new Proxy(Object.create(null) as Record<string, unknown>, {
      ownKeys: () => keys,
      getOwnPropertyDescriptor: (_target, key) => {
        inspectedKeys.add(key);
        return { configurable: true, enumerable: true };
      },
      get: (_target, key) => `value-${String(key)}`,
    });

    const fingerprint = createParamsFingerprint(params);

    assert.equal(fingerprint.complete, false);
    assert.equal(fingerprint.candidateItemCount, 65);
    assert.equal(fingerprint.processedItemCount, 64);
    assert.ok(inspectedKeys.size <= 65);
  });

  test("params fingerprint 全局最多处理 256 个容器项", () => {
    const params = {
      groups: Array.from(
        { length: 4 },
        (_, group) => Array.from({ length: 64 }, (_, index) => `${group}-${index}`),
      ),
    };

    const fingerprint = createParamsFingerprint(params);

    assert.equal(fingerprint.complete, false);
    assert.equal(fingerprint.processedItemCount, 256);
    assert.ok(fingerprint.candidateItemCount > fingerprint.processedItemCount);
  });

  test("hydrate 预算允许更小测试值但硬限制为 8 MiB", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const maxHydrateBytes = 8 * 1024 * 1024;

    for (const hydrateMaxBytes of [0, 1, maxHydrateBytes]) {
      assert.doesNotThrow(() => createExchangeProcessor({
        db: fixture.db,
        dataDir: fixture.dataDir,
        hydrateMaxBytes,
      }));
    }
    for (const hydrateMaxBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => createExchangeProcessor({
          db: fixture.db,
          dataDir: fixture.dataDir,
          hydrateMaxBytes,
        }),
        /hydrateMaxBytes.*非负安全整数/,
      );
    }
    assert.throws(
      () => createExchangeProcessor({
        db: fixture.db,
        dataDir: fixture.dataDir,
        hydrateMaxBytes: maxHydrateBytes + 1,
      }),
      /hydrateMaxBytes.*8 MiB/,
    );
  });

  test("交错 root/child 各自复用 open Turn、独立递增 Step 并直接聚合", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/interleaved.jsonl");
    let hydrateCount = 0;
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      hydrateExchange: async (dataDir, exchange, options) => {
        hydrateCount += 1;
        return hydrateRawCapturedExchange(dataDir, exchange, options);
      },
    });
    const records = [
      processInput(source, 0, makeProcessorExchange({
        sequence: 1,
        threadId: "session-interleaved",
        nativeTurnId: "root-turn-1",
        input: [{ role: "user", content: [{ type: "input_text", text: "root start" }] }],
        output: [{ type: "function_call", call_id: "root-call", name: "read_root", arguments: "{}" }],
      })),
      processInput(source, 100, makeProcessorExchange({
        sequence: 2,
        threadId: "child-thread",
        parentThreadId: "session-interleaved",
        nativeTurnId: "child-turn-1",
        input: [{ role: "user", content: [{ type: "input_text", text: "child start" }] }],
        output: [{ type: "function_call", call_id: "child-call", name: "read_child", arguments: "{}" }],
      })),
      processInput(source, 200, makeProcessorExchange({
        sequence: 3,
        threadId: "session-interleaved",
        nativeTurnId: "root-turn-1",
        input: [{ type: "function_call_output", call_id: "root-call", output: "root ok" }],
        output: [responseMessage("root done")],
      })),
      processInput(source, 300, makeProcessorExchange({
        sequence: 4,
        threadId: "child-thread",
        parentThreadId: "session-interleaved",
        nativeTurnId: "child-turn-1",
        input: [{ type: "function_call_output", call_id: "child-call", output: "child ok" }],
        output: [responseMessage("child done")],
      })),
    ];

    const results = [];
    for (const record of records) {
      results.push(await processor.processExchangeRecord(record));
    }
    const rootThreadId = results[0]?.threadId;
    const childThreadId = results[1]?.threadId;
    const sessionId = results[0]?.sessionId;
    assert.ok(rootThreadId);
    assert.ok(childThreadId);
    assert.ok(sessionId);
    assert.notEqual(rootThreadId, childThreadId);
    assert.equal(hydrateCount, 4);
    assert.deepEqual(turnsFor(fixture, rootThreadId), [
      { status: "open", native_turn_id: "root-turn-1", segment_index: 1 },
    ]);
    assert.deepEqual(turnsFor(fixture, childThreadId), [
      { status: "open", native_turn_id: "child-turn-1", segment_index: 1 },
    ]);
    assert.deepEqual(stepIndexesFor(fixture, rootThreadId), [1, 2]);
    assert.deepEqual(stepIndexesFor(fixture, childThreadId), [1, 2]);
    assert.deepEqual(scopeAggregate(fixture, "session", sessionId), {
      step_request_count: 4,
      auxiliary_request_count: 0,
      tool_call_count: 2,
    });
    assert.deepEqual(scopeAggregate(fixture, "thread", rootThreadId), {
      step_request_count: 2,
      auxiliary_request_count: 0,
      tool_call_count: 1,
    });
    assert.deepEqual(scopeAggregate(fixture, "thread", childThreadId), {
      step_request_count: 2,
      auxiliary_request_count: 0,
      tool_call_count: 1,
    });
    assert.deepEqual(
      fixture.db.prepare(
        "SELECT request_count, thread_count FROM agent_sessions WHERE id = ?",
      ).get(sessionId),
      { request_count: 4, thread_count: 2 },
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT id, request_count, turn_count FROM agent_threads
         WHERE id IN (?, ?) ORDER BY id`,
      ).all(rootThreadId, childThreadId),
      [rootThreadId, childThreadId].sort().map(id => ({
        id,
        request_count: 2,
        turn_count: 1,
      })),
    );
  });

  test("内容筛选投影按同 Thread 上一完整 Request 做 occurrence-aware 排重", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(
      fixture,
      "captures/v2/content-filter-projection.jsonl",
    );
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const first = await processor.processExchangeRecord(processInput(
      source,
      0,
      makeProcessorExchange({
        sequence: 101,
        threadId: "content-filter-thread",
        nativeTurnId: "content-filter-turn",
        input: [{
          role: "user",
          content: [{ type: "input_text", text: "重复上下文" }],
        }],
        output: [responseMessage("first response")],
      }),
    ));
    const second = await processor.processExchangeRecord(processInput(
      source,
      100,
      makeProcessorExchange({
        sequence: 102,
        threadId: "content-filter-thread",
        nativeTurnId: "content-filter-turn",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "重复上下文" }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: "重复上下文" }],
          },
        ],
        output: [responseMessage("second response")],
      }),
    ));

    assert.deepEqual(
      fixture.db.prepare(
        `SELECT filter_state, request_dedupe_state, baseline_exchange_id,
          request_fingerprint_count
        FROM exchange_content_filter_status WHERE exchange_id = ?`,
      ).get(second.exchangeId),
      {
        filter_state: "complete",
        request_dedupe_state: "compared",
        baseline_exchange_id: first.exchangeId,
        request_fingerprint_count: 2,
      },
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT total_count, unique_count, inherited_count, unconfirmed_count
        FROM exchange_content_category_stats
        WHERE exchange_id = ? AND category = 'user_real'`,
      ).get(second.exchangeId),
      {
        total_count: 2,
        unique_count: 1,
        inherited_count: 1,
        unconfirmed_count: 0,
      },
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT total_count, unique_count, inherited_count, unconfirmed_count
        FROM exchange_content_category_stats
        WHERE exchange_id = ? AND category = 'assistant'`,
      ).get(second.exchangeId),
      {
        total_count: 1,
        unique_count: 1,
        inherited_count: 0,
        unconfirmed_count: 0,
      },
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT SUM(occurrence_count) FROM exchange_request_fingerprints
        WHERE exchange_id = ? AND category = 'user_real'`,
      ).pluck().get(second.exchangeId),
      2,
    );
  });

  test("同 body 重试链折叠为同一 Turn（retry_like），不再逐请求开新轮", async () => {
    // 2026-09-17 实测回归：claude-code 同一提示词 11 次 502 重发被切成 11 个 Turn。
    // 重试 = 与同 Thread 上一请求指纹多重集完全一致（全消耗、零新增）⇒ retry_like。
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/retry-fold.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const identicalInput = [{
      role: "user",
      content: [{ type: "input_text", text: "本轮不改动只调研分析：与 cc switch 对比" }],
    }];
    for (let sequence = 0; sequence < 3; sequence += 1) {
      const exchange = makeProcessorExchange({
        sequence: 201 + sequence,
        threadId: "retry-fold-thread",
        routingAgent: "claude",
        wireApi: "messages",
        input: identicalInput,
        output: [responseMessage(`attempt ${sequence}`)],
      });
      seedIngestionRecord(fixture, source, sequence, exchange);
      await processor.processExchangeRecord(processInput(
        source,
        sequence,
        exchange,
      ));
    }

    const thread = fixture.db.prepare(
      "SELECT id FROM agent_threads WHERE display_name = '根 Thread' OR is_root = 1 LIMIT 1",
    ).get() as {id: string};
    const turnCount = fixture.db.prepare(
      "SELECT COUNT(*) AS n FROM agent_turns WHERE agent_thread_id = ?",
    ).pluck().get(thread.id) as number;
    assert.equal(turnCount, 1, "3 次同 body 请求必须折叠进同一个 Turn");

    const steps = fixture.db.prepare(
      `SELECT step_index, request_action, request_intent_label
       FROM agent_steps WHERE agent_thread_id = ? ORDER BY step_index`,
    ).all(thread.id) as Array<{step_index: number; request_action: string; request_intent_label: string}>;
    assert.equal(steps.length, 3);
    assert.equal(steps[0]!.request_action, "user_prompt");
    assert.equal(steps[1]!.request_action, "retry_like");
    assert.equal(steps[2]!.request_action, "retry_like");
    assert.equal(steps[1]!.request_intent_label, "重试");
    assert.equal(steps[2]!.request_intent_label, "重试");
  });

  test("导入行 Harness 空组件从同 Agent 富快照借补并写诊断", async () => {
    // 2026-09-18 实测回归：dsh 官方直连本地日志不落 tools 定义（request/header.config
    // 无 tools，wire 层才有），导入行空快照应从同 Agent 网关富快照借补且收敛同一哈希。
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/harness-borrow.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const dshSessionHeaders = {
      "user-agent": "deepseek-harness/0.1",
      "x-deepseek-harness-session-id": "dsh-borrow-sess",
    };
    const run = (sequence: number, withTools: boolean, origin?: "gateway" | "agent_local_import") =>
      processor.processExchangeRecord(processInput(
        source,
        sequence,
        makeProcessorExchange({
          sequence: 500 + sequence,
          threadId: "dsh-borrow-thread",
          routingAgent: "dsh",
          routingOrigin: origin,
          wireApi: "chat_completions",
          requestPath: "/v1/chat/completions",
          headers: dshSessionHeaders,
          input: [],
          output: [],
          requestBody: JSON.stringify({
            model: "dsh-fixture",
            messages: [{ role: "user", content: `问题 ${sequence}` }],
            ...(withTools ? {tools: [
              {type: "function", function: {name: "bash", parameters: {type: "object"}}},
              {type: "function", function: {name: "read", parameters: {type: "object"}}},
            ]} : {}),
          }),
          responseBody: chatResponseFixture(`回复 ${sequence}`),
        }),
      ));
    const gateway = await run(1, true, "gateway");
    const imported = await run(2, false, "agent_local_import");

    const hashOf = (exchangeId: string) => fixture.db.prepare(
      "SELECT harness_snapshot_hash FROM agent_steps WHERE exchange_id = ?",
    ).pluck().get(exchangeId) as string | null;
    const gatewayHash = hashOf(gateway.exchangeId!);
    const importHash = hashOf(imported.exchangeId!);
    assert.ok(gatewayHash, "网关行必须有快照");
    assert.equal(importHash, gatewayHash, "借补后的等价清单必须收敛到同一快照哈希");

    const snapshot = fixture.db.prepare(
      "SELECT tool_count FROM harness_snapshots WHERE snapshot_hash = ?",
    ).get(gatewayHash) as {tool_count: number};
    assert.equal(snapshot.tool_count, 2);

    const diag = fixture.db.prepare(
      "SELECT details_json FROM derivation_diagnostics WHERE exchange_id = ? AND code = 'harness_inventory_borrowed'",
    ).get(imported.exchangeId!) as {details_json: string} | undefined;
    assert.ok(diag, "借补必须写 harness_inventory_borrowed 诊断");
    assert.deepEqual(JSON.parse(diag.details_json), {borrowed: ["tools"]});
  });

  test("原生 Turn 身份优先：native id 未变时内容边界不开新轮（dsh）", async () => {
    // 2026-09-18 实测回归：dsh 会话内注入的权限/计划 user-role 项触发 user_prompt，
    // 把本地语义只有一轮（所有 step.turn=1）的会话切成 7 轮。原生 id 未变时必须沿用。
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/native-turn-precedence.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const dshHeaders = (turn: number) => ({
      "user-agent": "deepseek-harness/0.1",
      "x-deepseek-harness-session-id": "dsh-native-turn-sess",
      "x-dsh-turn-id": `dsh-native-turn-sess:turn:${turn}`,
    });
    const dshBody = (texts: string[]) => JSON.stringify({
      model: "dsh-fixture",
      messages: texts.map(text => ({ role: "user", content: text })),
    });
    const run = (sequence: number, turn: number, texts: string[]) => processor.processExchangeRecord(processInput(
      source,
      sequence,
      makeProcessorExchange({
        sequence: 300 + sequence,
        threadId: "dsh-native-thread",
        routingAgent: "dsh",
        wireApi: "chat_completions",
        requestPath: "/v1/chat/completions",
        headers: dshHeaders(turn),
        input: [],
        output: [],
        requestBody: dshBody(texts),
        responseBody: chatResponseFixture(`回复 ${sequence}`),
      }),
    ));
    await run(1, 1, ["你好"]);
    // 同 native turn 注入新 user 项（权限确认等）：旧逻辑会开新轮。
    await run(2, 1, ["你好", "权限确认补充"]);
    // native turn 真实变化：开新轮。
    await run(3, 2, ["新问题"]);

    const turns = fixture.db.prepare(
      `SELECT tu.id, tu.native_turn_id, count(st.id) AS steps
       FROM agent_turns tu
       JOIN agent_threads t ON t.id = tu.agent_thread_id
       LEFT JOIN agent_steps st ON st.agent_turn_id = tu.id
       WHERE t.agent_session_id IN (SELECT id FROM agent_sessions WHERE agent_name='dsh')
       GROUP BY tu.id ORDER BY min(st.timestamp)`,
    ).all() as Array<{id: string; native_turn_id: string; steps: number}>;
    assert.equal(turns.length, 2, `turns=${JSON.stringify(turns)}`);
    assert.equal(turns[0]!.native_turn_id, "dsh-native-turn-sess:turn:1");
    assert.equal(turns[0]!.steps, 2, "前两个请求必须同轮");
    assert.equal(turns[1]!.native_turn_id, "dsh-native-turn-sess:turn:2");
    assert.equal(turns[1]!.steps, 1);
  });

  test("失败尝试不换轮：502 对冲尝试折叠进当前轮并标重试", async () => {
    // 2026-09-18 实测回归：claude-code 主备模型对冲（21 次 502 各开一轮）。
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/failed-attempt-fold.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const claudeHeaders = {
      "user-agent": "claude-cli/2.0.0 (external)",
      "anthropic-version": "2023-06-01",
      "x-claude-code-session-id": "sess-failed-attempt",
    };
    const claudeBody = (texts: string[]) => JSON.stringify({
      model: "claude-fixture",
      system: "You are Claude Code.",
      messages: texts.map(text => ({ role: "user", content: [{ type: "text", text }] })),
    });
    const run = (sequence: number, texts: string[], status: number) => processor.processExchangeRecord(processInput(
      source,
      sequence,
      makeProcessorExchange({
        sequence: 400 + sequence,
        threadId: "failed-attempt-thread",
        routingAgent: "claude",
        wireApi: "messages",
        headers: claudeHeaders,
        input: [],
        output: [],
        requestBody: claudeBody(texts),
        responseBody: chatResponseFixture(`回复 ${sequence}`),
        responseStatus: status,
      }),
    ));
    await run(1, ["问题"], 200);
    // 主模型 502 的对冲尝试：新内容但失败 → 折叠进当前轮。
    await run(2, ["问题", "备用通道"], 502);
    // 成功的后续请求：正常开新轮。
    await run(3, ["问题", "备用通道", "继续"], 200);

    const turns = fixture.db.prepare(
      `SELECT tu.id, count(st.id) AS steps
       FROM agent_turns tu
       JOIN agent_threads t ON t.id = tu.agent_thread_id
       LEFT JOIN agent_steps st ON st.agent_turn_id = tu.id
       WHERE t.agent_session_id IN (SELECT id FROM agent_sessions WHERE agent_name='claude-code')
       GROUP BY tu.id ORDER BY min(st.timestamp)`,
    ).all() as Array<{id: string; steps: number}>;
    assert.equal(turns.length, 2, `turns=${JSON.stringify(turns)}`);

    const steps = fixture.db.prepare(
      `SELECT st.step_index, st.request_action, st.request_intent_label, st.agent_turn_id,
         st.phase
       FROM agent_steps st
       WHERE st.agent_session_id IN (SELECT id FROM agent_sessions WHERE agent_name='claude-code')
       ORDER BY st.timestamp`,
    ).all() as Array<{step_index: number; request_action: string; request_intent_label: string; agent_turn_id: string; phase: string}>;
    assert.equal(steps.length, 3);
    assert.equal(steps[1]!.request_action, "retry_like");
    assert.equal(steps[1]!.request_intent_label, "重试");
    assert.equal(steps[1]!.agent_turn_id, turns[0]!.id, "失败尝试必须折叠进当前轮");
    assert.equal(steps[2]!.agent_turn_id, turns[1]!.id, "成功请求照常开新轮");
  });

  test("Codex compaction 后保留的无 ID user 输入按同 native Turn 继承", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(
      fixture,
      "captures/v2/content-filter-compaction-carryover.jsonl",
    );
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const before = await processor.processExchangeRecord(processInput(
      source,
      0,
      makeProcessorExchange({
        sequence: 107,
        threadId: "content-filter-compaction-thread",
        nativeTurnId: "content-filter-compaction-turn",
        input: [
          { role: "user", content: [{ type: "input_text", text: "旧输入 A" }] },
          { role: "user", content: [{ type: "input_text", text: "旧输入 B" }] },
          { role: "user", content: [{ type: "input_text", text: "确认，请实现！" }] },
          {
            role: "user",
            content: [{
              type: "input_text",
              text: "You are performing a CONTEXT CHECKPOINT COMPACTION.",
            }],
          },
        ],
        output: [responseMessage("checkpoint response")],
      }),
    ));
    const after = await processor.processExchangeRecord(processInput(
      source,
      100,
      makeProcessorExchange({
        sequence: 108,
        threadId: "content-filter-compaction-thread",
        nativeTurnId: "content-filter-compaction-turn",
        input: [
          { role: "user", content: [{ type: "input_text", text: "旧输入 A" }] },
          { role: "user", content: [{ type: "input_text", text: "旧输入 B" }] },
          { role: "user", content: [{ type: "input_text", text: "确认，请实现！" }] },
        ],
        output: [responseMessage("after compaction response")],
      }),
    ));

    const status = fixture.db.prepare(
      `SELECT request_context_mode, request_comparison_kind,
        request_context_epoch, effective_context_boundary_id,
        produced_context_boundary_id, baseline_exchange_id,
        request_dedupe_state
       FROM exchange_content_filter_status WHERE exchange_id = ?`,
    ).get(after.exchangeId) as {
      request_context_mode: string;
      request_comparison_kind: string;
      request_context_epoch: number;
      effective_context_boundary_id: string | null;
      produced_context_boundary_id: string | null;
      baseline_exchange_id: string | null;
      request_dedupe_state: string;
    };
    assert.deepEqual(
      {
        ...status,
        effective_context_boundary_id: status.effective_context_boundary_id
          ? "<boundary>"
          : null,
      },
      {
        request_context_mode: "full_replay",
        request_comparison_kind: "boundary_carryover",
        request_context_epoch: 1,
        effective_context_boundary_id: "<boundary>",
        produced_context_boundary_id: null,
        baseline_exchange_id: before.exchangeId,
        request_dedupe_state: "compared",
      },
    );
    const carryover = fixture.db.prepare(
      `SELECT total_count, unique_count, inherited_count, unconfirmed_count
       FROM exchange_content_category_stats
       WHERE exchange_id = ? AND body_side = 'request' AND category = 'user_real'`,
    ).get(after.exchangeId);
    assert.deepEqual(carryover, {
      total_count: 3,
      unique_count: 0,
      inherited_count: 3,
      unconfirmed_count: 0,
    });
    const preview = JSON.parse(fixture.db.prepare(
      "SELECT preview_json FROM exchange_content_previews WHERE exchange_id = ?",
    ).pluck().get(after.exchangeId) as string) as {
      requestContext?: {
        comparisonKind?: string;
        effectiveBoundaryId?: string;
        resolution?: string;
      };
    };
    assert.deepEqual(
      {
        ...preview.requestContext,
        effectiveBoundaryId: preview.requestContext?.effectiveBoundaryId
          ? "<boundary>"
          : undefined,
      },
      {
        contextMode: "full_replay",
        contextEpoch: 1,
        effectiveBoundaryId: "<boundary>",
        comparisonKind: "boundary_carryover",
        baselineExchangeId: before.exchangeId,
        resolution: "resolved",
      },
    );
  });

  test("Response 不可用不影响完整 Request 的类别筛选和后续请求排重", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(
      fixture,
      "captures/v2/content-filter-missing-response.jsonl",
    );
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const firstExchange = makeProcessorExchange({
      sequence: 105,
      threadId: "content-filter-missing-response-thread",
      nativeTurnId: "content-filter-missing-response-turn",
      input: [{
        role: "user",
        content: [{ type: "input_text", text: "完整请求正文" }],
      }],
      output: [],
    });
    firstExchange.request.bodySha256 = createHash("sha256")
      .update(firstExchange.request.rawBody!)
      .digest("hex");
    delete firstExchange.response.rawBody;
    firstExchange.captureDiagnostics.push({
      code: "missing_raw_body",
      severity: "error",
      message: "测试模拟 Response 未落盘",
    });
    const first = await processor.processExchangeRecord(processInput(
      source,
      0,
      firstExchange,
    ));
    const second = await processor.processExchangeRecord(processInput(
      source,
      100,
      makeProcessorExchange({
        sequence: 106,
        threadId: "content-filter-missing-response-thread",
        nativeTurnId: "content-filter-missing-response-turn",
        input: [{
          role: "user",
          content: [{ type: "input_text", text: "完整请求正文" }],
        }],
        output: [responseMessage("second response")],
      }),
    ));

    assert.deepEqual(
      fixture.db.prepare(
        `SELECT request_dedupe_state, baseline_exchange_id
         FROM exchange_content_filter_status WHERE exchange_id = ?`,
      ).get(second.exchangeId),
      {
        request_dedupe_state: "compared",
        baseline_exchange_id: first.exchangeId,
      },
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT unique_count, inherited_count, unconfirmed_count
         FROM exchange_content_category_stats
         WHERE exchange_id = ? AND category = 'user_real'`,
      ).get(second.exchangeId),
      { unique_count: 0, inherited_count: 1, unconfirmed_count: 0 },
    );
    const selected = selectExportExchangeRefs(fixture.db, {
      session: second.sessionId,
      thread: second.threadId,
      scope: "all",
      categories: ["user_real"],
      categoriesExplicit: true,
      includeInherited: true,
      exchangeLimit: 25,
    });
    assert.equal(selected.candidateCount, 2);
    assert.equal(selected.candidateCountExact, true);
  });

  test("上一模型 Request 缺少筛选投影时当前输入标记为 unconfirmed", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(
      fixture,
      "captures/v2/content-filter-unconfirmed.jsonl",
    );
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const first = await processor.processExchangeRecord(processInput(
      source,
      0,
      makeProcessorExchange({
        sequence: 103,
        threadId: "content-filter-unconfirmed-thread",
        nativeTurnId: "content-filter-unconfirmed-turn",
        input: [{
          role: "user",
          content: [{ type: "input_text", text: "legacy request" }],
        }],
        output: [responseMessage("legacy response")],
      }),
    ));
    fixture.db.prepare(
      "DELETE FROM exchange_content_category_stats WHERE exchange_id = ?",
    ).run(first.exchangeId);
    fixture.db.prepare(
      "DELETE FROM exchange_request_fingerprints WHERE exchange_id = ?",
    ).run(first.exchangeId);
    fixture.db.prepare(
      "DELETE FROM exchange_content_filter_status WHERE exchange_id = ?",
    ).run(first.exchangeId);

    const current = await processor.processExchangeRecord(processInput(
      source,
      100,
      makeProcessorExchange({
        sequence: 104,
        threadId: "content-filter-unconfirmed-thread",
        nativeTurnId: "content-filter-unconfirmed-turn",
        input: [{
          role: "user",
          content: [{ type: "input_text", text: "current request" }],
        }],
        output: [responseMessage("current response")],
      }),
    ));

    assert.deepEqual(
      fixture.db.prepare(
        `SELECT filter_state, request_dedupe_state, baseline_exchange_id
        FROM exchange_content_filter_status WHERE exchange_id = ?`,
      ).get(current.exchangeId),
      {
        filter_state: "complete",
        request_dedupe_state: "unconfirmed",
        baseline_exchange_id: null,
      },
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT unique_count, inherited_count, unconfirmed_count
        FROM exchange_content_category_stats
        WHERE exchange_id = ? AND category = 'user_real'`,
      ).get(current.exchangeId),
      { unique_count: 0, inherited_count: 0, unconfirmed_count: 1 },
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT unique_count, inherited_count, unconfirmed_count
        FROM exchange_content_category_stats
        WHERE exchange_id = ? AND category = 'assistant'`,
      ).get(current.exchangeId),
      { unique_count: 1, inherited_count: 0, unconfirmed_count: 0 },
    );
  });

  test("重复 input 零水合且所有派生表和直接聚合保持不变", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/duplicate.jsonl");
    let hydrateCount = 0;
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      hydrateExchange: async (dataDir, exchange, options) => {
        hydrateCount += 1;
        return hydrateRawCapturedExchange(dataDir, exchange, options);
      },
    });
    const input = processInput(source, 0, makeProcessorExchange({
      sequence: 1,
      threadId: "session-duplicate",
      nativeTurnId: "turn-duplicate",
      input: [{ role: "user", content: [{ type: "input_text", text: "once" }] }],
      output: [responseMessage("done")],
    }));

    const first = await processor.processExchangeRecord(input);
    const before = derivationTableSnapshot(fixture);
    const replay = await processor.processExchangeRecord(input);

    assert.equal(first.duplicate, false);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.exchangeId, input.exchange.exchangeId);
    assert.equal(hydrateCount, 1);
    assert.deepEqual(derivationTableSnapshot(fixture), before);
  });

  test("native turn 变化只关闭当前 Thread 且 segment/Turn ID 稳定", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/turn-boundary.jsonl");
    const processor = createExchangeProcessor({ db: fixture.db, dataDir: fixture.dataDir });
    const rootFirst = await processor.processExchangeRecord(processInput(
      source,
      0,
      makeProcessorExchange({
        sequence: 20,
        threadId: "session-interleaved",
        nativeTurnId: "root-native-1",
        input: [{ role: "user", content: [{ type: "input_text", text: "root one" }] }],
        output: [responseMessage("root one done")],
      }),
    ));
    const childFirst = await processor.processExchangeRecord(processInput(
      source,
      100,
      makeProcessorExchange({
        sequence: 21,
        threadId: "child-boundary",
        parentThreadId: "session-interleaved",
        nativeTurnId: "child-native-1",
        input: [{ role: "user", content: [{ type: "input_text", text: "child one" }] }],
        output: [responseMessage("child one done")],
      }),
    ));
    const rootSecond = await processor.processExchangeRecord(processInput(
      source,
      200,
      makeProcessorExchange({
        sequence: 22,
        threadId: "session-interleaved",
        nativeTurnId: "root-native-2",
        input: [{ role: "user", content: [{ type: "input_text", text: "root two" }] }],
        output: [responseMessage("root two done")],
      }),
    ));
    const rootThird = await processor.processExchangeRecord(processInput(
      source,
      300,
      makeProcessorExchange({
        sequence: 23,
        threadId: "session-interleaved",
        nativeTurnId: "root-native-1",
        input: [{ role: "user", content: [{ type: "input_text", text: "root one again" }] }],
        output: [responseMessage("root one again done")],
      }),
    ));

    assert.ok(rootFirst.threadId);
    assert.ok(childFirst.threadId);
    assert.deepEqual(turnsFor(fixture, rootFirst.threadId), [
      { status: "closed", native_turn_id: "root-native-1", segment_index: 1 },
      { status: "closed", native_turn_id: "root-native-2", segment_index: 2 },
      { status: "open", native_turn_id: "root-native-1", segment_index: 3 },
    ]);
    assert.deepEqual(turnsFor(fixture, childFirst.threadId), [
      { status: "open", native_turn_id: "child-native-1", segment_index: 1 },
    ]);
    assert.notEqual(rootFirst.turnId, rootSecond.turnId);
    assert.notEqual(rootFirst.turnId, rootThird.turnId);
    assert.notEqual(rootSecond.turnId, rootThird.turnId);
    assert.equal(
      rootFirst.turnId,
      fixture.db.prepare(
        `SELECT id FROM agent_turns
         WHERE agent_thread_id = ? AND segment_index = 1`,
      ).pluck().get(rootFirst.threadId),
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT agent_turn_id, step_index FROM agent_steps
         WHERE agent_thread_id = ? ORDER BY timestamp`,
      ).all(rootFirst.threadId),
      [
        { agent_turn_id: rootFirst.turnId, step_index: 1 },
        { agent_turn_id: rootSecond.turnId, step_index: 1 },
        { agent_turn_id: rootThird.turnId, step_index: 1 },
      ],
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT turn_count FROM agent_threads WHERE id = ?`,
      ).get(rootFirst.threadId),
      { turn_count: 3 },
    );
  });

  test("辅助请求仅按明确 Thread/native Turn 或同 Thread 唯一 open Turn 归属", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/auxiliary.jsonl");
    const processor = createExchangeProcessor({ db: fixture.db, dataDir: fixture.dataDir });
    const root = await processor.processExchangeRecord(processInput(source, 0, makeProcessorExchange({
      sequence: 30,
      threadId: "session-interleaved",
      nativeTurnId: "root-aux-turn",
      input: [{ role: "user", content: [{ type: "input_text", text: "root" }] }],
      output: [responseMessage("root done")],
    })));
    const child = await processor.processExchangeRecord(processInput(source, 100, makeProcessorExchange({
      sequence: 31,
      threadId: "child-aux",
      parentThreadId: "session-interleaved",
      nativeTurnId: "child-aux-turn",
      input: [{ role: "user", content: [{ type: "input_text", text: "child" }] }],
      output: [responseMessage("child done")],
    })));
    const explicit = await processor.processExchangeRecord(processInput(source, 200, makeProcessorExchange({
      sequence: 32,
      threadId: "child-aux",
      parentThreadId: "session-interleaved",
      nativeTurnId: "child-aux-turn",
      requestPath: "/v1/messages/count_tokens",
      input: [{ role: "user", content: [{ type: "input_text", text: "count explicit" }] }],
      output: [],
    })));
    const uniqueOpen = await processor.processExchangeRecord(processInput(source, 300, makeProcessorExchange({
      sequence: 33,
      threadId: "child-aux",
      parentThreadId: "session-interleaved",
      requestPath: "/v1/messages/count_tokens",
      input: [{ role: "user", content: [{ type: "input_text", text: "count current" }] }],
      output: [],
    })));
    const noTurn = await processor.processExchangeRecord(processInput(source, 400, makeProcessorExchange({
      sequence: 34,
      threadId: "child-without-turn",
      parentThreadId: "session-interleaved",
      requestPath: "/v1/messages/count_tokens",
      input: [{ role: "user", content: [{ type: "input_text", text: "count isolated" }] }],
      output: [],
    })));
    const sessionOnly = await processor.processExchangeRecord(processInput(source, 500, makeProcessorExchange({
      sequence: 35,
      threadId: "omitted-thread",
      sessionOnly: true,
      requestPath: "/v1/messages/count_tokens",
      input: [{ role: "user", content: [{ type: "input_text", text: "count root" }] }],
      output: [],
    })));

    assert.ok(root.turnId);
    assert.ok(root.threadId);
    assert.ok(child.threadId);
    assert.ok(child.turnId);
    assert.equal(explicit.threadId, child.threadId);
    assert.equal(explicit.turnId, child.turnId);
    assert.equal(uniqueOpen.threadId, child.threadId);
    assert.equal(uniqueOpen.turnId, child.turnId);
    assert.equal(noTurn.turnId, undefined);
    assert.equal(sessionOnly.threadId, root.threadId);
    assert.equal(sessionOnly.turnId, root.turnId);
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM agent_steps").pluck().get(),
      2,
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT exchange_id, agent_thread_id, agent_turn_id, kind
         FROM auxiliary_requests ORDER BY timestamp`,
      ).all(),
      [
        {
          exchange_id: "capture-processor:ex-32",
          agent_thread_id: child.threadId,
          agent_turn_id: child.turnId,
          kind: "token_count",
        },
        {
          exchange_id: "capture-processor:ex-33",
          agent_thread_id: child.threadId,
          agent_turn_id: child.turnId,
          kind: "token_count",
        },
        {
          exchange_id: "capture-processor:ex-34",
          agent_thread_id: noTurn.threadId,
          agent_turn_id: null,
          kind: "token_count",
        },
        {
          exchange_id: "capture-processor:ex-35",
          agent_thread_id: root.threadId,
          agent_turn_id: root.turnId,
          kind: "token_count",
        },
      ],
    );
    assert.deepEqual(scopeAggregate(fixture, "session", root.sessionId!), {
      step_request_count: 2,
      auxiliary_request_count: 4,
      tool_call_count: 0,
    });
    assert.deepEqual(scopeAggregate(fixture, "thread", child.threadId), {
      step_request_count: 1,
      auxiliary_request_count: 2,
      tool_call_count: 0,
    });
    assert.deepEqual(scopeAggregate(fixture, "turn", root.turnId), {
      step_request_count: 1,
      auxiliary_request_count: 1,
      tool_call_count: 0,
    });
    assert.deepEqual(scopeAggregate(fixture, "turn", child.turnId), {
      step_request_count: 1,
      auxiliary_request_count: 2,
      tool_call_count: 0,
    });
  });

  test("辅助请求账本倍率跟随密钥配置（回归：辅助分支漏传倍率恒为 1）", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    // 显式价格条目保证 fixture-model 命中（unmatched 快照不携带倍率，会掩盖漏传）。
    await writeFile(
      join(fixture.dataDir, "config", "model-pricing.json"),
      JSON.stringify({
        version: 2,
        currency: "USD",
        unit: "per_million_tokens",
        models: [{
          id: "fixture-model",
          vendor: "openai",
          patterns: ["fixture-model"],
          pricing: {input: 1, output: 1},
          confidence: "official",
        }],
      }),
    );
    const now = new Date().toISOString();
    await writeFile(
      join(fixture.dataDir, "config", "development-credentials.json"),
      `${JSON.stringify({
        version: 1,
        credentials: [{
          id: "cred_aux_rate",
          targetId: "target-processor",
          label: "辅助倍率",
          store: "macos-keychain",
          account: "cred_aux_rate",
          fingerprintSuffix: "abcd",
          rateMultiplier: 4,
          createdAt: now,
          updatedAt: now,
        }],
      }, null, 2)}\n`,
    );
    const source = seedIngestionSource(fixture, "captures/v2/auxiliary.jsonl");
    const processor = createExchangeProcessor({ db: fixture.db, dataDir: fixture.dataDir });
    const titleInput = [{
      role: "user",
      content: [{ type: "input_text", text: "Generate a concise, single-line task title of at most 36 characters. <task>fix bug</task>" }],
    }];

    // 带会话头的 Codex 标题请求 → writeAuxiliaryRequest 分支。
    await processor.processExchangeRecord(processInput(source, 0, makeProcessorExchange({
      sequence: 36,
      threadId: "aux-rate-session",
      nativeTurnId: "aux-rate-turn",
      routingAgent: "codex",
      wireApi: "responses",
      routingClientCredentialId: "cred_aux_rate",
      input: titleInput,
      output: [responseMessage("修复登录超时")],
    })));
    // 无会话头（身份回退 capture-session）→ writeTargetLevelAuxiliaryRequest 分支。
    await processor.processExchangeRecord(processInput(source, 100, makeProcessorExchange({
      sequence: 37,
      threadId: "aux-rate-capture",
      omitSessionHeader: true,
      routingAgent: "codex",
      wireApi: "responses",
      routingClientCredentialId: "cred_aux_rate",
      input: titleInput,
      output: [responseMessage("修复登录超时")],
    })));

    const rows = fixture.db.prepare(
      `SELECT exchange_id, request_kind, rate_multiplier, vendor_cost, actual_cost
       FROM usage_ledger WHERE exchange_id IN ('capture-processor:ex-36', 'capture-processor:ex-37')
       ORDER BY exchange_id`,
    ).all() as Array<{
      exchange_id: string;
      request_kind: string;
      rate_multiplier: number;
      vendor_cost: number;
      actual_cost: number;
    }>;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.request_kind, "auxiliary");
      assert.equal(row.rate_multiplier, 4, `${row.exchange_id} 倍率应取密钥配置 4`);
      assert.ok(
        Math.abs(row.actual_cost - row.vendor_cost * 4) < 1e-12,
        `${row.exchange_id} 实付金额应按倍率 4 放大`,
      );
    }
  });

  test("辅助请求按 conversation id 精确复用唯一 Session", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/conversation-auxiliary.jsonl");
    const processor = createExchangeProcessor({ db: fixture.db, dataDir: fixture.dataDir });
    const root = await processor.processExchangeRecord(processInput(source, 0, makeProcessorExchange({
      sequence: 36,
      threadId: "conversation-thread",
      nativeTurnId: "conversation-turn",
      conversationId: "conversation-only-identity",
      omitSessionHeader: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "conversation root" }] }],
      output: [responseMessage("conversation root done")],
    })));
    const auxiliary = await processor.processExchangeRecord(processInput(
      source,
      100,
      makeProcessorExchange({
        sequence: 37,
        threadId: "conversation-thread",
        nativeTurnId: "conversation-turn",
        conversationId: "conversation-only-identity",
        omitSessionHeader: true,
        requestPath: "/v1/messages/count_tokens",
        input: [{ role: "user", content: [{ type: "input_text", text: "count conversation" }] }],
        output: [],
      }),
    ));

    assert.ok(root.sessionId);
    assert.ok(root.threadId);
    assert.ok(root.turnId);
    assert.equal(auxiliary.sessionId, root.sessionId);
    assert.equal(auxiliary.threadId, root.threadId);
    assert.equal(auxiliary.turnId, root.turnId);
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) FROM agent_sessions
         WHERE target_id = ? AND agent_name = ? AND external_conversation_id = ?`,
      ).pluck().get("target-processor", "codex", "conversation-only-identity"),
      1,
    );
  });

  test("无 Session 身份的 models 请求只写目标级辅助账本", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/target-metadata.jsonl");
    const processor = createExchangeProcessor({ db: fixture.db, dataDir: fixture.dataDir });

    const result = await processor.processExchangeRecord(processInput(
      source,
      0,
      makeProcessorExchange({
        sequence: 38,
        threadId: "unused-target-thread",
        sessionOnly: true,
        omitSessionHeader: true,
        requestPath: "/models",
        input: [],
        output: [],
      }),
    ));

    assert.equal(result.sessionId, undefined);
    assert.equal(result.threadId, undefined);
    assert.equal(result.turnId, undefined);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM agent_sessions").pluck().get(), 0);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM agent_threads").pluck().get(), 0);
    const auxiliary = fixture.db.prepare(
      `SELECT agent_session_id, agent_thread_id, agent_turn_id,
        target_id, agent_fingerprint_id, agent_name, kind
      FROM auxiliary_requests WHERE exchange_id = ?`,
    ).get(result.exchangeId) as Record<string, unknown>;
    assert.equal(auxiliary.agent_session_id, null);
    assert.equal(auxiliary.agent_thread_id, null);
    assert.equal(auxiliary.agent_turn_id, null);
    assert.equal(auxiliary.target_id, "target-processor");
    assert.equal(typeof auxiliary.agent_fingerprint_id, "string");
    assert.equal(auxiliary.agent_name, "codex");
    assert.equal(auxiliary.kind, "metadata");
    const ledger = fixture.db.prepare(
      `SELECT agent_session_id, agent_thread_id, agent_turn_id,
        target_id, agent_name FROM usage_ledger WHERE exchange_id = ?`,
    ).get(result.exchangeId) as Record<string, unknown>;
    assert.equal(ledger.agent_session_id, null);
    assert.equal(ledger.agent_thread_id, null);
    assert.equal(ledger.agent_turn_id, null);
    assert.equal(ledger.target_id, "target-processor");
    assert.equal(ledger.agent_name, "codex");
  });

  test("raw 携带 firstTokenMs 时写入账本 first_token_ms，缺省为 NULL", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/first-token.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      hydrateExchange: async (dataDir, exchange, options) =>
        hydrateRawCapturedExchange(dataDir, exchange, options),
    });
    const withTtft = await processor.processExchangeRecord(processInput(
      source,
      0,
      makeProcessorExchange({
        sequence: 1,
        threadId: "thread-ttft",
        nativeTurnId: "turn-ttft-1",
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        output: [responseMessage("ok")],
        firstTokenMs: 420,
      }),
    ));
    const withoutTtft = await processor.processExchangeRecord(processInput(
      source,
      100,
      makeProcessorExchange({
        sequence: 2,
        threadId: "thread-ttft",
        nativeTurnId: "turn-ttft-1",
        input: [{ role: "user", content: [{ type: "input_text", text: "hi2" }] }],
        output: [responseMessage("ok2")],
      }),
    ));
    assert.ok(withTtft && withoutTtft);
    const rows = fixture.db.prepare(
      `SELECT exchange_id, first_token_ms FROM usage_ledger ORDER BY exchange_id`,
    ).all() as Array<{ exchange_id: string; first_token_ms: number | null }>;
    assert.equal(rows.length, 2);
    const ttftRow = rows.find(row => row.exchange_id === withTtft.exchangeId);
    const legacyRow = rows.find(row => row.exchange_id === withoutTtft.exchangeId);
    assert.equal(ttftRow?.first_token_ms, 420);
    assert.equal(legacyRow?.first_token_ms, null);
  });

  test("新派生行同步写入按完成时刻索引的脱敏对账投影，不回填旧账本", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/reconciliation-local.jsonl");
    fixture.db.prepare(
      `INSERT INTO console_accounts(
        id,target_id,provider_type,console_base_url,username,password_ref,
        created_at,updated_at
      ) VALUES('acct-recon','target-processor','sub2api','https://relay.example',
        'u','ref',?,?)`,
    ).run(BASE_TIME, BASE_TIME);
    const processor = createExchangeProcessor({db: fixture.db, dataDir: fixture.dataDir});
    const exchange = makeProcessorExchange({
      sequence: 63,
      threadId: "thread-reconciliation",
      input: [{role: "user", content: [{type: "input_text", text: "hi"}]}],
      output: [responseMessage("done")],
      responseHeaders: {
        "x-oneapi-request-id": "oneapi-request-63",
        "x-request-id": "generic-request-63",
      },
    });
    await processor.processExchangeRecord(processInput(source, 0, exchange));

    assert.deepEqual(fixture.db.prepare(
      `SELECT exchange_id, target_id, completed_at, provider_request_id, endpoint
       FROM relay_local_usage_events WHERE exchange_id = ?`,
    ).get(exchange.exchangeId), {
      exchange_id: exchange.exchangeId,
      target_id: "target-processor",
      completed_at: exchange.completedAt,
      provider_request_id: "oneapi-request-63",
      endpoint: "/v1/responses",
    });
    // 2026-09-26 优先级：sub2api 账单同源的 x-client-request-id 优先于
    // 代理链拼接的 x-request-id（new-api 的 x-oneapi-request-id 仍最高）。
    const clientHeaderExchange = makeProcessorExchange({
      sequence: 66,
      threadId: "thread-reconciliation",
      input: [{role: "user", content: [{type: "input_text", text: "hi3"}]}],
      output: [responseMessage("done3")],
      responseHeaders: {
        "x-client-request-id": "52aa945f-3f1f-4312-bf3d-9631ae5a0ebb",
        "x-request-id": "upstream-uuid, 5162bf",
      },
    });
    await processor.processExchangeRecord(processInput(source, 200, clientHeaderExchange));
    assert.deepEqual(fixture.db.prepare(
      "SELECT provider_request_id FROM relay_local_usage_events WHERE exchange_id = ?",
    ).get(clientHeaderExchange.exchangeId), {
      provider_request_id: "52aa945f-3f1f-4312-bf3d-9631ae5a0ebb",
    });
    fixture.db.prepare("DELETE FROM console_accounts WHERE id='acct-recon'").run();
    const noRelay = makeProcessorExchange({
      sequence: 64,
      threadId: "thread-reconciliation",
      input: [{role: "user", content: [{type: "input_text", text: "hi2"}]}],
      output: [responseMessage("done2")],
    });
    await processor.processExchangeRecord(processInput(source, 100, noRelay));
    assert.equal(fixture.db.prepare(
      "SELECT COUNT(*) FROM relay_local_usage_events WHERE exchange_id=?",
    ).pluck().get(noRelay.exchangeId), 0);
  });

  test("套餐成本估算入账冻结：plan 通道写 plan_estimated_* 冻结列，payg 通道为 none", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/plan-estimate.jsonl");
    await writeFile(join(fixture.dataDir, "proxy-config.json"), JSON.stringify({
      version: 3,
      revision: 1,
      updatedAt: "2026-08-20T00:00:00.000Z",
      localProxyBaseUrl: "http://localhost:3211",
      agentConnections: {},
      targets: [{
        id: "target-processor",
        name: "plan fixture",
        enabled: true,
        supportedModels: [],
        openaiUrl: "https://api.kimi.com/coding/v1",
        billingChannel: "plan",
        vendorFamily: "kimi",
        pricing: {planMonthlyFee: 10, settlementCurrency: "USD"},
      }],
    }));
    /* 套餐额度快照：monthly 5000 积分。fixture 价格配置无 fx → 回退 DEFAULT_USD_CNY_RATE。 */
    fixture.db.prepare(`INSERT INTO plan_quota_snapshots(
      target_id, provider_type, window_label, used, total, remaining, unit, captured_at
    ) VALUES ('target-processor', 'zhipu', 'monthly', 100, 5000, NULL, 'credits', '2026-08-20T00:00:00.000Z')`).run();
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    await processor.processExchangeRecord(processInput(source, 0, makeProcessorExchange({
      sequence: 60,
      threadId: "session-plan-est",
      nativeTurnId: "plan-est-turn",
      input: [{ role: "user", content: [{ type: "input_text", text: "plan request" }] }],
      output: [responseMessage("plan done")],
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        total_tokens: 110,
      },
    })));

    const planRow = fixture.db.prepare(
      `SELECT reference_cost_nano, plan_estimated_cost, plan_estimated_currency,
              plan_estimated_fx, plan_estimated_cost_nano, plan_estimated_status,
              plan_estimate_detail_json
       FROM usage_ledger WHERE exchange_id = 'capture-processor:ex-60'`,
    ).get() as {
      reference_cost_nano: number;
      plan_estimated_cost: number;
      plan_estimated_currency: string;
      plan_estimated_fx: number;
      plan_estimated_cost_nano: number;
      plan_estimated_status: string;
      plan_estimate_detail_json: string;
    };
    /* fixture 模型 $(100×1 + 10×2)/M = 0.00012 USD，目标无官方预设 → fxRateToCny=1，
       reference_cost_nano = 120_000。额度为 credits 刻度且无积分公式 → 量纲守卫
       （2026-09-29 一期）拦截市价回退：status=unavailable、无估算金额、依据入 detail。 */
    assert.equal(planRow.reference_cost_nano, 120_000);
    assert.equal(planRow.plan_estimated_status, "unavailable");
    assert.equal(planRow.plan_estimated_currency, "USD");
    assert.equal(planRow.plan_estimated_fx, 7);
    assert.equal(planRow.plan_estimated_cost_nano, null);
    assert.equal(planRow.plan_estimated_cost, null);
    const detail = JSON.parse(planRow.plan_estimate_detail_json);
    assert.deepEqual(detail, {
      monthlyFee: 10,
      consumed: 0.00012,
      consumedBasis: "market_blocked",
      quotaTotal: 5000,
      quotaUnit: "credits",
      windowDays: 30,
      windowLabel: "monthly",
    });
  });

  test("套餐月费缺 settlementCurrency 时按官方预设目录币种兜底（2026-09-28）", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/plan-estimate-preset.jsonl");
    /* 存量目标形态：presetId 指向 opencode-go（global=USD）但 settlementCurrency 缺失——
       修复前 $10 被当 ¥10 直存（nano 偏小约 fx 倍）；修复后按预设 USD 兜底并乘入账 fx。 */
    await writeFile(join(fixture.dataDir, "proxy-config.json"), JSON.stringify({
      version: 3,
      revision: 1,
      updatedAt: "2026-08-20T00:00:00.000Z",
      localProxyBaseUrl: "http://localhost:3211",
      agentConnections: {},
      targets: [{
        id: "target-processor",
        name: "plan preset fixture",
        enabled: true,
        supportedModels: [],
        openaiUrl: "https://opencode.ai/zen/go/v1",
        billingChannel: "plan",
        presetId: "opencode-go",
        vendorFamily: "opencode-go",
        pricing: {planMonthlyFee: 10},
      }],
    }));
    fixture.db.prepare(`INSERT INTO plan_quota_snapshots(
      target_id, provider_type, window_label, used, total, remaining, unit, captured_at
    ) VALUES ('target-processor', 'opencode-go', 'monthly', 10, 100, NULL, 'percent', '2026-08-20T00:00:00.000Z')`).run();
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    await processor.processExchangeRecord(processInput(source, 0, makeProcessorExchange({
      sequence: 60,
      threadId: "session-plan-preset",
      nativeTurnId: "plan-preset-turn",
      input: [{ role: "user", content: [{ type: "input_text", text: "plan request" }] }],
      output: [responseMessage("plan done")],
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        total_tokens: 110,
      },
    })));

    const planRow = fixture.db.prepare(
      `SELECT plan_estimated_currency, plan_estimated_fx, plan_estimated_cost_nano
       FROM usage_ledger WHERE exchange_id = 'capture-processor:ex-60'`,
    ).get() as {
      plan_estimated_currency: string;
      plan_estimated_fx: number;
      plan_estimated_cost_nano: number;
    };
    /* 预设兜底命中 USD：全球预设 fxRateToCny=7（默认 fx）——币种兜底语义保持验证。
       估算结局按 2026-09-30 新语义：opencode-go 美元常量特判已删除，percent 快照
       无额度语义、目标未选档位（pricing.planTier）→ market_blocked 诚实降级
       unavailable、无估算金额（分母由条目 market_share 规则 × 档位解析，见
       tests/provider-catalog-market-share.test.ts）。 */
    assert.equal(planRow.plan_estimated_currency, "USD");
    assert.equal(planRow.plan_estimated_fx, 7);
    assert.equal(planRow.plan_estimated_cost_nano, null);
  });

  test("CNY 区官方预设命中 USD 条目时按价格版本 fx 换算（2026-10-06 deepseek 事故修复）", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/payg-cny-preset-usd-entry.jsonl");
    /* 事故复现形态：目标绑定 deepseek（CNY 区官方预设，catalogKey=deepseek 不在旧
       GLOBAL_OFFICIAL_CATALOG_KEYS 四键内），模型命中价格中心 USD 条目（LiteLLM 兜底/
       手工美元条目）——修复前 fx 级联落到兜底 1，美元数字被 1:1 物化成人民币
       （actual_cost_cny = USD 数）；修复后任意官方预设按价格版本 fx 快照换算。 */
    await writeFile(join(fixture.dataDir, "proxy-config.json"), JSON.stringify({
      version: 3,
      revision: 1,
      updatedAt: "2026-08-20T00:00:00.000Z",
      localProxyBaseUrl: "http://localhost:3211",
      agentConnections: {},
      targets: [{
        id: "target-processor",
        name: "cny preset fixture",
        enabled: true,
        supportedModels: [],
        openaiUrl: "https://api.deepseek.com",
        billingChannel: "pay_as_you_go",
        presetId: "deepseek",
        vendorFamily: "deepseek",
      }],
    }));
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: {
        ...fixturePricingConfig(),
        fx: {asOf: "2026-09-30", rates: {"USD/CNY": 6.7351}, source: "fixture"},
      },
    });
    await processor.processExchangeRecord(processInput(source, 0, makeProcessorExchange({
      sequence: 61,
      threadId: "session-cny-preset-usd",
      nativeTurnId: "cny-preset-turn",
      input: [{ role: "user", content: [{ type: "input_text", text: "cny preset usd entry" }] }],
      output: [responseMessage("ok")],
      usage: {input_tokens: 100, output_tokens: 10, total_tokens: 110},
    })));
    const row = fixture.db.prepare(
      `SELECT currency, fx_rate_to_cny, actual_cost, actual_cost_cny
       FROM usage_ledger WHERE exchange_id = 'capture-processor:ex-61'`,
    ).get() as {currency: string; fx_rate_to_cny: number; actual_cost: number; actual_cost_cny: number};
    /* fixture 模型 $(100×1 + 10×2)/M = 0.00012 USD → ￥ = 0.00012 × 6.7351（修复前为 1:1）。 */
    assert.equal(row.currency, "USD");
    assert.equal(row.fx_rate_to_cny, 6.7351);
    assert.equal(row.actual_cost, 0.00012);
    assert.ok(Math.abs(row.actual_cost_cny - 0.00012 * 6.7351) < 1e-12);
  });

  test("market_share 辅助请求（标题生成）按目标档位解析估算分母，不再 market_blocked", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/aux-market-share.jsonl");
    /* opencode-go plan 通道 + 目标已选档位 go：真实事故形态（2026-09-30）——标题生成
       辅助请求曾因写入路径漏传 targetPlanTier，估算分母回退 percent 快照触发
       market_blocked（unavailable），把仪表盘/Token 价格页标成「部分估算」。 */
    await writeFile(join(fixture.dataDir, "proxy-config.json"), JSON.stringify({
      version: 3,
      revision: 1,
      updatedAt: "2026-08-20T00:00:00.000Z",
      localProxyBaseUrl: "http://localhost:3211",
      agentConnections: {},
      targets: [{
        id: "target-processor",
        name: "opencode go fixture",
        enabled: true,
        supportedModels: [],
        openaiUrl: "https://opencode.ai/zen/go/v1",
        billingChannel: "plan",
        presetId: "opencode-go",
        vendorFamily: "opencode-go",
        pricing: {planMonthlyFee: 10, planTier: "go"},
      }],
    }));
    /* OpenCode Go 上游只回报 percent 的额度快照：档位漏传时正是它顶替分母触发降级。 */
    fixture.db.prepare(`INSERT INTO plan_quota_snapshots(
      target_id, provider_type, window_label, used, total, remaining, unit, captured_at
    ) VALUES ('target-processor', 'opencode-go', 'monthly', 10, 100, NULL, 'percent', '2026-08-20T00:00:00.000Z')`).run();
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: {
        ...fixturePricingConfig(),
        models: [{
          id: "fixture-model",
          vendor: "FixtureVendor",
          patterns: ["fixture-model"],
          pricing: {
            input: 1,
            output: 2,
            cachedInput: 0.5,
            cacheWrite: 1.5,
          },
          confidence: "official",
          planCreditRules: {
            formula: "market_share",
            currency: "USD",
            unit: "USD",
            quotaWindows: [{id: "monthly", label: "月度", reset: "monthly"}],
            quotaTiers: {go: {monthlyFee: 10, quotaByWindow: {monthly: 60}}},
          },
        }],
      },
    });
    await processor.processExchangeRecord(processInput(source, 0, makeProcessorExchange({
      sequence: 61,
      threadId: "session-aux-market-share",
      routingAgent: "opencode",
      wireApi: "chat_completions",
      requestPath: "/v1/chat/completions",
      requestBody: JSON.stringify({
        model: "fixture-model",
        messages: [
          {role: "system", content: "You are a title generator. You output ONLY a thread title."},
          {role: "user", content: "Generate a title for this conversation:"},
        ],
      }),
      responseBody: chatResponseFixture("fixture title"),
    })));

    const auxRow = fixture.db.prepare(
      `SELECT plan_estimated_status, plan_estimated_cost_nano, plan_estimate_detail_json, request_kind
       FROM usage_ledger WHERE exchange_id = 'capture-processor:ex-61'`,
    ).get() as {
      plan_estimated_status: string;
      plan_estimated_cost_nano: number | null;
      plan_estimate_detail_json: string;
      request_kind: string;
    };
    assert.equal(auxRow.request_kind, "auxiliary");
    /* 分母走条目 quotaTiers × 档位（60 USD × 默认 fx 7 = 420 CNY），不再被 percent 快照
       顶替：估算 = 70 CNY 月费 × (0.00014 ÷ 420) × 30/30 = 23333 nano。 */
    assert.equal(auxRow.plan_estimated_status, "estimated");
    assert.equal(auxRow.plan_estimated_cost_nano, 23333);
    const detail = JSON.parse(auxRow.plan_estimate_detail_json);
    assert.equal(detail.consumedBasis, "market_cny");
    assert.equal(detail.quotaTotal, 420);
    assert.equal(detail.modelId, "fixture-model");
    assert.equal(detail.planTier, "go");
    assert.equal(detail.monthlyLimitUsd, 60);
    assert.equal(
      fixture.db.prepare(
        `SELECT kind FROM auxiliary_requests WHERE exchange_id = 'capture-processor:ex-61'`,
      ).pluck().get(),
      "title_generation",
    );
  });

  test("只把实际 tool_use 计为调用并持久化四类 Token、倍率成本与结果状态", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/tool-usage.jsonl");
    await writeFile(join(fixture.dataDir, "proxy-config.json"), JSON.stringify({
      version: 3,
      revision: 1,
      updatedAt: "2026-08-20T00:00:00.000Z",
      localProxyBaseUrl: "http://localhost:3211",
      agentConnections: {},
      targets: [{
        id: "target-processor",
        name: "processor fixture",
        enabled: true,
        supportedModels: [],
        openaiUrl: "https://api.kimi.com/coding/v1",
        billingChannel: "plan",
        vendorFamily: "kimi",
      }],
    }));
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const schemaOnly = await processor.processExchangeRecord(processInput(source, 0, makeProcessorExchange({
      sequence: 40,
      threadId: "session-interleaved",
      nativeTurnId: "tool-turn",
      input: [{ role: "user", content: [{ type: "input_text", text: "schema only" }] }],
      output: [responseMessage("no tool")],
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        output_tokens: 10,
        reasoning_tokens: 7,
        total_tokens: 135,
      },
    })));
    const toolUse = await processor.processExchangeRecord(processInput(source, 100, makeProcessorExchange({
      sequence: 41,
      threadId: "session-interleaved",
      nativeTurnId: "tool-turn",
      input: [{ role: "user", content: [{ type: "input_text", text: "use tools" }] }],
      output: [
        { type: "function_call", call_id: "call-read", name: "Read", arguments: "{}" },
        { type: "function_call", call_id: "call-write", name: "Write", arguments: "{}" },
      ],
    })));
    await processor.processExchangeRecord(processInput(source, 200, makeProcessorExchange({
      sequence: 42,
      threadId: "session-interleaved",
      nativeTurnId: "tool-turn",
      input: [
        { type: "function_call_output", call_id: "call-read", output: "read ok" },
        { type: "function_call_output", call_id: "call-write", output: "write ok" },
      ],
      output: [responseMessage("tools done")],
    })));

    assert.ok(schemaOnly.stepId);
    assert.ok(toolUse.turnId);
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT tool_schema_count FROM agent_steps WHERE id = ?`,
      ).get(schemaOnly.stepId),
      { tool_schema_count: 1 },
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT tool_use_id, tool_name, status
         FROM tool_calls ORDER BY tool_name`,
      ).all(),
      [
        { tool_use_id: "call-read", tool_name: "Read", status: "completed" },
        { tool_use_id: "call-write", tool_name: "Write", status: "completed" },
      ],
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT model, vendor, billing_channel, vendor_family, rate_multiplier,
          input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
          reasoning_tokens, total_tokens, currency, vendor_cost, actual_cost,
          usage_source, usage_confidence
         FROM usage_ledger WHERE exchange_id = 'capture-processor:ex-40'`,
      ).get(),
      {
        model: "fixture-model",
        vendor: "FixtureVendor",
        billing_channel: "plan",
        vendor_family: "kimi",
        rate_multiplier: 1,
        input_tokens: 100,
        cache_read_tokens: 20,
        cache_write_tokens: 5,
        output_tokens: 10,
        reasoning_tokens: 7,
        total_tokens: 135,
        currency: "USD",
        vendor_cost: 0.0001375,
        actual_cost: 0.0001375,
        usage_source: "provider_usage",
        usage_confidence: "exact",
      },
    );
    const pricingSnapshot = JSON.parse(fixture.db.prepare(
      `SELECT pricing_snapshot_json FROM usage_ledger
       WHERE exchange_id = 'capture-processor:ex-40'`,
    ).pluck().get() as string) as Record<string, unknown>;
    assert.equal(pricingSnapshot.matchedModel, "fixture-model");
    assert.equal(pricingSnapshot.rateMultiplier, 1);
    assert.equal(pricingSnapshot.priced, true);
    assert.deepEqual(scopeAggregate(fixture, "turn", toolUse.turnId), {
      step_request_count: 3,
      auxiliary_request_count: 0,
      tool_call_count: 2,
    });
  });

  test("v19 派生写入 wire_api 与 Step 身份证据，dsh 按有界指纹差分切分 Turn", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/agent-evidence.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const chatRequest = (messages: unknown[]) => JSON.stringify({
      model: "fixture-model",
      messages,
    });
    const chatResponse = (text: string) => JSON.stringify({
      id: `chat-${text}`,
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });

    const opencode = await processor.processExchangeRecord(processInput(
      source,
      0,
      makeProcessorExchange({
        sequence: 80,
        threadId: "opencode-thread",
        routingAgent: "opencode",
        wireApi: "responses",
        headers: {
          "user-agent": "opencode/0.1",
          "x-opencode-session": "ses_1",
          "x-opencode-request": "msg_1",
        },
        input: [{ role: "user", content: [{ type: "input_text", text: "你好" }] }],
        output: [responseMessage("好的")],
      }),
    ));
    assert.ok(opencode.threadId);
    assert.equal(
      fixture.db.prepare(
        "SELECT wire_api FROM raw_exchange_refs WHERE exchange_id = ?",
      ).pluck().get(opencode.exchangeId),
      "responses",
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT native_step_id, identity_source, identity_confidence
         FROM agent_steps WHERE exchange_id = ?`,
      ).get(opencode.exchangeId),
      {
        native_step_id: null,
        identity_source: "native-header",
        identity_confidence: "exact",
      },
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT native_turn_id FROM agent_turns WHERE id = ?`,
      ).pluck().get(opencode.turnId),
      "msg_1",
    );

    const dshSessionHeaders = {
      "user-agent": "deepseek-harness/0.1",
      "x-deepseek-harness-session-id": "dsh-session-1",
    };
    const dsh1Ex = makeProcessorExchange({
      sequence: 81,
      threadId: "dsh-thread",
      routingAgent: "dsh",
      wireApi: "chat_completions",
      requestPath: "/v1/chat/completions",
      headers: dshSessionHeaders,
      input: [],
      output: [],
      requestBody: chatRequest([{ role: "user", content: "你好" }]),
      responseBody: chatResponse("好的"),
    });
    seedIngestionRecord(fixture, source, 100, dsh1Ex);
    const dsh1 = await processor.processExchangeRecord(processInput(source, 100, dsh1Ex));
    const dsh2Ex = makeProcessorExchange({
      sequence: 82,
      threadId: "dsh-thread",
      routingAgent: "dsh",
      wireApi: "chat_completions",
      requestPath: "/v1/chat/completions",
      headers: dshSessionHeaders,
      input: [],
      output: [],
      requestBody: chatRequest([{ role: "user", content: "你好" }]),
      responseBody: chatResponse("好的"),
    });
    seedIngestionRecord(fixture, source, 200, dsh2Ex);
    const dsh2 = await processor.processExchangeRecord(processInput(source, 200, dsh2Ex));
    const dsh3Ex = makeProcessorExchange({
      sequence: 83,
      threadId: "dsh-thread",
      routingAgent: "dsh",
      wireApi: "chat_completions",
      requestPath: "/v1/chat/completions",
      headers: dshSessionHeaders,
      input: [],
      output: [],
      requestBody: chatRequest([
        { role: "user", content: "你好" },
        { role: "assistant", content: "好的" },
      ]),
      responseBody: chatResponse("请继续说"),
    });
    seedIngestionRecord(fixture, source, 300, dsh3Ex);
    const dsh3 = await processor.processExchangeRecord(processInput(source, 300, dsh3Ex));
    const dsh4Ex = makeProcessorExchange({
      sequence: 84,
      threadId: "dsh-thread",
      routingAgent: "dsh",
      wireApi: "chat_completions",
      requestPath: "/v1/chat/completions",
      headers: dshSessionHeaders,
      input: [],
      output: [],
      requestBody: chatRequest([
        { role: "user", content: "你好" },
        { role: "assistant", content: "好的" },
        { role: "user", content: "新问题" },
      ]),
      responseBody: chatResponse("继续"),
    });
    seedIngestionRecord(fixture, source, 400, dsh4Ex);
    const dsh4 = await processor.processExchangeRecord(processInput(source, 400, dsh4Ex));
    assert.ok(dsh1.threadId);
    assert.equal(dsh2.threadId, dsh1.threadId);
    assert.equal(dsh3.threadId, dsh1.threadId);
    assert.equal(dsh4.threadId, dsh1.threadId);
    const threadId = dsh1.threadId;
    for (const exchangeId of [
      dsh1.exchangeId,
      dsh2.exchangeId,
      dsh3.exchangeId,
      dsh4.exchangeId,
    ]) {
      assert.equal(
        fixture.db.prepare(
          "SELECT wire_api FROM raw_exchange_refs WHERE exchange_id = ?",
        ).pluck().get(exchangeId),
        "chat_completions",
      );
    }
    const evidenceFor = (exchangeId: string) => fixture.db.prepare(
      `SELECT native_step_id, identity_source, identity_confidence,
        request_action
       FROM agent_steps WHERE exchange_id = ?`,
    ).get(exchangeId) as {
      native_step_id: string | null;
      identity_source: string;
      identity_confidence: string;
      request_action: string;
    };
    assert.deepEqual(evidenceFor(dsh1.exchangeId), {
      native_step_id: null,
      identity_source: "structural",
      identity_confidence: "exact",
      request_action: "user_prompt",
    });
    // dsh2 = dsh1 的字面重发（请求体 SHA 一致）：标 retry_like 并沿用当前 Turn。
    assert.deepEqual(evidenceFor(dsh2.exchangeId), {
      native_step_id: null,
      identity_source: "structural",
      identity_confidence: "high",
      request_action: "retry_like",
    });
    assert.deepEqual(evidenceFor(dsh3.exchangeId), {
      native_step_id: null,
      identity_source: "structural",
      identity_confidence: "medium",
      request_action: "conversation_continue",
    });
    assert.deepEqual(evidenceFor(dsh4.exchangeId), {
      native_step_id: null,
      identity_source: "structural",
      identity_confidence: "high",
      request_action: "user_prompt",
    });
    assert.equal(
      fixture.db.prepare(
        "SELECT COUNT(*) FROM agent_turns WHERE agent_thread_id = ?",
      ).pluck().get(threadId),
      2,
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT step_count FROM agent_turns
         WHERE agent_thread_id = ? AND status = 'open'`,
      ).pluck().get(threadId),
      1,
    );

    fixture.db.prepare(
      `UPDATE exchange_content_filter_status SET request_filter_state = 'limited'
       WHERE exchange_id = ?`,
    ).run(dsh4.exchangeId);
    const dsh5 = await processor.processExchangeRecord(processInput(
      source,
      500,
      makeProcessorExchange({
        sequence: 85,
        threadId: "dsh-thread",
        routingAgent: "dsh",
        wireApi: "chat_completions",
        requestPath: "/v1/chat/completions",
        headers: dshSessionHeaders,
        input: [],
        output: [],
        requestBody: chatRequest([
          { role: "user", content: "你好" },
          { role: "assistant", content: "好的" },
          { role: "user", content: "新问题" },
          { role: "user", content: "无法确认的追问" },
        ]),
        responseBody: chatResponse("降级"),
      }),
    ));
    assert.deepEqual(evidenceFor(dsh5.exchangeId), {
      native_step_id: null,
      identity_source: "structural",
      identity_confidence: "low",
      request_action: "conversation_continue",
    });
    assert.equal(
      fixture.db.prepare(
        "SELECT COUNT(*) FROM agent_turns WHERE agent_thread_id = ?",
      ).pluck().get(threadId),
      2,
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) FROM derivation_diagnostics
         WHERE exchange_id = ? AND code = 'dsh_turn_unconfirmed'`,
      ).pluck().get(dsh5.exchangeId),
      1,
    );
  });

  test("v22 dsh Web 标题生成请求归类为 title_generation 辅助请求，不产生 Step/Turn", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/dsh-title.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const dshFallbackHeaders = {"user-agent": "deepseek-harness/0.1"};
    const chatResponse = (text: string) => JSON.stringify({
      id: `chat-${text}`,
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    // 标题生成请求（真实 dsh Web 签名）：无任何会话身份头，随首条用户消息并行发出。
    const title = await processor.processExchangeRecord(processInput(
      source,
      0,
      makeProcessorExchange({
        sequence: 1,
        threadId: "dsh-title-thread",
        routingAgent: "dsh",
        wireApi: "chat_completions",
        requestPath: "/v1/chat/completions",
        headers: dshFallbackHeaders,
        input: [],
        output: [],
        requestBody: JSON.stringify({
          model: "fixture-model",
          messages: [
            {
              role: "system",
              content: "Create a concise title for an AI coding-assistant session from the supplied human messages.\nReturn only the title on one line.",
            },
            {
              role: "user",
              content: 'Generate the session title from this JSON array of human messages:\n[{"seq":1,"text":"帮我分析问题"}]',
            },
          ],
          stream: true,
          max_tokens: 64,
        }),
        responseBody: chatResponse("问题分析"),
      }),
    ));
    assert.ok(title.exchangeId);
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT agent_session_id, agent_thread_id, agent_turn_id, kind
         FROM auxiliary_requests WHERE exchange_id = ?`,
      ).get(title.exchangeId),
      { agent_session_id: null, agent_thread_id: null, agent_turn_id: null, kind: "title_generation" },
    );
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM agent_steps").pluck().get(),
      0,
    );
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM agent_turns").pluck().get(),
      0,
    );
    assert.equal(
      fixture.db.prepare(
        "SELECT request_kind FROM usage_ledger WHERE exchange_id = ?",
      ).pluck().get(title.exchangeId),
      "auxiliary",
    );

    // 主任务请求随后到达：同一捕获批次回退身份下应开启唯一的 Turn。
    const main = await processor.processExchangeRecord(processInput(
      source,
      100,
      makeProcessorExchange({
        sequence: 2,
        threadId: "dsh-title-thread",
        routingAgent: "dsh",
        wireApi: "chat_completions",
        requestPath: "/v1/chat/completions",
        headers: dshFallbackHeaders,
        input: [],
        output: [],
        requestBody: JSON.stringify({
          model: "fixture-model",
          messages: [{ role: "user", content: "帮我分析问题" }],
        }),
        responseBody: chatResponse("分析结论"),
      }),
    ));
    assert.ok(main.stepId);
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM agent_turns").pluck().get(),
      1,
    );
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM agent_steps").pluck().get(),
      1,
    );
  });

  test("v22 dsh 跨捕获批次续接拼接：代理重启后的同会话请求并入既有 Session/Thread", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/dsh-stitch.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const dshFallbackHeaders = {"user-agent": "deepseek-harness/0.1"};
    const chatResponse = (text: string) => JSON.stringify({
      id: `chat-${text}`,
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    const system = { role: "system", content: "You are an AI agent." };
    const dsh = (options: {
      sequence: number;
      captureSessionId: string;
      byteOffset: number;
      messages: unknown[];
    }) => processor.processExchangeRecord(processInput(
      source,
      options.byteOffset,
      makeProcessorExchange({
        sequence: options.sequence,
        threadId: "unused",
        routingAgent: "dsh",
        wireApi: "chat_completions",
        requestPath: "/v1/chat/completions",
        headers: dshFallbackHeaders,
        input: [],
        output: [],
        requestBody: JSON.stringify({ model: "fixture-model", messages: options.messages }),
        responseBody: chatResponse(`回复${options.sequence}`),
        captureSessionId: options.captureSessionId,
      }),
    ));

    // 捕获批次 A：同一会话前两步（system + user + tool_result，历史足够丰富）。
    const a1 = await dsh({
      sequence: 1, captureSessionId: "capture-a", byteOffset: 0,
      messages: [system, { role: "user", content: "帮我分析问题" }],
    });
    const a2 = await dsh({
      sequence: 2, captureSessionId: "capture-a", byteOffset: 100,
      messages: [
        system,
        { role: "user", content: "帮我分析问题" },
        { role: "assistant", content: "初步结论" },
        { role: "tool", content: "工具结果一" },
      ],
    });
    // 捕获批次 B（模拟代理重启）：完整携带批次 A 历史 + 新 tool_result。
    const b1 = await dsh({
      sequence: 3, captureSessionId: "capture-b", byteOffset: 200,
      messages: [
        system,
        { role: "user", content: "帮我分析问题" },
        { role: "assistant", content: "初步结论" },
        { role: "tool", content: "工具结果一" },
        { role: "assistant", content: "补充推论" },
        { role: "tool", content: "工具结果二" },
      ],
    });
    assert.equal(b1.sessionId, a1.sessionId);
    assert.equal(b1.threadId, a1.threadId);
    // 无新增 user 消息 → 续接既有 Turn，而不是开新 Turn。
    assert.equal(b1.turnId, a2.turnId);
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM agent_sessions").pluck().get(),
      1,
    );
    assert.equal(
      fixture.db.prepare(
        "SELECT COUNT(*) FROM derivation_diagnostics WHERE code = 'dsh-session-stitched'",
      ).pluck().get(),
      1,
    );

    // 捕获批次 C：携带新 user 消息 → 仍并入同会话，但开启新 Turn。
    const c1 = await dsh({
      sequence: 4, captureSessionId: "capture-c", byteOffset: 300,
      messages: [
        system,
        { role: "user", content: "帮我分析问题" },
        { role: "assistant", content: "初步结论" },
        { role: "tool", content: "工具结果一" },
        { role: "assistant", content: "补充推论" },
        { role: "tool", content: "工具结果二" },
        { role: "user", content: "换个角度再看" },
      ],
    });
    assert.equal(c1.sessionId, a1.sessionId);
    assert.notEqual(c1.turnId, a2.turnId);
    assert.equal(
      fixture.db.prepare(
        "SELECT COUNT(*) FROM agent_turns WHERE agent_thread_id = ?",
      ).pluck().get(a1.threadId),
      2,
    );

    // 捕获批次 D：全新会话（缺少既有会话的 tool_result/user 指纹）→ 不拼接。
    const d1 = await dsh({
      sequence: 5, captureSessionId: "capture-d", byteOffset: 400,
      messages: [system, { role: "user", content: "另一个无关会话" }],
    });
    assert.notEqual(d1.sessionId, a1.sessionId);
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM agent_sessions").pluck().get(),
      2,
    );
    // 批次 C 也命中拼接，共两次诊断；无关会话不计。
    assert.equal(
      fixture.db.prepare(
        "SELECT COUNT(*) FROM derivation_diagnostics WHERE code = 'dsh-session-stitched'",
      ).pluck().get(),
      2,
    );

    // 捕获批次 E：压缩/裁剪导致旧 tool_result 指纹缺失 → set 包含失败，不拼接。
    const e1 = await dsh({
      sequence: 6, captureSessionId: "capture-e", byteOffset: 500,
      messages: [
        system,
        { role: "user", content: "帮我分析问题" },
        { role: "assistant", content: "历史摘要" },
        { role: "tool", content: "工具结果二" },
      ],
    });
    assert.notEqual(e1.sessionId, a1.sessionId);

    // 捕获批次 F：与批次 D 相隔超过拼接时间窗（30 分钟）→ 不拼接。
    // （批次 D 末次请求 sequence=5；这里 sequence=2005 即 2000 秒后。）
    const f1 = await dsh({
      sequence: 2005, captureSessionId: "capture-f", byteOffset: 600,
      messages: [
        system,
        { role: "user", content: "另一个无关会话" },
        { role: "assistant", content: "答复" },
        { role: "tool", content: "另一工具结果" },
      ],
    });
    assert.notEqual(f1.sessionId, d1.sessionId);
  });

  test("v22 dsh 续接拼接保守回退：上一请求历史过短（<3 指纹）时不拼接", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/dsh-stitch-short.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const dshFallbackHeaders = {"user-agent": "deepseek-harness/0.1"};
    const chatResponse = (text: string) => JSON.stringify({
      id: `chat-${text}`,
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    const dsh = (options: {
      sequence: number;
      captureSessionId: string;
      byteOffset: number;
      messages: unknown[];
    }) => processor.processExchangeRecord(processInput(
      source,
      options.byteOffset,
      makeProcessorExchange({
        sequence: options.sequence,
        threadId: "unused",
        routingAgent: "dsh",
        wireApi: "chat_completions",
        requestPath: "/v1/chat/completions",
        headers: dshFallbackHeaders,
        input: [],
        output: [],
        requestBody: JSON.stringify({ model: "fixture-model", messages: options.messages }),
        responseBody: chatResponse(`回复${options.sequence}`),
        captureSessionId: options.captureSessionId,
      }),
    ));
    // 批次 A 只有 system + user（2 个指纹）：即使批次 B 逐字重放同一提问
    // （用户在新会话重打同一句话的最坏情形），也不允许拼接。
    await dsh({
      sequence: 1, captureSessionId: "capture-short-a", byteOffset: 0,
      messages: [
        { role: "system", content: "You are an AI agent." },
        { role: "user", content: "帮我分析问题" },
      ],
    });
    const b1 = await dsh({
      sequence: 2, captureSessionId: "capture-short-b", byteOffset: 100,
      messages: [
        { role: "system", content: "You are an AI agent." },
        { role: "user", content: "帮我分析问题" },
      ],
    });
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM agent_sessions").pluck().get(),
      2,
    );
    assert.equal(
      fixture.db.prepare(
        "SELECT COUNT(*) FROM derivation_diagnostics WHERE code = 'dsh-session-stitched'",
      ).pluck().get(),
      0,
    );
    assert.notEqual(b1.sessionId, "");
  });

  test("v21 zcode 按有界指纹差分切分 Turn：真实输入开新轮，system-reminder 注入不开", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/zcode-turns.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const anthropicRequest = (messages: unknown[]) => JSON.stringify({
      model: "fixture-model",
      system: "you are a coding agent",
      messages,
    });
    const anthropicResponse = (text: string) => JSON.stringify({
      id: `msg_${text}`,
      type: "message",
      role: "assistant",
      model: "fixture-model",
      content: [{type: "text", text}],
      stop_reason: "end_turn",
      usage: {input_tokens: 10, output_tokens: 4},
    });
    const zcodeHeaders = {
      "user-agent": "zcode/1.0",
      "x-zcode-trace-id": "trace-zcode-1",
      "x-zcode-session-type": "main",
      "x-session-id": "zses-main-1",
    };

    // z1：首条真实用户输入。
    const z1 = await processor.processExchangeRecord(processInput(
      source,
      0,
      makeProcessorExchange({
        sequence: 60,
        threadId: "zcode-thread",
        routingAgent: "zcode",
        wireApi: "messages",
        requestPath: "/v1/messages",
        headers: zcodeHeaders,
        input: [],
        output: [],
        requestBody: anthropicRequest([
          {role: "user", content: [{type: "text", text: "第一条真实输入"}]},
        ]),
        responseBody: anthropicResponse("好的"),
      }),
    ));
    // z2：完整回放 + tool_result（anthropic 把工具结果包在 user 消息里）。
    const z2 = await processor.processExchangeRecord(processInput(
      source,
      100,
      makeProcessorExchange({
        sequence: 61,
        threadId: "zcode-thread",
        routingAgent: "zcode",
        wireApi: "messages",
        requestPath: "/v1/messages",
        headers: zcodeHeaders,
        input: [],
        output: [],
        requestBody: anthropicRequest([
          {role: "user", content: [{type: "text", text: "第一条真实输入"}]},
          {role: "assistant", content: [{type: "tool_use", id: "t1", name: "Bash", input: {}}]},
          {role: "user", content: [{type: "tool_result", tool_use_id: "t1", content: "ok"}]},
        ]),
        responseBody: anthropicResponse("继续"),
      }),
    ));
    // z3：再出现一条新的真实用户输入 → 必须开新 Turn。
    const z3 = await processor.processExchangeRecord(processInput(
      source,
      200,
      makeProcessorExchange({
        sequence: 62,
        threadId: "zcode-thread",
        routingAgent: "zcode",
        wireApi: "messages",
        requestPath: "/v1/messages",
        headers: zcodeHeaders,
        input: [],
        output: [],
        requestBody: anthropicRequest([
          {role: "user", content: [{type: "text", text: "第一条真实输入"}]},
          {role: "assistant", content: [{type: "tool_use", id: "t1", name: "Bash", input: {}}]},
          {role: "user", content: [{type: "tool_result", tool_use_id: "t1", content: "ok"}]},
          {role: "assistant", content: [{type: "text", text: "继续"}]},
          {role: "user", content: [{type: "text", text: "第二条真实输入"}]},
        ]),
        responseBody: anthropicResponse("收到"),
      }),
    ));
    // z4：仅新增 system-reminder 注入信封 → 不开新 Turn。
    const z4 = await processor.processExchangeRecord(processInput(
      source,
      300,
      makeProcessorExchange({
        sequence: 63,
        threadId: "zcode-thread",
        routingAgent: "zcode",
        wireApi: "messages",
        requestPath: "/v1/messages",
        headers: zcodeHeaders,
        input: [],
        output: [],
        requestBody: anthropicRequest([
          {role: "user", content: [{type: "text", text: "第一条真实输入"}]},
          {role: "assistant", content: [{type: "tool_use", id: "t1", name: "Bash", input: {}}]},
          {role: "user", content: [{type: "tool_result", tool_use_id: "t1", content: "ok"}]},
          {role: "assistant", content: [{type: "text", text: "继续"}]},
          {role: "user", content: [{type: "text", text: "第二条真实输入"}]},
          {role: "assistant", content: [{type: "text", text: "收到"}]},
          {role: "user", content: [{type: "text", text: "<system-reminder> The TodoWrite tool hasn't been used recently"}]},
        ]),
        responseBody: anthropicResponse("完成"),
      }),
    ));

    assert.ok(z1.threadId);
    assert.equal(z2.threadId, z1.threadId);
    assert.equal(z3.threadId, z1.threadId);
    assert.equal(z4.threadId, z1.threadId);
    const actionOf = (exchangeId: string) => fixture.db.prepare(
      "SELECT request_action FROM agent_steps WHERE exchange_id = ?",
    ).pluck().get(exchangeId);
    assert.equal(actionOf(z1.exchangeId), "user_prompt");
    // z2 新增项恰为工具结果 → tool_result（2026-09-17 词表扩展：续接工具结果语义恢复）。
    assert.equal(actionOf(z2.exchangeId), "tool_result");
    assert.equal(actionOf(z3.exchangeId), "user_prompt");
    assert.equal(actionOf(z4.exchangeId), "conversation_continue");
    // 真实新输入切开两个 Turn；注入信封的 z4 沿用 z3 的 Turn。
    const turnOf = (exchangeId: string) => fixture.db.prepare(
      "SELECT agent_turn_id FROM agent_steps WHERE exchange_id = ?",
    ).pluck().get(exchangeId);
    assert.notEqual(turnOf(z3.exchangeId), turnOf(z1.exchangeId));
    assert.equal(turnOf(z4.exchangeId), turnOf(z3.exchangeId));
    assert.equal(
      fixture.db.prepare(
        "SELECT COUNT(*) FROM agent_turns WHERE agent_thread_id = ?",
      ).pluck().get(z1.threadId),
      2,
    );
    // 注入信封在指纹层被标为 user_injected 而不是 user_real。
    const injected = fixture.db.prepare(
      `SELECT COUNT(*) FROM exchange_request_fingerprints
       WHERE exchange_id = ? AND body_side = 'request' AND category = 'user_injected'`,
    ).pluck().get(z4.exchangeId);
    assert.equal(injected, 1);
  });

  test("同一响应重复 provider tool_use_id 时按调用 occurrence 持久化", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/duplicate-tool-use-id.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
    });

    const result = await processor.processExchangeRecord(processInput(
      source,
      0,
      makeProcessorExchange({
        sequence: 43,
        threadId: "session-interleaved",
        nativeTurnId: "duplicate-tool-id-turn",
        input: [{ role: "user", content: [{ type: "input_text", text: "run twice" }] }],
        output: [
          { type: "function_call", call_id: "call-duplicate", name: "exec_command", arguments: "{}" },
          { type: "function_call", call_id: "call-duplicate", name: "exec_command", arguments: "{}" },
        ],
      }),
    ));

    assert.ok(result.stepId);
    const calls = fixture.db.prepare(
      `SELECT id, tool_use_id, tool_name
       FROM tool_calls WHERE agent_step_id = ? ORDER BY rowid`,
    ).all(result.stepId) as Array<{
      id: string;
      tool_use_id: string;
      tool_name: string;
    }>;
    assert.equal(calls.length, 2);
    assert.equal(new Set(calls.map(call => call.id)).size, 2);
    assert.deepEqual(calls.map(call => ({
      tool_use_id: call.tool_use_id,
      tool_name: call.tool_name,
    })), [
      { tool_use_id: "call-duplicate", tool_name: "exec_command" },
      { tool_use_id: "call-duplicate", tool_name: "exec_command" },
    ]);
  });

  test("provider usage 缺失与 pricing 未命中时仍写可审计 ledger", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/unpriced.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });

    const result = await processor.processExchangeRecord(processInput(source, 0, makeProcessorExchange({
      sequence: 50,
      threadId: "session-interleaved",
      nativeTurnId: "unpriced-turn",
      model: "mystery-unpriced",
      input: [{ role: "user", content: [{ type: "input_text", text: "estimate these tokens" }] }],
      output: [responseMessage("estimated response tokens")],
      usage: null,
    })));

    assert.ok(result.stepId);
    const ledger = fixture.db.prepare(
      `SELECT model, vendor, input_tokens, output_tokens, vendor_cost,
        actual_cost, usage_source, usage_confidence, pricing_snapshot_json
       FROM usage_ledger WHERE exchange_id = 'capture-processor:ex-50'`,
    ).get() as {
      model: string;
      vendor: string;
      input_tokens: number;
      output_tokens: number;
      vendor_cost: number;
      actual_cost: number;
      usage_source: string;
      usage_confidence: string;
      pricing_snapshot_json: string;
    };
    assert.equal(ledger.model, "mystery-unpriced");
    assert.equal(ledger.vendor, "unknown");
    assert.ok(ledger.input_tokens > 0);
    assert.ok(ledger.output_tokens > 0);
    assert.equal(ledger.vendor_cost, 0);
    assert.equal(ledger.actual_cost, 0);
    assert.equal(ledger.usage_source, "tokenizer_estimated");
    assert.equal(ledger.usage_confidence, "medium");
    assert.deepEqual(JSON.parse(ledger.pricing_snapshot_json), {
      unit: "per_million_tokens",
      matchStrategy: "unmatched",
      rateMultiplier: 1,
      priced: false,
      unpricedReason: "model_unmatched",
      currency: "USD",
      fxRateToCny: 1,
    });
  });

  test("params fingerprint 不通过 JSON.stringify 复制敏感参数", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(
      fixture,
      "captures/v2/params-fingerprint-sensitive.jsonl",
    );
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const sensitiveMarker = "__PARAMS_FINGERPRINT_SECRET_39e1d7__";
    const exchange = makeProcessorExchange({
      sequence: 59,
      threadId: "session-interleaved",
      nativeTurnId: "sensitive-fingerprint-turn",
      input: [{ role: "user", content: [{ type: "input_text", text: "hash params" }] }],
      output: [responseMessage("params hashed")],
      params: {
        prompt: `${sensitiveMarker}:prompt`,
        metadata: { nested: `${sensitiveMarker}:nested` },
      },
    });
    const stringifyGuard = installSensitiveJsonStringifyGuard(sensitiveMarker);

    try {
      const hydrated = await hydrateRawCapturedExchange(fixture.dataDir, exchange);
      const normalized = normalizeExchange(hydrated);
      const fingerprint = normalized.harnessPayload.paramsFingerprint;
      assert.ok(fingerprint);
      assert.equal(fingerprint.complete, true);

      const result = await processor.processExchangeRecord(processInput(source, 0, exchange));
      assert.ok(result.stepId);
    } finally {
      stringifyGuard.restore();
    }

    assert.equal(stringifyGuard.blockedCallCount, 0);
  });

  test("params fingerprint 与 conversation 和 tools 变化解耦", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(
      fixture,
      "captures/v2/params-fingerprint-context-independent.jsonl",
    );
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const first = await processor.processExchangeRecord(processInput(
      source,
      0,
      makeProcessorExchange({
        sequence: 60,
        threadId: "session-interleaved",
        nativeTurnId: "stable-params-turn",
        input: [{ role: "user", content: [{ type: "input_text", text: "first context" }] }],
        tools: [{ type: "function", name: "first_tool", parameters: { type: "object" } }],
        output: [responseMessage("first response")],
      }),
    ));
    const second = await processor.processExchangeRecord(processInput(
      source,
      100,
      makeProcessorExchange({
        sequence: 61,
        threadId: "session-interleaved",
        nativeTurnId: "stable-params-turn",
        input: [{ role: "user", content: [{ type: "input_text", text: "second context" }] }],
        tools: [{ type: "function", name: "second_tool", parameters: { type: "string" } }],
        output: [responseMessage("second response")],
      }),
    ));

    assert.ok(first.stepId);
    assert.ok(second.stepId);
    const firstContext = readStoredContext(fixture, first.stepId);
    const secondContext = readStoredContext(fixture, second.stepId);
    const secondDiff = readStoredDiff(fixture, second.stepId);

    assert.equal(firstContext.snapshot.paramsHash, secondContext.snapshot.paramsHash);
    assert.deepEqual(secondDiff.changedParams, []);
  });

  test("params fingerprint 精确识别标量与嵌套参数变化", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(
      fixture,
      "captures/v2/params-fingerprint-value-changes.jsonl",
    );
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const exchanges = [
      makeProcessorExchange({
        sequence: 62,
        threadId: "session-interleaved",
        nativeTurnId: "changed-params-turn",
        input: [{ role: "user", content: [{ type: "input_text", text: "same context" }] }],
        output: [responseMessage("same response")],
        params: { temperature: 0.2, metadata: { mode: "alpha" } },
      }),
      makeProcessorExchange({
        sequence: 63,
        threadId: "session-interleaved",
        nativeTurnId: "changed-params-turn",
        input: [{ role: "user", content: [{ type: "input_text", text: "same context" }] }],
        output: [responseMessage("same response")],
        params: { temperature: 0.3, metadata: { mode: "alpha" } },
      }),
      makeProcessorExchange({
        sequence: 64,
        threadId: "session-interleaved",
        nativeTurnId: "changed-params-turn",
        input: [{ role: "user", content: [{ type: "input_text", text: "same context" }] }],
        output: [responseMessage("same response")],
        params: { temperature: 0.3, metadata: { mode: "beta" } },
      }),
    ];
    const expectedFingerprints: Array<string | undefined> = [];
    const results = [];
    for (const [index, exchange] of exchanges.entries()) {
      const normalized = normalizeExchange(
        await hydrateRawCapturedExchange(fixture.dataDir, exchange),
      );
      expectedFingerprints.push(normalized.harnessPayload.paramsFingerprint?.stableHash);
      results.push(await processor.processExchangeRecord(processInput(
        source,
        index * 100,
        exchange,
      )));
    }

    assert.ok(expectedFingerprints.every(value => typeof value === "string"));
    const hashes = results.map(result => {
      assert.ok(result.stepId);
      return readStoredContext(fixture, result.stepId).snapshot.paramsHash;
    });
    assert.deepEqual(hashes, expectedFingerprints);
    assert.notEqual(hashes[0], hashes[1]);
    assert.notEqual(hashes[1], hashes[2]);
    for (const result of results.slice(1)) {
      assert.ok(result.stepId);
      assert.equal(readStoredDiff(fixture, result.stepId).changedParams.length, 1);
    }
  });

  test("params fingerprint 超出深度或容器项数时传播受限状态", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(
      fixture,
      "captures/v2/params-fingerprint-limited.jsonl",
    );
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const exchange = makeProcessorExchange({
      sequence: 65,
      threadId: "session-interleaved",
      nativeTurnId: "limited-params-turn",
      input: [{ role: "user", content: [{ type: "input_text", text: "limit params" }] }],
      output: [responseMessage("limited params")],
      params: {
        deep: { level1: { level2: { level3: { level4: { level5: "too deep" } } } } },
        items: Array.from({ length: 65 }, (_, index) => `item-${index}`),
      },
    });
    const normalized = normalizeExchange(
      await hydrateRawCapturedExchange(fixture.dataDir, exchange),
    );
    const result = await processor.processExchangeRecord(processInput(source, 0, exchange));

    assert.ok(result.stepId);
    const context = readStoredContext(fixture, result.stepId);
    assert.equal(context.completeness.complete, false);
    assert.ok(context.completeness.candidateItemCount > context.completeness.processedItemCount);
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) FROM derivation_diagnostics
         WHERE exchange_id = ? AND code = 'context_snapshot_limited'`,
      ).pluck().get(result.exchangeId),
      1,
    );
    const fingerprint = normalized.harnessPayload.paramsFingerprint;
    assert.ok(fingerprint);
    assert.equal(fingerprint.complete, false);
    assert.ok(fingerprint.candidateItemCount > fingerprint.processedItemCount);
  });

  test("artifact params 只保留键名与稳定摘要且不泄露 Prompt 原值", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/redacted-artifact-params.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const sensitiveMarker = "__SENSITIVE_ARTIFACT_PROMPT_73f8a2__";
    const exchange = makeProcessorExchange({
      sequence: 59,
      threadId: "session-interleaved",
      nativeTurnId: "redacted-params-turn",
      input: [{ role: "user", content: [{ type: "input_text", text: "redact params" }] }],
      output: [responseMessage("params accepted")],
    });
    const requestBody = JSON.stringify({
      ...JSON.parse(exchange.request.rawBody!),
      prompt: `${sensitiveMarker}:prompt`,
      instructions: `${sensitiveMarker}:instructions`,
      metadata: { nested: `${sensitiveMarker}:nested` },
    });
    exchange.request.rawBody = requestBody;
    exchange.request.bodySizeBytes = Buffer.byteLength(requestBody);

    const result = await processor.processExchangeRecord(processInput(source, 0, exchange));
    await processor.processExchangeRecord(processInput(source, 100, makeProcessorExchange({
      sequence: 60,
      threadId: "session-interleaved",
      nativeTurnId: "after-redacted-params",
      input: [{ role: "user", content: [{ type: "input_text", text: "close params" }] }],
      output: [responseMessage("closed")],
    })));

    assert.ok(result.stepId);
    assert.ok(result.turnId);
    const contextJson = fixture.db.prepare(
      "SELECT summary_json FROM context_snapshots WHERE agent_step_id = ?",
    ).pluck().get(result.stepId) as string;
    const diffJson = fixture.db.prepare(
      "SELECT diff_json FROM step_diffs WHERE agent_step_id = ?",
    ).pluck().get(result.stepId) as string;
    const learningJson = fixture.db.prepare(
      "SELECT insight_json FROM learning_insights WHERE agent_turn_id = ?",
    ).pluck().get(result.turnId) as string;

    assert.equal(contextJson.includes(sensitiveMarker), false);
    assert.equal(diffJson.includes(sensitiveMarker), false);
    assert.equal(learningJson.includes(sensitiveMarker), false);
    const context = parseStoredContext(contextJson) as {
      snapshot: {
        paramsHash: string;
        harnessPayload: { params: Record<string, unknown> };
      };
    };
    const params = context.snapshot.harnessPayload.params;
    assert.deepEqual(Object.keys(params).sort(), ["keys", "redacted", "stableHash"]);
    assert.deepEqual(params.keys, ["instructions", "metadata", "model", "prompt"]);
    assert.equal(params.redacted, true);
    assert.equal(typeof params.stableHash, "string");
    assert.equal(context.snapshot.paramsHash, params.stableHash);
  });

  test("artifact 字符串裁剪传播 UTF-8 字节完整性与 limited diagnostic", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/truncated-artifact-text.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const asciiToolName = "a".repeat(6_000);
    const utf8ToolName = "工具".repeat(1_000);
    const result = await processor.processExchangeRecord(processInput(
      source,
      0,
      makeProcessorExchange({
        sequence: 58,
        threadId: "session-interleaved",
        nativeTurnId: "truncated-text-turn",
        input: [{ role: "user", content: [{ type: "input_text", text: "long names" }] }],
        output: [asciiToolName, utf8ToolName].map((name, index) => ({
          type: "function_call",
          call_id: `truncated-text-call-${index}`,
          name,
          arguments: "{}",
        })),
      }),
    ));
    const closing = await processor.processExchangeRecord(processInput(
      source,
      100,
      makeProcessorExchange({
        sequence: 59,
        threadId: "session-interleaved",
        nativeTurnId: "after-truncated-text",
        input: [{ role: "user", content: [{ type: "input_text", text: "close names" }] }],
        output: [responseMessage("closed")],
      }),
    ));

    assert.ok(result.stepId);
    assert.ok(result.turnId);
    const context = parseStoredContext(fixture.db.prepare(
      "SELECT summary_json FROM context_snapshots WHERE agent_step_id = ?",
    ).pluck().get(result.stepId) as string) as StoredArtifactEnvelope & {
      snapshot: { harnessPayload: { requestedToolUses: Array<{ name: string }> } };
    };
    const diff = JSON.parse(fixture.db.prepare(
      "SELECT diff_json FROM step_diffs WHERE agent_step_id = ?",
    ).pluck().get(result.stepId) as string) as StoredArtifactEnvelope & {
      addedAssistantToolUses: Array<{ name: string }>;
    };
    const learning = JSON.parse(fixture.db.prepare(
      "SELECT insight_json FROM learning_insights WHERE agent_turn_id = ?",
    ).pluck().get(result.turnId) as string) as StoredArtifactEnvelope & {
      summary: string;
      observations: Array<{ title: string; detail: string }>;
      copyableTemplate: string;
    };

    assert.ok(context.snapshot.harnessPayload.requestedToolUses.every(item =>
      Buffer.byteLength(item.name) <= 512));
    assert.ok(diff.addedAssistantToolUses.every(item => Buffer.byteLength(item.name) <= 512));
    assert.ok(Buffer.byteLength(learning.summary) <= 512);
    assert.ok(learning.observations.every(item =>
      Buffer.byteLength(item.title) <= 512 && Buffer.byteLength(item.detail) <= 512));
    assert.ok(Buffer.byteLength(learning.copyableTemplate) <= 4 * 1024);

    for (const artifact of [context, diff, learning]) {
      assert.equal(artifact.truncated, true);
      assert.equal(artifact.completeness?.complete, false);
      assert.ok((artifact.completeness?.candidateTextBytes ?? 0) >= 12_000);
      assert.ok((artifact.completeness?.processedTextBytes ?? 0) > 0);
      assert.ok(
        (artifact.completeness?.originalEstimatedBytes ?? 0)
          >= (artifact.completeness?.candidateTextBytes ?? Number.POSITIVE_INFINITY),
      );
      assert.ok(
        (artifact.completeness?.processedTextBytes ?? Number.POSITIVE_INFINITY)
          < (artifact.completeness?.candidateTextBytes ?? 0),
      );
    }
    const diagnosticRows = fixture.db.prepare(
      `SELECT code, details_json FROM derivation_diagnostics
       WHERE exchange_id IN (?, ?)
         AND code IN (
           'context_snapshot_limited', 'step_diff_limited', 'learning_insight_limited'
         ) ORDER BY code`,
    ).all(result.exchangeId, closing.exchangeId) as Array<{
      code: string;
      details_json: string;
    }>;
    assert.deepEqual(diagnosticRows.map(row => row.code), [
      "context_snapshot_limited",
      "learning_insight_limited",
      "step_diff_limited",
    ]);
    for (const row of diagnosticRows) {
      const details = JSON.parse(row.details_json) as ArtifactCompletenessView;
      assert.ok(details.candidateTextBytes >= 12_000);
      assert.ok(details.processedTextBytes < details.candidateTextBytes);
    }
  });

  test("learning SQL 在返回 JS 前限制长文本并保留原始 UTF-8 字节数", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/bounded-learning-sql.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const longExchangeId = `capture-processor:${"e".repeat(6_000)}`;
    const longToolUseId = `call-${"i".repeat(6_000)}`;
    const longToolName = "工具".repeat(1_000);
    const exchange = makeProcessorExchange({
      sequence: 57,
      threadId: "session-interleaved",
      nativeTurnId: "bounded-learning-sql-turn",
      input: [{ role: "user", content: [{ type: "input_text", text: "bounded sql" }] }],
      output: [{
        type: "function_call",
        call_id: longToolUseId,
        name: longToolName,
        arguments: "{}",
      }],
    });
    exchange.exchangeId = longExchangeId;
    const result = await processor.processExchangeRecord(processInput(source, 0, exchange));
    assert.ok(result.stepId);
    const longTimestamp = "2".repeat(6_000);
    const longRequestLabel = "请求".repeat(1_000);
    const longResponseLabel = "响应".repeat(1_000);
    fixture.db.prepare(
      `UPDATE agent_steps SET timestamp = ?, request_intent_label = ?, response_status_label = ?
       WHERE id = ?`,
    ).run(longTimestamp, longRequestLabel, longResponseLabel, result.stepId);

    const probe = installLearningSqlProjectionProbe(fixture);
    try {
      await processor.processExchangeRecord(processInput(source, 100, makeProcessorExchange({
        sequence: 58,
        threadId: "session-interleaved",
        nativeTurnId: "after-bounded-learning-sql",
        input: [{ role: "user", content: [{ type: "input_text", text: "close sql" }] }],
        output: [responseMessage("closed")],
      })));
    } finally {
      probe.restore();
    }

    assert.equal(probe.stepRows.length, 1);
    assert.equal(probe.toolRows.length, 1);
    const stepRow = probe.stepRows[0]!;
    const toolRow = probe.toolRows[0]!;
    assert.ok(Buffer.byteLength(stepRow.exchange_id) <= 4 * 256);
    assert.ok(Buffer.byteLength(stepRow.timestamp) <= 4 * 64);
    assert.ok(Buffer.byteLength(stepRow.request_intent_label ?? "") <= 4 * 128);
    assert.ok(Buffer.byteLength(stepRow.response_status_label ?? "") <= 4 * 128);
    assert.equal(stepRow.exchange_id_original_bytes, Buffer.byteLength(longExchangeId));
    assert.equal(stepRow.timestamp_original_bytes, Buffer.byteLength(longTimestamp));
    assert.equal(
      stepRow.request_intent_label_original_bytes,
      Buffer.byteLength(longRequestLabel),
    );
    assert.equal(
      stepRow.response_status_label_original_bytes,
      Buffer.byteLength(longResponseLabel),
    );
    assert.ok(Buffer.byteLength(toolRow.agent_step_id) <= 4 * 256);
    assert.ok(Buffer.byteLength(toolRow.tool_use_id ?? "") <= 4 * 256);
    assert.ok(Buffer.byteLength(toolRow.tool_name) <= 4 * 128);
    assert.equal(toolRow.tool_use_id_original_bytes, Buffer.byteLength(longToolUseId));
    assert.equal(toolRow.tool_name_original_bytes, Buffer.byteLength(longToolName));
    assert.doesNotMatch(probe.turnSql, /model_set_json/);
  });

  test("context/diff/learning 超预算时只写结构化受限摘要与 diagnostic", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/limited-artifacts.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const hugeContext = await processor.processExchangeRecord(processInput(source, 0, makeProcessorExchange({
      sequence: 60,
      threadId: "session-interleaved",
      nativeTurnId: "large-context-turn",
      input: [{
        role: "user",
        content: [{ type: "input_text", text: "x".repeat(300 * 1024) }],
      }],
      output: [responseMessage("context accepted")],
    })));
    const manyItems = Array.from({ length: 6_000 }, (_, index) => ({
      role: "user",
      content: [{ type: "input_text", text: `item-${index}` }],
    }));
    const hugeDiff = await processor.processExchangeRecord(processInput(source, 100, makeProcessorExchange({
      sequence: 61,
      threadId: "session-interleaved",
      nativeTurnId: "large-context-turn",
      input: manyItems,
      output: [responseMessage("many items accepted")],
    })));
    const longToolNames = Array.from({ length: 500 }, (_, index) =>
      `tool-${index}-${"n".repeat(300)}`);
    const toolTurn = await processor.processExchangeRecord(processInput(source, 200, makeProcessorExchange({
      sequence: 62,
      threadId: "session-interleaved",
      nativeTurnId: "large-learning-turn",
      input: [{ role: "user", content: [{ type: "input_text", text: "use many tools" }] }],
      output: longToolNames.map((name, index) => ({
        type: "function_call",
        call_id: `large-call-${index}`,
        name,
        arguments: "{}",
      })),
    })));
    await processor.processExchangeRecord(processInput(source, 300, makeProcessorExchange({
      sequence: 63,
      threadId: "session-interleaved",
      nativeTurnId: "large-learning-turn",
      input: longToolNames.map((_name, index) => ({
        type: "function_call_output",
        call_id: `large-call-${index}`,
        output: `result-${index}`,
      })),
      output: [responseMessage("all tools done")],
    })));
    await processor.processExchangeRecord(processInput(source, 400, makeProcessorExchange({
      sequence: 64,
      threadId: "session-interleaved",
      nativeTurnId: "after-large-learning",
      input: [{ role: "user", content: [{ type: "input_text", text: "next turn" }] }],
      output: [responseMessage("next")],
    })));

    assert.ok(hugeContext.stepId);
    assert.ok(hugeDiff.stepId);
    assert.ok(toolTurn.turnId);
    const contextRow = fixture.db.prepare(
      `SELECT summary_json, size_bytes, artifact_storage, artifact_hash
       FROM context_snapshots
       WHERE agent_step_id = ?`,
    ).get(hugeContext.stepId) as {
      summary_json: string;
      size_bytes: number;
      artifact_storage: string | null;
      artifact_hash: string | null;
    };
    const context = {
      summary_json: resolveDerivedArtifactJson(fixture.dataDir, {
        artifact_storage: contextRow.artifact_storage,
        artifact_hash: contextRow.artifact_hash,
        inline_json: contextRow.summary_json,
      }),
      size_bytes: contextRow.size_bytes,
    };
    const diffRow = fixture.db.prepare(
      `SELECT diff_json, size_bytes, artifact_storage, artifact_hash
       FROM step_diffs WHERE agent_step_id = ?`,
    ).get(hugeDiff.stepId) as {
      diff_json: string;
      size_bytes: number;
      artifact_storage: string | null;
      artifact_hash: string | null;
    };
    const diff = {
      diff_json: resolveDerivedArtifactJson(fixture.dataDir, {
        artifact_storage: diffRow.artifact_storage,
        artifact_hash: diffRow.artifact_hash,
        inline_json: diffRow.diff_json,
      }),
      size_bytes: diffRow.size_bytes,
    };
    const learning = fixture.db.prepare(
      `SELECT insight_json, size_bytes FROM learning_insights
       WHERE agent_turn_id = ?`,
    ).get(toolTurn.turnId) as { insight_json: string; size_bytes: number };
    assert.ok(context.size_bytes <= 256 * 1024);
    assert.ok(diff.size_bytes <= 256 * 1024);
    assert.ok(learning.size_bytes <= 128 * 1024);
    // 存储瘦身后：单条超大正文（300 KiB）的请求不再让 artifact 判为截断——
    // 丢弃的是正文存储（按需读 raw），条目本身完整保留；来源规模仍如实记录。
    const hugeContextEnvelope = JSON.parse(context.summary_json) as StoredArtifactEnvelope & {
      originalEstimatedBytes?: number;
    };
    assert.equal(hugeContextEnvelope.truncated, false);
    assert.ok((hugeContextEnvelope.originalEstimatedBytes ?? 0) > 256 * 1024);
    // 真正超过条数上限（6000 项）时仍必须标记截断。
    assert.equal(JSON.parse(diff.diff_json).truncated, true);
    assert.equal(JSON.parse(learning.insight_json).truncated, true);
    const diffEnvelope = JSON.parse(diff.diff_json) as StoredArtifactEnvelope;
    const learningEnvelope = JSON.parse(learning.insight_json) as StoredArtifactEnvelope;
    assert.ok((diffEnvelope.completeness?.candidateItemCount ?? 0) >= 6_000);
    assert.ok((diffEnvelope.completeness?.processedItemCount ?? Number.POSITIVE_INFINITY) <= 2_048);
    assert.ok(
      (diffEnvelope.completeness?.processedItemCount ?? Number.POSITIVE_INFINITY)
        < (diffEnvelope.completeness?.candidateItemCount ?? 0),
    );
    assert.ok(
      (learningEnvelope.completeness?.processedItemCount ?? Number.POSITIVE_INFINITY) <= 3_000,
    );
    assert.equal(context.summary_json.includes("x".repeat(128)), false);
    assert.equal(context.summary_json.includes("context accepted"), false);
    const processorSource = await readFile(
      new URL("../src/lib/ingestion/exchange-processor.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      processorSource,
      /jsonByteLength\(fullSnapshot\)|JSON\.stringify\(fullSnapshot\)/,
    );
    assert.ok(JSON.parse(context.summary_json).originalEstimatedBytes > 256 * 1024);
    assert.ok(JSON.parse(diff.diff_json).originalEstimatedBytes > 256 * 1024);
    assert.ok(JSON.parse(learning.insight_json).originalEstimatedBytes > 128 * 1024);
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT DISTINCT code FROM derivation_diagnostics
         WHERE code IN (
           'context_snapshot_limited', 'step_diff_limited',
           'learning_insight_limited'
         ) ORDER BY code`,
      ).pluck().all(),
      [
        "context_snapshot_limited",
        "learning_insight_limited",
        "step_diff_limited",
      ],
    );
  });

  test("prior 或 current snapshot 不完整时 diff 保留完整性与候选计数", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/incomplete-context-diff.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const largeMessages = Array.from({ length: 6_000 }, (_, index) => ({
      role: "user",
      content: [{ type: "input_text", text: `large-message-${index}` }],
    }));
    const largeToolResults = Array.from({ length: 6_000 }, (_, index) => ({
      type: "function_call_output",
      call_id: `context-call-${index}`,
      output: `result-${index}`,
    }));
    const largePrior = await processor.processExchangeRecord(processInput(
      source,
      0,
      makeProcessorExchange({
        sequence: 65,
        threadId: "session-interleaved",
        nativeTurnId: "incomplete-context-turn",
        input: largeMessages,
        output: [{
          type: "function_call",
          call_id: "context-call-0",
          name: "read_context",
          arguments: "{}",
        }],
      }),
    ));
    const smallCurrent = await processor.processExchangeRecord(processInput(
      source,
      100,
      makeProcessorExchange({
        sequence: 66,
        threadId: "session-interleaved",
        nativeTurnId: "incomplete-context-turn",
        input: [{ type: "function_call_output", call_id: "context-call-0", output: "ok" }],
        output: [responseMessage("small current")],
      }),
    ));
    const largeCurrent = await processor.processExchangeRecord(processInput(
      source,
      200,
      makeProcessorExchange({
        sequence: 67,
        threadId: "session-interleaved",
        nativeTurnId: "incomplete-context-turn",
        input: largeToolResults,
        output: [responseMessage("large current")],
      }),
    ));

    assert.ok(largePrior.stepId);
    assert.ok(smallCurrent.stepId);
    assert.ok(largeCurrent.stepId);
    const priorSnapshot = parseStoredContext(storedArtifactText(
      fixture.db,
      fixture.dataDir,
      "context_snapshots",
      largePrior.stepId,
    )) as StoredArtifactEnvelope;
    const priorIncompleteDiff = JSON.parse(storedArtifactText(
      fixture.db,
      fixture.dataDir,
      "step_diffs",
      smallCurrent.stepId,
    )) as StoredArtifactEnvelope;
    const currentIncompleteDiff = JSON.parse(storedArtifactText(
      fixture.db,
      fixture.dataDir,
      "step_diffs",
      largeCurrent.stepId,
    )) as StoredArtifactEnvelope;

    assert.equal(priorSnapshot.truncated, true);
    assert.equal(priorSnapshot.completeness?.complete, false);
    assert.ok((priorSnapshot.completeness?.candidateItemCount ?? 0) >= 6_000);
    assert.ok(
      (priorSnapshot.completeness?.processedItemCount ?? Number.POSITIVE_INFINITY) <= 1_024,
    );
    assert.ok(
      (priorSnapshot.completeness?.processedItemCount ?? Number.POSITIVE_INFINITY)
        < (priorSnapshot.completeness?.candidateItemCount ?? 0),
    );
    assert.equal(priorIncompleteDiff.truncated, true);
    assert.equal(priorIncompleteDiff.sourceCompleteness?.previous?.complete, false);
    assert.ok(
      (priorIncompleteDiff.completeness?.processedItemCount ?? Number.POSITIVE_INFINITY)
        <= 2_048,
    );
    assert.ok(
      (priorIncompleteDiff.sourceCompleteness?.previous?.originalEstimatedBytes ?? 0)
        > 256 * 1024,
    );
    assert.equal(priorIncompleteDiff.sourceCompleteness?.current?.complete, true);
    assert.equal(currentIncompleteDiff.truncated, true);
    assert.equal(currentIncompleteDiff.sourceCompleteness?.previous?.complete, true);
    assert.equal(currentIncompleteDiff.sourceCompleteness?.current?.complete, false);
    assert.ok(
      (currentIncompleteDiff.completeness?.processedItemCount ?? Number.POSITIVE_INFINITY)
        <= 2_048,
    );
    assert.ok(
      (currentIncompleteDiff.sourceCompleteness?.current?.candidateItemCount ?? 0) >= 6_000,
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) FROM derivation_diagnostics
         WHERE code = 'step_diff_limited'
           AND exchange_id IN (?, ?)`,
      ).pluck().get(smallCurrent.exchangeId, largeCurrent.exchangeId),
      2,
    );
  });

  test("artifact 投影不会全量遍历或编码 6000 个上下文项", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/artifact-projection-probe.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const largeMessages = Array.from({ length: 6_000 }, (_, index) => ({
      role: "user",
      content: [{ type: "input_text", text: `probe-message-${index}` }],
    }));
    const longToolNames = Array.from({ length: 500 }, (_, index) =>
      `probe-tool-${index}-${"p".repeat(300)}`);
    const inputs = [
      processInput(source, 0, makeProcessorExchange({
        sequence: 68,
        threadId: "session-interleaved",
        nativeTurnId: "artifact-probe-context",
        input: largeMessages,
        output: [responseMessage("probe context")],
      })),
      processInput(source, 100, makeProcessorExchange({
        sequence: 69,
        threadId: "session-interleaved",
        nativeTurnId: "artifact-probe-learning",
        input: [{ role: "user", content: [{ type: "input_text", text: "probe tools" }] }],
        output: longToolNames.map((name, index) => ({
          type: "function_call",
          call_id: `probe-call-${index}`,
          name,
          arguments: "{}",
        })),
      })),
      processInput(source, 200, makeProcessorExchange({
        sequence: 70,
        threadId: "session-interleaved",
        nativeTurnId: "artifact-probe-learning",
        input: longToolNames.map((_name, index) => ({
          type: "function_call_output",
          call_id: `probe-call-${index}`,
          output: `probe-result-${index}`,
        })),
        output: [responseMessage("probe tool results")],
      })),
      processInput(source, 300, makeProcessorExchange({
        sequence: 71,
        threadId: "session-interleaved",
        nativeTurnId: "artifact-probe-close",
        input: [{ role: "user", content: [{ type: "input_text", text: "close probe" }] }],
        output: [responseMessage("probe closed")],
      })),
    ];
    const probe = installArtifactProjectionProbe();
    try {
      for (const input of inputs) {
        await processor.processExchangeRecord(input);
      }
    } finally {
      probe.restore();
    }

    assert.deepEqual(probe.operations, []);
  });

  test("artifact 字符串按 UTF-8 字节硬限制", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/artifact-utf8-limit.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const longToolName = "工具".repeat(1_000);
    const toolTurn = await processor.processExchangeRecord(processInput(
      source,
      0,
      makeProcessorExchange({
        sequence: 72,
        threadId: "session-interleaved",
        nativeTurnId: "artifact-utf8-turn",
        input: [{ role: "user", content: [{ type: "input_text", text: "utf8" }] }],
        output: [{
          type: "function_call",
          call_id: "utf8-call",
          name: longToolName,
          arguments: "{}",
        }],
      }),
    ));
    await processor.processExchangeRecord(processInput(source, 100, makeProcessorExchange({
      sequence: 73,
      threadId: "session-interleaved",
      nativeTurnId: "artifact-utf8-close",
      input: [{ role: "user", content: [{ type: "input_text", text: "close utf8" }] }],
      output: [responseMessage("closed")],
    })));

    assert.ok(toolTurn.stepId);
    assert.ok(toolTurn.turnId);
    const snapshot = parseStoredContext(fixture.db.prepare(
      "SELECT summary_json FROM context_snapshots WHERE agent_step_id = ?",
    ).pluck().get(toolTurn.stepId) as string) as {
      snapshot: { harnessPayload: { requestedToolUses: Array<{ name: string }> } };
    };
    const learning = JSON.parse(fixture.db.prepare(
      "SELECT insight_json FROM learning_insights WHERE agent_turn_id = ?",
    ).pluck().get(toolTurn.turnId) as string) as {
      summary: string;
      observations: Array<{ title: string; detail: string }>;
      copyableTemplate: string;
    };
    assert.ok(
      Buffer.byteLength(snapshot.snapshot.harnessPayload.requestedToolUses[0]!.name) <= 512,
    );
    assert.ok(Buffer.byteLength(learning.summary) <= 512);
    assert.ok(learning.observations.every(item =>
      Buffer.byteLength(item.title) <= 512 && Buffer.byteLength(item.detail) <= 512));
    assert.ok(Buffer.byteLength(learning.copyableTemplate) <= 4 * 1024);
  });

  test("learning tool 读取超过有界探针时即使低于字节预算也标记 truncated", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/learning-tool-limit.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const toolTurn = await processor.processExchangeRecord(processInput(source, 0, makeProcessorExchange({
      sequence: 80,
      threadId: "session-interleaved",
      nativeTurnId: "tool-limit-turn",
      input: [{ role: "user", content: [{ type: "input_text", text: "bounded tools" }] }],
      output: Array.from({ length: 2_001 }, (_, index) => ({
        type: "function_call",
        call_id: `bounded-call-${index}`,
        name: `t${index}`,
        arguments: "{}",
      })),
    })));
    await processor.processExchangeRecord(processInput(source, 100, makeProcessorExchange({
      sequence: 81,
      threadId: "session-interleaved",
      nativeTurnId: "after-tool-limit",
      input: [{ role: "user", content: [{ type: "input_text", text: "close" }] }],
      output: [responseMessage("closed")],
    })));

    assert.ok(toolTurn.turnId);
    const insight = fixture.db.prepare(
      `SELECT insight_json, size_bytes FROM learning_insights
       WHERE agent_turn_id = ?`,
    ).get(toolTurn.turnId) as { insight_json: string; size_bytes: number };
    assert.ok(insight.size_bytes < 128 * 1024);
    assert.equal(JSON.parse(insight.insight_json).truncated, true);
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) FROM derivation_diagnostics
         WHERE code = 'learning_insight_limited'
           AND exchange_id = 'capture-processor:ex-81'`,
      ).pluck().get(),
      1,
    );
    const processorSource = await readFile(
      new URL("../src/lib/ingestion/exchange-processor.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      processorSource,
      /FROM tool_calls WHERE agent_turn_id = \?[\s\S]*ORDER BY tool_calls\.tool_name[\s\S]*LIMIT \?/,
    );
    const plan = queryPlanDetails(
      fixture,
      `SELECT
         substr(agent_step_id, 1, ?) AS agent_step_id,
         length(CAST(agent_step_id AS BLOB)) AS agent_step_id_original_bytes,
         substr(tool_use_id, 1, ?) AS tool_use_id,
         length(CAST(tool_use_id AS BLOB)) AS tool_use_id_original_bytes,
         substr(tool_name, 1, ?) AS tool_name,
         length(CAST(tool_name AS BLOB)) AS tool_name_original_bytes
       FROM tool_calls WHERE agent_turn_id = ?
       ORDER BY tool_calls.tool_name LIMIT ?`,
      256,
      256,
      128,
      toolTurn.turnId,
      2_001,
    );
    assert.ok(plan.some(detail => detail.includes("idx_tools_turn_name")));
    assert.ok(plan.every(detail => !detail.includes("SCAN tool_calls")));
    assert.ok(plan.every(detail => !detail.includes("USE TEMP B-TREE")));
  });

  test("source id/path/offset fail closed，runtime v1 不水合且写 diagnostic", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/source-validation.jsonl");
    let hydrateCount = 0;
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      hydrateExchange: async (dataDir, exchange, options) => {
        hydrateCount += 1;
        return hydrateRawCapturedExchange(dataDir, exchange, options);
      },
    });
    const validExchange = makeProcessorExchange({
      sequence: 70,
      threadId: "session-interleaved",
      nativeTurnId: "source-turn",
      input: [{ role: "user", content: [{ type: "input_text", text: "validate" }] }],
      output: [responseMessage("valid")],
    });

    await assert.rejects(
      processor.processExchangeRecord({
        ...processInput(source, 0, validExchange),
        sourceRelativePath: "captures/v2/other.jsonl",
      }),
      /不匹配/,
    );
    await assert.rejects(
      processor.processExchangeRecord({
        ...processInput(source, 0, validExchange),
        sourceId: source.sourceId + 999,
      }),
      /不匹配/,
    );
    await assert.rejects(
      processor.processExchangeRecord({
        ...processInput(source, 0, validExchange),
        byteOffset: -1,
      }),
      /byteOffset/,
    );
    await assert.rejects(
      processor.processExchangeRecord({
        ...processInput(source, 4_050, validExchange),
        lineLengthBytes: 100,
      }),
      /source.*range|范围/i,
    );
    assert.equal(hydrateCount, 0);

    const runtimeV1 = {
      ...validExchange,
      exchangeId: "capture-processor:runtime-v1",
      schemaVersion: 1,
    } as unknown as RawCapturedExchangeV2;
    const result = await processor.processExchangeRecord(
      processInput(source, 100, runtimeV1),
    );
    assert.deepEqual(result, {
      exchangeId: "capture-processor:runtime-v1",
      duplicate: false,
    });
    assert.equal(hydrateCount, 0);
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) FROM derivation_diagnostics
         WHERE code = 'unsupported_raw_schema'`,
      ).pluck().get(),
      1,
    );
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM raw_exchange_refs").pluck().get(),
      0,
    );
  });

  test("真实 SQLite 约束失败会回滚单 Exchange 全部写入且 duplicate 保持零水合", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/transaction-rollback.jsonl");
    let hydrateCount = 0;
    const input = processInput(source, 0, makeProcessorExchange({
      sequence: 71,
      threadId: "session-interleaved",
      nativeTurnId: "rollback-turn",
      input: [{ role: "user", content: [{ type: "input_text", text: "atomic" }] }],
      output: [responseMessage("atomic done")],
    }));
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
      hydrateExchange: async (dataDir, exchange, options) => {
        hydrateCount += 1;
        return hydrateRawCapturedExchange(dataDir, exchange, options);
      },
    });
    const processorSource = await readFile(
      new URL("../src/lib/ingestion/exchange-processor.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(processorSource, /\bbeforeCommit\b/);
    fixture.db.exec(`
      CREATE TRIGGER reject_agent_step_insert
      BEFORE INSERT ON agent_steps
      BEGIN
        SELECT RAISE(ABORT, 'injected transaction failure');
      END;
    `);

    await assert.rejects(
      processor.processExchangeRecord(input),
      /injected transaction failure/,
    );
    assert.deepEqual(derivationTableSnapshot(fixture), emptyDerivationTableSnapshot());
    fixture.db.exec("DROP TRIGGER reject_agent_step_insert");

    const first = await processor.processExchangeRecord(input);
    const replay = await processor.processExchangeRecord(input);
    assert.equal(first.duplicate, false);
    assert.equal(replay.duplicate, true);
    assert.equal(hydrateCount, 2);
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM raw_exchange_refs").pluck().get(),
      1,
    );
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM agent_steps").pluck().get(),
      1,
    );
  });

  test("Thread closure 祖先不提前累加 child direct aggregate，重放不双计", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/direct-only.jsonl");
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: fixturePricingConfig(),
    });
    const root = await processor.processExchangeRecord(processInput(source, 0, makeProcessorExchange({
      sequence: 72,
      threadId: "session-interleaved",
      nativeTurnId: "root-direct",
      input: [{ role: "user", content: [{ type: "input_text", text: "root" }] }],
      output: [responseMessage("root")],
    })));
    const childInput = processInput(source, 100, makeProcessorExchange({
      sequence: 73,
      threadId: "child-direct",
      parentThreadId: "session-interleaved",
      nativeTurnId: "child-direct",
      input: [{ role: "user", content: [{ type: "input_text", text: "child" }] }],
      output: [responseMessage("child")],
    }));
    const child = await processor.processExchangeRecord(childInput);
    await processor.processExchangeRecord(childInput);

    assert.ok(root.threadId);
    assert.ok(child.threadId);
    assert.equal(
      fixture.db.prepare(
        `SELECT depth FROM thread_closure
         WHERE ancestor_thread_id = ? AND descendant_thread_id = ?`,
      ).pluck().get(root.threadId, child.threadId),
      1,
    );
    assert.deepEqual(scopeAggregate(fixture, "thread", root.threadId), {
      step_request_count: 1,
      auxiliary_request_count: 0,
      tool_call_count: 0,
    });
    assert.deepEqual(scopeAggregate(fixture, "thread", child.threadId), {
      step_request_count: 1,
      auxiliary_request_count: 0,
      tool_call_count: 0,
    });
    assert.deepEqual(scopeAggregate(fixture, "session", root.sessionId!), {
      step_request_count: 2,
      auxiliary_request_count: 0,
      tool_call_count: 0,
    });
  });

  test("套餐通道派生写入每次请求的套餐积分折算", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/plan-credit.jsonl");
    await writeFile(join(fixture.dataDir, "proxy-config.json"), JSON.stringify({
      version: 3,
      revision: 1,
      updatedAt: "2026-08-20T00:00:00.000Z",
      localProxyBaseUrl: "http://localhost:3211",
      agentConnections: {},
      targets: [{
        id: "target-processor",
        name: "processor fixture",
        enabled: true,
        supportedModels: [],
        openaiUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
        billingChannel: "plan",
        vendorFamily: "volcengine",
      }],
    }));
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: {
        version: 2,
        currency: "USD",
        unit: "per_million_tokens",
        models: [{
          id: "catalog:volcengine-plan:fixture-model",
          vendor: "volcengine-plan",
          patterns: ["fixture-model"],
          pricing: {input: 1, output: 2, cachedInput: 0.5},
          planCreditRules: {
            formula: "afp_weighted",
            currency: "CNY",
            divisor: 10000,
            modelFactors: {"fixture-model": {input: 2.5, output: 2.5}},
            quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
          },
          confidence: "official",
        }],
      },
    });
    const result = await processor.processExchangeRecord(processInput(source, 0, makeProcessorExchange({
      sequence: 90,
      threadId: "plan-credit-thread",
      nativeTurnId: "plan-credit-turn",
      input: [{ role: "user", content: [{ type: "input_text", text: "plan credit" }] }],
      output: [responseMessage("plan credit")],
      usage: {
        input_tokens: 1_000_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        total_tokens: 1_000_000,
      },
    })));

    const row = fixture.db.prepare(
      `SELECT plan_credit_cost, plan_credit_unit, plan_credit_formula_version
       FROM usage_ledger WHERE exchange_id = ?`,
    ).get(result.exchangeId) as Record<string, unknown>;
    // 官方 AFP 公式：(输入 1M × 2.5 + 输出 0 × 2.5) / 10000 = 250 AFP（缓存命中按输入系数计入）。
    assert.equal(row.plan_credit_unit, "AFP");
    assert.equal(row.plan_credit_formula_version, "afp-weighted-2026-09");
    assert.ok(Math.abs(Number(row.plan_credit_cost) - 250) < 1e-9);
  });

  test("套餐通道辅助请求同样折算 AFP 并把积分公式写入价格快照", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const source = seedIngestionSource(fixture, "captures/v2/plan-credit-aux.jsonl");
    await writeFile(join(fixture.dataDir, "proxy-config.json"), JSON.stringify({
      version: 3,
      revision: 1,
      updatedAt: "2026-09-02T00:00:00.000Z",
      localProxyBaseUrl: "http://localhost:3211",
      agentConnections: {},
      targets: [{
        id: "target-processor",
        name: "processor fixture",
        enabled: true,
        supportedModels: [],
        openaiUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
        billingChannel: "plan",
        vendorFamily: "volcengine",
      }],
    }));
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
      pricingConfig: {
        version: 2,
        currency: "USD",
        unit: "per_million_tokens",
        models: [{
          id: "catalog:volcengine-plan:fixture-model",
          vendor: "volcengine-plan",
          patterns: ["fixture-model"],
          pricing: {input: 1, output: 2, cachedInput: 0.5},
          planCreditRules: {
            formula: "afp_weighted",
            currency: "CNY",
            divisor: 10000,
            modelFactors: {"fixture-model": {input: 5.5, output: 5.5}},
            quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
          },
          confidence: "official",
        }],
      },
    });
    // count_tokens 端点 → 辅助请求路径；203 输入 + 239 输出，deepseek-v4-pro 档系数 5.5。
    const aux = await processor.processExchangeRecord(processInput(source, 0, makeProcessorExchange({
      sequence: 91,
      threadId: "plan-credit-aux-thread",
      nativeTurnId: "plan-credit-aux-turn",
      requestPath: "/v1/messages/count_tokens",
      model: "fixture-model",
      input: [{ role: "user", content: [{ type: "input_text", text: "count" }] }],
      output: [],
      usage: {
        input_tokens: 203,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 239,
        total_tokens: 442,
      },
    })));

    const row = fixture.db.prepare(
      `SELECT plan_credit_cost, plan_credit_unit, plan_credit_formula_version, pricing_snapshot_json, request_kind
       FROM usage_ledger WHERE exchange_id = ?`,
    ).get(aux.exchangeId) as Record<string, unknown>;
    assert.equal(row.request_kind, "token_count");
    assert.equal(row.plan_credit_unit, "AFP");
    assert.equal(row.plan_credit_formula_version, "afp-weighted-2026-09");
    // ((203 + 0) × 5.5 + 239 × 5.5) / 10000 = 0.2431 AFP —— 与官方统计口径闭合。
    assert.ok(Math.abs(Number(row.plan_credit_cost) - 0.2431) < 1e-9);
    const snapshot = JSON.parse(String(row.pricing_snapshot_json)) as {planCreditFormula?: string};
    assert.match(String(snapshot.planCreditFormula), /AFP = .+× 5\.5/);
  });
});

function agentPath(options: {
  sessionId?: string;
  rootThreadId?: string;
  threadId: string;
  parentThreadId?: string;
  displayName?: string;
  diagnostics?: ResolvedAgentPath["diagnostics"];
}): ResolvedAgentPath {
  const sessionId = options.sessionId ?? "session-1";
  const rootThreadId = options.rootThreadId ?? "thread-root";
  return {
    targetId: "target-1",
    targetName: "测试 Target",
    agentFingerprintId: "fingerprint-1",
    agentName: "codex",
    agentSessionId: sessionId,
    agentThreadId: options.threadId,
    rootAgentThreadId: rootThreadId,
    parentAgentThreadId: options.parentThreadId,
    externalSessionId: "external-session-1",
    externalConversationId: "external-conversation-1",
    externalThreadId: options.threadId,
    externalParentThreadId: options.parentThreadId,
    sessionSource: "session-header",
    threadSource: "thread-metadata",
    confidence: "exact",
    isRootThread: options.threadId === rootThreadId,
    displayName: options.displayName ?? `Thread ${options.threadId}`,
    diagnostics: options.diagnostics ?? [],
  };
}

test("目标级结算系数改动产生新价格版本，后续捕获立即按新系数入账（2026-09-23：无需重启进程）", async () => {
  const fixture = await createSqliteFixture();
  try {
    const source = seedIngestionSource(fixture, "captures/v2/settlement-fx-refresh.jsonl");
    const configPath = join(fixture.dataDir, "proxy-config.json");
    const writeConfig = (fx: number) => writeFile(
      configPath,
      JSON.stringify({
        version: 3,
        revision: 1,
        agentConnections: {},
        targets: [{id: "target-processor", pricing: {settlementFx: fx}}],
      }),
      "utf8",
    );
    await writeConfig(2);
    const processor = createExchangeProcessor({db: fixture.db, dataDir: fixture.dataDir});
    const fxFor = (exchangeId: string) => fixture.db.prepare(
      "SELECT fx_rate_to_cny FROM usage_ledger WHERE exchange_id = ?",
    ).pluck().get(exchangeId);

    // 首条记录（captured 08:00:01）：基线版本（fx=2）。
    await processor.processExchangeRecord(processInput(source, 0, makeProcessorExchange({
      sequence: 1,
      threadId: "session-fx-refresh",
      input: [{ role: "user", content: [{ type: "input_text", text: "q1" }] }],
      output: [responseMessage("ok")],
    })));
    assert.equal(fxFor("capture-processor:ex-1"), 2);

    // 修改结算系数（0.5）→ worker 每批 refresh 感知文件变化；保存链路（proxy-config
    // PUT 按 config.updatedAt 记版本）在此显式补一个夹在两行捕获时刻之间的版本，
    // 后续捕获（08:00:02 > 版本生效时刻）立即按新系数入账，无需重启进程。
    await writeConfig(0.5);
    await processor.refreshPricingConfig();
    ensurePricingConfigRevision(
      fixture.db,
      {
        version: 2,
        currency: "USD",
        models: [],
        targetSettlementFx: {"target-processor": 0.5},
      },
      new Date(Date.parse(BASE_TIME) + 1_500).toISOString(),
    );
    await processor.processExchangeRecord(processInput(source, 100, makeProcessorExchange({
      sequence: 2,
      threadId: "session-fx-refresh",
      input: [{ role: "user", content: [{ type: "input_text", text: "q2" }] }],
      output: [responseMessage("ok2")],
    })));
    assert.equal(fxFor("capture-processor:ex-2"), 0.5);
  } finally {
    await fixture.cleanup();
  }
});

test("结算系数按 captured_at 选版本：版本值优先、迟到行用捕获时刻口径、旧版本回退现读值（2026-09-23 方案 B）", async () => {
  const fixture = await createSqliteFixture();
  try {
    const source = seedIngestionSource(fixture, "captures/v2/settlement-fx-versioned.jsonl");
    const processor = createExchangeProcessor({db: fixture.db, dataDir: fixture.dataDir});
    const fxFor = (exchangeId: string) => fixture.db.prepare(
      "SELECT fx_rate_to_cny FROM usage_ledger WHERE exchange_id = ?",
    ).pluck().get(exchangeId);
    // 手工铺两个受控生效时刻的价格版本：rev1 无系数（历史 blob 形状），
    // rev2 携带 targetSettlementFx=0.0625（captured 时间均基于 BASE_TIME=2026-07-17T08:00Z）。
    const baseConfig = {
      version: 2 as const,
      currency: "USD",
      models: [],
    };
    ensurePricingConfigRevision(fixture.db, baseConfig, "2026-07-17T08:00:10.000Z");
    ensurePricingConfigRevision(
      fixture.db,
      {...baseConfig, targetSettlementFx: {"target-processor": 0.0625}},
      "2026-07-17T08:00:30.000Z",
    );
    // 现读兜底来源：proxy-config 现值为 2（模拟「版本链之外」的实时配置）。
    await writeFile(join(fixture.dataDir, "proxy-config.json"), JSON.stringify({
      version: 3,
      revision: 1,
      agentConnections: {},
      targets: [{id: "target-processor", pricing: {settlementFx: 2}}],
    }), "utf8");
    await processor.refreshPricingConfig();

    // 捕获在 rev1 时段（版本 blob 无系数字段）：回退现读值 2。
    await processor.processExchangeRecord(processInput(source, 0, makeProcessorExchange({
      sequence: 20,
      threadId: "session-fx-versioned",
      input: [{ role: "user", content: [{ type: "input_text", text: "legacy" }] }],
      output: [responseMessage("a")],
    })));
    assert.equal(fxFor("capture-processor:ex-20"), 2);

    // 捕获在 rev2 之后：版本值 0.0625 优先，即使现读值仍是 2。
    await processor.processExchangeRecord(processInput(source, 100, makeProcessorExchange({
      sequence: 40,
      threadId: "session-fx-versioned",
      input: [{ role: "user", content: [{ type: "input_text", text: "new" }] }],
      output: [responseMessage("b")],
    })));
    assert.equal(fxFor("capture-processor:ex-40"), 0.0625);

    // 迟到行：捕获在 08:00:25（rev2 之前）、最后才派生 → 按捕获时刻命中 rev1 → 回退现读 2，
    // 绝不以派生时刻的新系数回算迟到数据。
    await processor.processExchangeRecord(processInput(source, 200, makeProcessorExchange({
      sequence: 25,
      threadId: "session-fx-versioned",
      input: [{ role: "user", content: [{ type: "input_text", text: "late" }] }],
      output: [responseMessage("c")],
    })));
    assert.equal(fxFor("capture-processor:ex-25"), 2);
  } finally {
    await fixture.cleanup();
  }
});

function seedIngestionSource(
  fixture: SqliteFixture,
  relativePath: string,
): { sourceId: number; sourceRelativePath: string } {
  const sourceId = fixture.db.prepare(
    `INSERT INTO ingestion_sources(
      relative_path, file_id, file_size, updated_at
    ) VALUES(?, ?, 4096, ?)
    RETURNING id`,
  ).pluck().get(relativePath, `fixture:${relativePath}`, BASE_TIME) as number;
  return { sourceId, sourceRelativePath: relativePath };
}

function processInput(
  source: { sourceId: number; sourceRelativePath: string },
  byteOffset: number,
  exchange: RawCapturedExchangeV2,
) {
  return {
    ...source,
    byteOffset,
    lineLengthBytes: 100,
    exchange,
  };
}

/**
 * 单测直连 processExchangeRecord 时没有 worker 登记步骤；重试折叠按
 * ingestion_records.request_body_sha256 判定字面重发（生产链路 worker 必先登记），
 * 因此需要重试语义的用例手动补登记行（与 registrar 写入字段一致）。
 */
function seedIngestionRecord(
  fixture: SqliteFixture,
  source: { sourceId: number; sourceRelativePath: string },
  byteOffset: number,
  exchange: RawCapturedExchangeV2,
): void {
  fixture.db.prepare(
    `INSERT INTO ingestion_records(
      exchange_id, source_id, source_generation, source_file_id,
      byte_offset, line_length_bytes, line_sha256, schema_version,
      captured_at, completed_at, request_body_bytes, response_body_bytes,
      request_body_sha256, response_body_sha256,
      request_body_storage, response_body_storage,
      request_body_state, response_body_state, registered_at, projection_state
    ) VALUES(?, ?, 0, ?, ?, 100, ?, ?, ?, ?, ?, ?, ?, ?, 'inline', 'inline', 'available', 'available', ?, 'active')`,
  ).run(
    exchange.exchangeId,
    source.sourceId,
    source.sourceRelativePath,
    byteOffset,
    createHash("sha256").update(`line:${exchange.exchangeId}`, "utf8").digest("hex"),
    exchange.schemaVersion,
    exchange.capturedAt,
    exchange.completedAt,
    exchange.request.bodySizeBytes,
    exchange.response.bodySizeBytes,
    exchange.request.bodySha256,
    exchange.response.bodySha256,
    BASE_TIME,
  );
}

function makeProcessorExchange(options: {
  sequence: number;
  threadId: string;
  parentThreadId?: string;
  nativeTurnId?: string;
  input: unknown[];
  output: unknown[];
  requestPath?: string;
  model?: string;
  usage?: Record<string, unknown> | null;
  sessionOnly?: boolean;
  conversationId?: string;
  omitSessionHeader?: boolean;
  tools?: unknown[];
  params?: Record<string, unknown>;
  routingAgent?: "codex" | "claude" | "opencode" | "dsh" | "zcode";
  routingOrigin?: "gateway" | "agent_local_import";
  routingClientCredentialId?: string;
  wireApi?: "responses" | "chat_completions" | "messages";
  headers?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  firstTokenMs?: number;
  captureSessionId?: string;
}): RawCapturedExchangeV2 {
  const captureSessionId = options.captureSessionId ?? "capture-processor";
  const capturedAt = new Date(Date.parse(BASE_TIME) + options.sequence * 1_000).toISOString();
  const completedAt = new Date(Date.parse(capturedAt) + 25).toISOString();
  const requestBody = options.requestBody ?? JSON.stringify({
    model: options.model ?? "fixture-model",
    input: options.input,
    conversation: options.conversationId,
    tools: options.tools
      ?? [{ type: "function", name: "registered_only", parameters: { type: "object" } }],
    ...options.params,
  });
  const responseBody = options.responseBody ?? JSON.stringify({
    id: `response-${options.sequence}`,
    object: "response",
    status: "completed",
    model: options.model ?? "fixture-model",
    output: options.output,
    usage: options.usage === null ? undefined : options.usage ?? {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens: 4,
      total_tokens: 14,
    },
  });
  const metadata = {
    session_id: options.omitSessionHeader ? undefined : "session-interleaved",
    thread_id: options.sessionOnly ? undefined : options.threadId,
    parent_thread_id: options.sessionOnly ? undefined : options.parentThreadId,
    thread_source: options.sessionOnly
      ? undefined
      : options.parentThreadId ? "subagent" : "user",
    turn_id: options.nativeTurnId,
    request_kind: "turn",
  };
  return {
    schemaVersion: 2,
    exchangeId: `${captureSessionId}:ex-${options.sequence}`,
    captureSessionId,
    sequence: options.sequence,
    capturedAt,
    completedAt,
    durationMs: 25,
    ...(options.firstTokenMs === undefined ? {} : {firstTokenMs: options.firstTokenMs}),
    routing: {
      targetId: "target-processor",
      targetName: "Processor Target",
      targetFormatHint: "openai",
      localUrl: "http://127.0.0.1:1234/v1/responses",
      upstreamUrl: "https://example.test/v1/responses",
      localPath: options.requestPath ?? "/v1/responses",
      upstreamPath: options.requestPath ?? "/v1/responses",
      method: "POST",
      agent: options.routingAgent,
      wireApi: options.wireApi,
      ...(options.routingOrigin ? {origin: options.routingOrigin} : {}),
      ...(options.routingClientCredentialId
        ? {clientCredentialId: options.routingClientCredentialId}
        : {}),
    },
    request: {
      headers: options.headers ?? {
        "user-agent": "codex-tui/fixture",
        ...(options.omitSessionHeader ? {} : { session_id: "session-interleaved" }),
        ...(options.sessionOnly ? {} : { thread_id: options.threadId }),
        "x-codex-turn-metadata": JSON.stringify(metadata),
      },
      rawBody: requestBody,
      bodySizeBytes: Buffer.byteLength(requestBody),
      // 真实 sha（与网关捕获一致）：重试折叠按请求体 SHA 判定字面重发，假 sha 会使
      // 该路径在测试中永不命中。
      bodySha256: createHash("sha256").update(requestBody, "utf8").digest("hex"),
    },
    response: {
      status: options.responseStatus ?? 200,
      statusText: "OK",
      headers: { "content-type": "application/json", ...options.responseHeaders },
      rawBody: responseBody,
      bodySizeBytes: Buffer.byteLength(responseBody),
      bodySha256: createHash("sha256").update(responseBody, "utf8").digest("hex"),
      isStreaming: false,
    },
    bodyStorage: { policy: "inline" },
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: false,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}

function readStoredContext(
  fixture: SqliteFixture,
  stepId: string,
): StoredArtifactEnvelope & {
  completeness: ArtifactCompletenessView;
  snapshot: {
    paramsHash: string;
    harnessPayload: { params: Record<string, unknown> };
  };
} {
  return JSON.parse(fixture.db.prepare(
    "SELECT summary_json FROM context_snapshots WHERE agent_step_id = ?",
  ).pluck().get(stepId) as string) as StoredArtifactEnvelope & {
    completeness: ArtifactCompletenessView;
    snapshot: {
      paramsHash: string;
      harnessPayload: { params: Record<string, unknown> };
    };
  };
}

function readStoredDiff(
  fixture: SqliteFixture,
  stepId: string,
): StoredArtifactEnvelope & { changedParams: unknown[] } {
  return JSON.parse(fixture.db.prepare(
    "SELECT diff_json FROM step_diffs WHERE agent_step_id = ?",
  ).pluck().get(stepId) as string) as StoredArtifactEnvelope & { changedParams: unknown[] };
}

function installSensitiveJsonStringifyGuard(marker: string): {
  readonly blockedCallCount: number;
  restore(): void;
} {
  const original = JSON.stringify;
  let blockedCallCount = 0;
  const guarded = ((...args: unknown[]) => {
    if (containsSensitiveMarker(args[0], marker, new Set())) {
      blockedCallCount += 1;
      throw new Error("JSON.stringify 不得接收包含敏感 params marker 的值。");
    }
    return Reflect.apply(original, JSON, args) as string | undefined;
  }) as typeof JSON.stringify;
  JSON.stringify = guarded;
  return {
    get blockedCallCount() {
      return blockedCallCount;
    },
    restore() {
      if (JSON.stringify === guarded) JSON.stringify = original;
    },
  };
}

function containsSensitiveMarker(
  value: unknown,
  marker: string,
  ancestors: Set<object>,
): boolean {
  if (typeof value === "string") return value.includes(marker);
  if (!value || typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.some(item => containsSensitiveMarker(item, marker, ancestors));
    }
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (key.includes(marker)
        || containsSensitiveMarker((value as Record<string, unknown>)[key], marker, ancestors)) {
        return true;
      }
    }
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function fixturePricingConfig(): PricingConfigV2 {
  return {
    version: 2,
    currency: "USD",
    unit: "per_million_tokens",
    models: [{
      id: "fixture-model",
      vendor: "FixtureVendor",
      patterns: ["fixture-model"],
      pricing: {
        input: 1,
        output: 2,
        cachedInput: 0.5,
        cacheWrite: 1.5,
      },
      confidence: "official",
    }],
    targetOverrides: [{
      id: "fixture-multiplier",
      targetId: "target-processor",
      patterns: ["fixture-model"],
      rateMultiplier: 2,
      confidence: "user_override",
    }],
  };
}

function responseMessage(text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

function chatResponseFixture(text: string): string {
  return JSON.stringify({
    id: `chatresp-${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12)}`,
    object: "chat.completion",
    model: "fixture",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

interface LearningSqlStepProbeRow {
  exchange_id: string;
  exchange_id_original_bytes?: number;
  timestamp: string;
  timestamp_original_bytes?: number;
  request_intent_label: string | null;
  request_intent_label_original_bytes?: number;
  response_status_label: string | null;
  response_status_label_original_bytes?: number;
}

interface LearningSqlToolProbeRow {
  agent_step_id: string;
  tool_use_id: string | null;
  tool_name: string;
  tool_use_id_original_bytes?: number;
  tool_name_original_bytes?: number;
}

function installLearningSqlProjectionProbe(fixture: SqliteFixture): {
  stepRows: LearningSqlStepProbeRow[];
  toolRows: LearningSqlToolProbeRow[];
  turnSql: string;
  restore(): void;
} {
  const result = {
    stepRows: [] as LearningSqlStepProbeRow[],
    toolRows: [] as LearningSqlToolProbeRow[],
    turnSql: "",
    restore() {},
  };
  const statementPrototype = Object.getPrototypeOf(fixture.db.prepare("SELECT 1")) as {
    all: (this: unknown, ...params: unknown[]) => unknown[];
    get: (this: unknown, ...params: unknown[]) => unknown;
  };
  const originalAll = statementPrototype.all;
  const originalGet = statementPrototype.get;
  statementPrototype.all = function(this: { source?: string }, ...params: unknown[]): unknown[] {
    const rows = Reflect.apply(originalAll, this, params) as unknown[];
    const source = this.source ?? "";
    if (source.includes("FROM agent_steps WHERE agent_turn_id = ?")) {
      result.stepRows.push(...rows as LearningSqlStepProbeRow[]);
    }
    if (source.includes("FROM tool_calls WHERE agent_turn_id = ?")) {
      result.toolRows.push(...rows as LearningSqlToolProbeRow[]);
    }
    return rows;
  };
  statementPrototype.get = function(this: { source?: string }, ...params: unknown[]): unknown {
    const row = Reflect.apply(originalGet, this, params) as unknown;
    const source = this.source ?? "";
    if (
      source.includes("substr(agent_session_id, 1, ?)")
      && source.includes("FROM agent_turns WHERE id = ?")
    ) {
      result.turnSql = source;
    }
    return row;
  };
  result.restore = () => {
    statementPrototype.all = originalAll;
    statementPrototype.get = originalGet;
  };
  return result;
}

function installArtifactProjectionProbe(): {
  operations: string[];
  restore(): void;
} {
  const operations: string[] = [];
  const originalMap = Array.prototype.map;
  const originalFilter = Array.prototype.filter;
  const originalStringify = JSON.stringify;
  const artifactStack = new RegExp([
    "buildObservedContextSnapshot|redactContextSnapshot|diffContextSnapshots",
    "encodeBoundedArtifact|projectCurrentContextSnapshot|projectStoredContextSnapshot",
    "projectHarnessPayload|projectStepDiff|projectLearningInsight",
    "encodeContextSnapshot|encodeProjectedArtifact",
  ].join("|"));

  Array.prototype.map = function(this: unknown[], ...args: unknown[]): unknown[] {
    const stack = new Error().stack ?? "";
    if (this.length >= 6_000 && artifactStack.test(stack)) {
      operations.push(`map:${this.length}`);
    }
    return Reflect.apply(originalMap, this, args) as unknown[];
  } as typeof Array.prototype.map;
  Array.prototype.filter = function(this: unknown[], ...args: unknown[]): unknown[] {
    const stack = new Error().stack ?? "";
    if (this.length >= 6_000 && artifactStack.test(stack)) {
      operations.push(`filter:${this.length}`);
    }
    return Reflect.apply(originalFilter, this, args) as unknown[];
  } as typeof Array.prototype.filter;
  JSON.stringify = function(value: unknown, ...args: unknown[]): string | undefined {
    if (isUnboundedArtifact(value)) {
      operations.push("stringify:unbounded-artifact");
    }
    return Reflect.apply(originalStringify, JSON, [value, ...args]) as string | undefined;
  } as typeof JSON.stringify;

  return {
    operations,
    restore() {
      Array.prototype.map = originalMap;
      Array.prototype.filter = originalFilter;
      JSON.stringify = originalStringify;
    },
  };
}

function isUnboundedArtifact(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const snapshot = record.snapshot as {
    harnessPayload?: { conversationItems?: unknown[] };
  } | undefined;
  if ((snapshot?.harnessPayload?.conversationItems?.length ?? 0) >= 6_000) {
    return true;
  }
  if (
    Array.isArray(record.addedMessages)
    && record.addedMessages.length >= 6_000
    && record.truncated === undefined
  ) {
    return true;
  }
  return Array.isArray(record.observations)
    && typeof record.copyableTemplate === "string"
    && record.truncated === undefined;
}

function turnsFor(
  fixture: SqliteFixture,
  threadId: string,
): Array<{ status: string; native_turn_id: string | null; segment_index: number }> {
  return fixture.db.prepare(
    `SELECT status, native_turn_id, segment_index
     FROM agent_turns WHERE agent_thread_id = ? ORDER BY segment_index`,
  ).all(threadId) as Array<{
    status: string;
    native_turn_id: string | null;
    segment_index: number;
  }>;
}

function stepIndexesFor(fixture: SqliteFixture, threadId: string): number[] {
  return fixture.db.prepare(
    `SELECT step_index FROM agent_steps
     WHERE agent_thread_id = ? ORDER BY timestamp, step_index`,
  ).pluck().all(threadId) as number[];
}

function scopeAggregate(
  fixture: SqliteFixture,
  scopeType: "session" | "thread" | "turn",
  scopeId: string,
): {
  step_request_count: number;
  auxiliary_request_count: number;
  tool_call_count: number;
} | undefined {
  return fixture.db.prepare(
    `SELECT step_request_count, auxiliary_request_count, tool_call_count
     FROM scope_aggregates WHERE scope_type = ? AND scope_id = ?`,
  ).get(scopeType, scopeId) as ReturnType<typeof scopeAggregate>;
}

function derivationTableSnapshot(fixture: SqliteFixture): Record<string, unknown> {
  const tables = [
    "raw_exchange_refs",
    "agent_sessions",
    "agent_threads",
    "thread_closure",
    "agent_turns",
    "agent_steps",
    "auxiliary_requests",
    "tool_calls",
    "usage_ledger",
    "scope_aggregates",
    "context_snapshots",
    "step_diffs",
    "learning_insights",
    "derivation_diagnostics",
  ];
  return Object.fromEntries(tables.map(table => [
    table,
    fixture.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}

function emptyDerivationTableSnapshot(): Record<string, unknown> {
  return Object.fromEntries([
    "raw_exchange_refs",
    "agent_sessions",
    "agent_threads",
    "thread_closure",
    "agent_turns",
    "agent_steps",
    "auxiliary_requests",
    "tool_calls",
    "usage_ledger",
    "scope_aggregates",
    "context_snapshots",
    "step_diffs",
    "learning_insights",
    "derivation_diagnostics",
  ].map(table => [table, []]));
}

function parentOf(fixture: SqliteFixture, threadId: string): string | null {
  return fixture.db.prepare(
    "SELECT parent_agent_thread_id FROM agent_threads WHERE id = ?",
  ).pluck().get(threadId) as string | null;
}

function diagnosticByCode(
  fixture: SqliteFixture,
  code: string,
): {
  code: string;
  severity: string;
  details_json: string;
  created_at: string;
} | undefined {
  return fixture.db.prepare(
    `SELECT code, severity, details_json, created_at
     FROM derivation_diagnostics WHERE code = ?`,
  ).get(code) as {
    code: string;
    severity: string;
    details_json: string;
    created_at: string;
  } | undefined;
}

/**
 * 读取存储中的 context snapshot：v29 起 harnessPayload 为紧凑形态，
 * 统一经读侧入口展开，保证测试断言与生产读取路径一致。
 */
function parseStoredContext(json: string): Record<string, unknown> {
  const envelope = JSON.parse(json) as Record<string, unknown>;
  if (envelope.snapshot && typeof envelope.snapshot === "object" && !Array.isArray(envelope.snapshot)) {
    envelope.snapshot = normalizeStoredContextSnapshot(
      envelope.snapshot as Record<string, unknown>,
    );
  }
  return envelope;
}

function diagnosticMessageAndDetails(
  fixture: SqliteFixture,
  code: string,
): { message: string; details_json: string } | undefined {
  return fixture.db.prepare(
    `SELECT message, details_json
     FROM derivation_diagnostics WHERE code = ?`,
  ).get(code) as { message: string; details_json: string } | undefined;
}

function diagnosticCount(fixture: SqliteFixture): number {
  return fixture.db.prepare(
    "SELECT COUNT(*) FROM derivation_diagnostics",
  ).pluck().get() as number;
}

function queryPlanDetails(
  fixture: SqliteFixture,
  sql: string,
  ...parameters: unknown[]
): string[] {
  return fixture.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters)
    .map((row) => (row as { detail: string }).detail);
}

function compareClosureRows(
  left: { ancestor_thread_id: string; descendant_thread_id: string },
  right: { ancestor_thread_id: string; descendant_thread_id: string },
): number {
  if (left.ancestor_thread_id !== right.ancestor_thread_id) {
    return left.ancestor_thread_id < right.ancestor_thread_id ? -1 : 1;
  }
  if (left.descendant_thread_id === right.descendant_thread_id) return 0;
  return left.descendant_thread_id < right.descendant_thread_id ? -1 : 1;
}

function insertDirtyThread(
  fixture: SqliteFixture,
  options: {
    id: string;
    parentId?: string;
    isRoot?: boolean;
    displayName: string;
    modelSetJson?: string;
  },
): void {
  fixture.db.prepare(
    `INSERT INTO agent_threads(
      id, agent_session_id, parent_agent_thread_id, source, display_name,
      confidence, is_root, start_time, end_time, model_set_json
    ) VALUES(?, 'session-1', ?, 'dirty-fixture', ?, 'high', ?, ?, ?, ?)`,
  ).run(
    options.id,
    options.parentId ?? null,
    options.displayName,
    options.isRoot === true ? 1 : 0,
    BASE_TIME,
    BASE_TIME,
    options.modelSetJson ?? "[]",
  );
  fixture.db.prepare(
    `INSERT INTO thread_closure(
      ancestor_thread_id, descendant_thread_id, depth
    ) VALUES(?, ?, 0)`,
  ).run(options.id, options.id);
  if (options.parentId) {
    fixture.db.prepare(
      `INSERT INTO thread_closure(
        ancestor_thread_id, descendant_thread_id, depth
      ) VALUES(?, ?, 1)`,
    ).run(options.parentId, options.id);
  }
}

/** 派生物读取 helper：兼容 inline/external 双策略（P1-6）。 */
function storedArtifactText(
  db: import("../src/lib/db/sqlite-driver.js").DeepaaDatabase,
  dataDir: string,
  table: "context_snapshots" | "step_diffs",
  stepId: string,
): string {
  const column = table === "context_snapshots" ? "summary_json" : "diff_json";
  const row = db.prepare(
    `SELECT ${column} AS json, artifact_storage, artifact_hash
     FROM ${table} WHERE agent_step_id = ?`,
  ).get(stepId) as {
    json: string;
    artifact_storage: string | null;
    artifact_hash: string | null;
  };
  const text = resolveDerivedArtifactJson(dataDir, {
    artifact_storage: row.artifact_storage,
    artifact_hash: row.artifact_hash,
    inline_json: row.json,
  });
  assert.ok(text, `${table} 派生物应可解析（stepId=${stepId}）`);
  return text;
}
