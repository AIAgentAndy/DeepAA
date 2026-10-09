/**
 * D2 候选下推（2026-10-05 用户确认）+ D3 批内尾窗去重 单元测试：
 * 临时 zcode cli 目录 + 临时 DeepAA 数据目录（绝不触碰真实 ~/.zcode 与 ~/.deepaa）。
 *
 * D2 核心断言：readPendingBatch 的两条执行路径（pushdown 跨库下推 / chunked 分块
 * 键集）与旧路径（readPendingCandidates 全量 + seen JS 过滤切片）**逐条等价**——
 * 同一候选集合、同一顺序（会话最新活动倒序 + 会话内完成时间正序）、同一幂等反联；
 * LIMIT 有界。任何路径偏差都会在等价断言上暴露。
 */

import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {createZcodeLocalSourceAdapter} from "../src/lib/agent-local-source/adapters/zcode";
import {pruneAgentLocalImportSeen} from "../src/lib/agent-local-source/state-store";

const LOOKBACK_MARGIN = 5 * 24 * 60 * 60 * 1000;

const rootDir = await mkdtemp(join(tmpdir(), "deepaa-candidate-pushdown-"));
const zcodeCliDir = join(rootDir, "zcode-cli");
const dataDir = join(rootDir, "data");
let zcodeDb: DeepaaDatabase;
let deepaaDb: DeepaaDatabase;
let nowMs: number;

const PROVIDER_OK = "builtin:bigmodel-coding-plan";
const MODEL = "GLM-5.3-Flash";

function insertUsage(id: string, sessionId: string, completedAt: number, providerId = PROVIDER_OK): void {
  zcodeDb.prepare(
    `INSERT INTO model_usage(id, session_id, provider_id, model_id, status, started_at, completed_at, input_tokens, output_tokens)
     VALUES(?, ?, ?, ?, 'completed', ?, ?, 10, 1)`,
  ).run(id, sessionId, providerId, MODEL, completedAt - 6_000, completedAt);
}

function insertSeen(exchangeId: string, importedAtIso: string): void {
  deepaaDb.prepare(
    "INSERT INTO agent_local_import_seen(exchange_id, imported_at) VALUES(?, ?)",
  ).run(exchangeId, importedAtIso);
}

/** 旧路径的精确复刻（scheduler legacy 分支同构）：全量候选 + seen JS 过滤 + 切片。 */
function legacyPendingBatch(adapter: ReturnType<typeof createZcodeLocalSourceAdapter>, floor: number, limit: number) {
  const seenRows = deepaaDb.prepare("SELECT exchange_id FROM agent_local_import_seen").all() as Array<{exchange_id: string}>;
  const prefix = "import-zcode-";
  const seenIds = new Set(seenRows.map(row =>
    row.exchange_id.startsWith(prefix) ? row.exchange_id.slice(prefix.length) : row.exchange_id));
  const pending = adapter.readPendingCandidates(floor, new Set(["glm-5.3-flash"]))
    .filter(candidate => !seenIds.has(candidate.id));
  return pending.slice(0, limit);
}

beforeAll(async () => {
  await mkdir(join(zcodeCliDir, "db"), {recursive: true});
  await mkdir(join(zcodeCliDir, "rollout"), {recursive: true});
  await mkdir(dataDir, {recursive: true});
  zcodeDb = new DeepaaDatabase(join(zcodeCliDir, "db", "db.sqlite"));
  zcodeDb.exec(`
    CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT, app_version TEXT, time_applied INTEGER);
    INSERT INTO schema_migration VALUES ('0001_init', 'hash', '0.16.5', 1);
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY, session_id TEXT, provider_id TEXT, model_id TEXT, status TEXT,
      started_at INTEGER, completed_at INTEGER, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0
    );
  `);
  deepaaDb = new DeepaaDatabase(join(dataDir, "deepaa.sqlite"));
  deepaaDb.pragma("journal_mode = WAL");
  deepaaDb.exec(
    "CREATE TABLE agent_local_import_seen(exchange_id TEXT PRIMARY KEY, imported_at TEXT)",
  );
  nowMs = Date.now();

  // 会话新鲜度排序夹具（时间轴刻意交错，防止「按全局完成时间排序」的错误实现蒙混）：
  //   sess-old：窗口内 3 条（最早），全部已导入（seen）→ 不出候选
  //   sess-mid：4 条，其中 2 条已导入
  //   sess-new：最新活动 → 必须排最前；会话内正序
  //   sess-gw：网关标记行 → 候选查询即排除
  const day = 24 * 60 * 60 * 1000;
  insertUsage("old-1", "sess-old", nowMs - 20 * day);
  insertUsage("old-2", "sess-old", nowMs - 20 * day + 1_000);
  insertUsage("old-3", "sess-old", nowMs - 20 * day + 2_000);
  insertUsage("mid-1", "sess-mid", nowMs - 10 * day);
  insertUsage("mid-2", "sess-mid", nowMs - 10 * day + 1_000);
  insertUsage("mid-3", "sess-mid", nowMs - 2 * day);
  insertUsage("mid-4", "sess-mid", nowMs - 2 * day + 1_000);
  insertUsage("new-1", "sess-new", nowMs - 1_000);
  insertUsage("new-2", "sess-new", nowMs - 500);
  insertUsage("gw-1", "sess-gw", nowMs - 100, "deepaa-gateway");

  const importedIso = new Date(nowMs).toISOString();
  for (const id of ["old-1", "old-2", "old-3", "mid-1", "mid-3"]) {
    insertSeen(`import-zcode-${id}`, importedIso);
  }
  // 防御分支：旧形态裸 id seen 行（历史前缀剥离语义）也必须反联命中。
  insertSeen("mid-2", importedIso);
});

afterAll(async () => {
  zcodeDb?.close();
  deepaaDb?.close();
  await rm(rootDir, {recursive: true, force: true});
});

describe("D2 候选下推：pushdown / chunked 与旧路径逐条等价", () => {
  const factoryOptions = [
    {mode: "auto", expectMode: "pushdown"},
    {mode: "chunked", expectMode: "chunked"},
  ] as const;

  for (const {mode, expectMode} of factoryOptions) {
    test(`${expectMode} 路径与旧路径（全量 + JS 过滤切片）完全等价`, () => {
      const adapter = createZcodeLocalSourceAdapter({cliDir: zcodeCliDir, candidateQueryMode: mode});
      const floor = nowMs - 30 * 24 * 60 * 60 * 1000;
      const result = adapter.readPendingBatch!({
        dataDir,
        floorEpochMs: floor,
        allowedModels: new Set(["glm-5.3-flash"]),
        seenExchangeIdPrefix: "import-zcode-",
        limit: 15,
      });
      expect(result.mode).toBe(expectMode);
      const legacy = legacyPendingBatch(adapter, floor, 15);
      expect(result.records).toEqual(legacy);
      // 期望顺序：sess-new（最新活动）内正序 → sess-mid 剩余内正序（mid-2 被裸 id
      // 防御 seen 行反联排除，三条路径一致）；old-* 全 seen、gw-* 网关标记排除。
      expect(result.records.map(record => record.id)).toEqual(["new-1", "new-2", "mid-4"]);
    });
  }

  test("pushdown 与 chunked 两条路径互为等价（同一夹具独立对比）", () => {
    const auto = createZcodeLocalSourceAdapter({cliDir: zcodeCliDir});
    const chunked = createZcodeLocalSourceAdapter({cliDir: zcodeCliDir, candidateQueryMode: "chunked"});
    const floor = nowMs - 30 * 24 * 60 * 60 * 1000;
    const query = {
      dataDir,
      floorEpochMs: floor,
      allowedModels: new Set(["glm-5.3-flash"]),
      seenExchangeIdPrefix: "import-zcode-",
      limit: 15,
    };
    expect(auto.readPendingBatch!(query).records)
      .toEqual(chunked.readPendingBatch!(query).records);
  });

  test("LIMIT 有界：超过 15 条待导入时两条路径都只取 15 条且顺序一致", () => {
    // 再插两个活跃会话把待导入总数抬到 15+。
    insertUsage("bulk-a-1", "sess-bulk-a", nowMs + 10_000);
    insertUsage("bulk-a-2", "sess-bulk-a", nowMs + 11_000);
    insertUsage("bulk-b-1", "sess-bulk-b", nowMs + 20_000);
    insertUsage("bulk-b-2", "sess-bulk-b", nowMs + 21_000);
    insertUsage("bulk-c-1", "sess-bulk-c", nowMs + 30_000);
    insertUsage("bulk-c-2", "sess-bulk-c", nowMs + 31_000);
    insertUsage("bulk-d-1", "sess-bulk-d", nowMs + 40_000);
    insertUsage("bulk-d-2", "sess-bulk-d", nowMs + 41_000);
    insertUsage("bulk-e-1", "sess-bulk-e", nowMs + 50_000);
    insertUsage("bulk-e-2", "sess-bulk-e", nowMs + 51_000);
    insertUsage("bulk-f-1", "sess-bulk-f", nowMs + 60_000);
    insertUsage("bulk-f-2", "sess-bulk-f", nowMs + 61_000);
    insertUsage("bulk-g-1", "sess-bulk-g", nowMs + 70_000);
    insertUsage("bulk-g-2", "sess-bulk-g", nowMs + 71_000);
    insertUsage("bulk-h-1", "sess-bulk-h", nowMs + 80_000);
    insertUsage("bulk-h-2", "sess-bulk-h", nowMs + 81_000);

    const floor = nowMs - 30 * 24 * 60 * 60 * 1000;
    const query = {
      dataDir,
      floorEpochMs: floor,
      allowedModels: new Set(["glm-5.3-flash"]),
      seenExchangeIdPrefix: "import-zcode-",
      limit: 15,
    };
    const auto = createZcodeLocalSourceAdapter({cliDir: zcodeCliDir});
    const chunked = createZcodeLocalSourceAdapter({cliDir: zcodeCliDir, candidateQueryMode: "chunked"});
    const pushed = auto.readPendingBatch!(query);
    const chunkedResult = chunked.readPendingBatch!(query);
    expect(pushed.records).toHaveLength(15);
    expect(pushed.records).toEqual(chunkedResult.records);
    expect(pushed.records).toEqual(legacyPendingBatch(auto, floor, 15));
  });

  test("窗口下界（floor）排除窗口外候选", () => {
    const adapter = createZcodeLocalSourceAdapter({cliDir: zcodeCliDir});
    const result = adapter.readPendingBatch!({
      dataDir,
      floorEpochMs: nowMs, // 全部历史行出窗
      allowedModels: new Set(["glm-5.3-flash"]),
      seenExchangeIdPrefix: "import-zcode-",
      limit: 15,
    });
    expect(result.records.every(record => record.completedAt >= nowMs)).toBe(true);
  });

  test("deepaa.sqlite 缺失时抛错（绝不静默视为空 seen 集——幂等安全优先，调度层兜底重试）", async () => {
    const emptyDir = join(rootDir, "empty-data");
    await mkdir(emptyDir, {recursive: true});
    const adapter = createZcodeLocalSourceAdapter({cliDir: zcodeCliDir});
    // pushdown 打不开 seen 库 → 返回 undefined 落 chunked；chunked 同样打不开 → 抛错。
    // 调度器保证调用前 deepaa.sqlite 必已建库（openDeepaaDatabase 先行），此场景
    // 仅直连调用可见；语义上「seen 不可读」必须失败而不是当作无已导入记录。
    expect(() => adapter.readPendingBatch!({
      dataDir: emptyDir,
      floorEpochMs: nowMs - 30 * 24 * 60 * 60 * 1000,
      allowedModels: new Set(["glm-5.3-flash"]),
      seenExchangeIdPrefix: "import-zcode-",
      limit: 15,
    })).toThrow();
  });
});

describe("D2 seen 表有界清理", () => {
  test("只删窗口+余量之外的行；单次删除有界", () => {
    const cutoff = new Date(nowMs - 30 * 24 * 60 * 60 * 1000 - LOOKBACK_MARGIN).toISOString();
    // 夹具已迁移 nowMs 时刻的行（保留）；补 3 行过期 + 2 行边界内。
    insertSeen("import-zcode-stale-1", new Date(Date.parse(cutoff) - 10_000).toISOString());
    insertSeen("import-zcode-stale-2", new Date(Date.parse(cutoff) - 5_000).toISOString());
    insertSeen("import-zcode-stale-3", new Date(Date.parse(cutoff) - 1).toISOString());
    insertSeen("import-zcode-fresh-1", new Date(Date.parse(cutoff) + 1).toISOString());
    insertSeen("import-zcode-fresh-2", new Date(nowMs + 1_000).toISOString());
    const removed = pruneAgentLocalImportSeen(deepaaDb, {nowMs});
    expect(removed).toBe(3);
    const remaining = deepaaDb.prepare(
      "SELECT exchange_id FROM agent_local_import_seen ORDER BY exchange_id",
    ).all().map(row => row.exchange_id);
    expect(remaining).not.toContain("import-zcode-stale-1");
    expect(remaining).not.toContain("import-zcode-stale-2");
    expect(remaining).not.toContain("import-zcode-stale-3");
    expect(remaining).toContain("import-zcode-fresh-1");
    expect(remaining).toContain("import-zcode-fresh-2");
    expect(remaining).toContain("import-zcode-old-1");
  });

  test("maxRows 限制单次删除量（残留下一轮继续）", () => {
    for (let i = 0; i < 5; i += 1) {
      insertSeen(`import-zcode-bulk-stale-${i}`, new Date(nowMs - 60 * 24 * 60 * 60 * 1000).toISOString());
    }
    const first = pruneAgentLocalImportSeen(deepaaDb, {nowMs, maxRows: 2});
    expect(first).toBe(2);
    const second = pruneAgentLocalImportSeen(deepaaDb, {nowMs, maxRows: 2});
    expect(second).toBe(2);
    const third = pruneAgentLocalImportSeen(deepaaDb, {nowMs, maxRows: 2});
    expect(third).toBe(1);
    expect(pruneAgentLocalImportSeen(deepaaDb, {nowMs, maxRows: 2})).toBe(0);
  });
});

describe("D3 批内 rollout 尾窗去重", () => {
  const rolloutRecord = (requestId: string, turnId: string, startedAtMs: number) => JSON.stringify({
    requestId,
    sessionId: "sess-roll",
    turnId,
    startedAt: new Date(startedAtMs).toISOString(),
    request: {body: {model: MODEL, system: "SYS", messages: []}},
    response: {finishReason: "stop", text: `answer-${requestId}`, responseId: `resp-${requestId}`},
  });

  beforeAll(async () => {
    const lines = [
      rolloutRecord("req-r1", "turn-r1", nowMs - 100_000),
      rolloutRecord("req-r2", "turn-r2", nowMs - 80_000),
      rolloutRecord("req-r3", "turn-r3", nowMs - 60_000),
      "",
      rolloutRecord("req-r4", "turn-r4", nowMs - 40_000),
    ];
    await writeFile(join(zcodeCliDir, "rollout", "model-io-sess-roll.jsonl"), `${lines.join("\n")}\n`);
  });

  test("骨架清扫 + 逐条正文读取共享一次尾窗读取，结果与无缓存一致", async () => {
    const adapter = createZcodeLocalSourceAdapter({cliDir: zcodeCliDir});
    const cache = adapter.createRolloutCache!() as {windowReads: number};

    const recent = await adapter.readRecentRecords!("sess-roll", cache);
    expect(recent).toHaveLength(4); // 4 条非空记录（空行跳过），尾部 200 条上限内

    const ref = {sessionId: "sess-roll", turnId: "turn-r3", startedAt: nowMs - 60_000};
    const withCache = await adapter.readExchangeDetail(ref, cache);
    const withoutCache = await adapter.readExchangeDetail(ref);
    expect(withCache?.response?.text).toBe("answer-req-r3");
    expect(withCache).toEqual(withoutCache); // 缓存路径结果与独立读取完全一致

    // 再读两条（同批语义）：仍只有 1 次真实文件读取。
    await adapter.readExchangeDetail({sessionId: "sess-roll", turnId: "turn-r2", startedAt: nowMs - 80_000}, cache);
    await adapter.readExchangeDetail({sessionId: "sess-roll", turnId: "turn-r1", startedAt: nowMs - 100_000}, cache);
    expect(cache.windowReads).toBe(1);
  });

  test("requestId 精确命中与文件缺失缓存（缺失也只探测一次）", async () => {
    const adapter = createZcodeLocalSourceAdapter({cliDir: zcodeCliDir});
    const cache = adapter.createRolloutCache!() as {windowReads: number};
    const hit = await adapter.readExchangeDetail({sessionId: "sess-roll", requestId: "req-r4"}, cache);
    expect(hit?.response?.text).toBe("answer-req-r4");

    const miss1 = await adapter.readExchangeDetail({sessionId: "sess-missing"}, cache);
    const miss2 = await adapter.readExchangeDetail({sessionId: "sess-missing"}, cache);
    expect(miss1).toBeUndefined();
    expect(miss2).toBeUndefined();
    expect(cache.windowReads).toBe(2); // 真实文件 1 次 + 缺失探测 1 次（缺失已缓存，不重复 stat）
  });
});
