import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resetDeepaaData } from "../src/lib/data-reset";
import { SCHEMA_VERSION } from "../src/lib/db/schema";
import {
  deepaaDatabasePath,
  openDeepaaDatabase,
} from "../src/lib/db/connection";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map(root =>
    rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("运行数据重置", () => {
  test("只归档 SQLite、v2 raw 和 blob，保留配置并按当前 schema 初始化", async () => {
    const dataDir = await createResetFixture();
    const preserved = await readPreservedFiles(dataDir);

    const result = await resetDeepaaData({
      dataDir,
      now: () => new Date("2026-07-28T06:00:00.000Z"),
    });

    expect(result.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.archivedPaths).toEqual([
      "deepaa.sqlite",
      "deepaa.sqlite-wal",
      "deepaa.sqlite-shm",
      "captures/v2",
      "blobs",
    ]);
    expect(await readPreservedFiles(dataDir)).toEqual(preserved);
    expect(await readdir(join(dataDir, "captures", "v2"))).toEqual([]);
    expect(await readdir(join(dataDir, "blobs"))).toEqual([]);
    expect(await readFile(
      join(result.backupDir, "captures", "v2", "capture.jsonl"),
      "utf8",
    )).toBe("raw-history\n");
    expect(await readFile(
      join(result.backupDir, "blobs", "body.bin"),
      "utf8",
    )).toBe("blob-history");
    expect(await readFile(
      join(result.backupDir, "deepaa.sqlite-wal"),
      "utf8",
    )).toBe("legacy-wal");

    const db = new DeepaaDatabase(deepaaDatabasePath(dataDir), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      expect(tableColumns(db, "raw_exchange_refs")).toContain("wire_api");
      expect(tableColumns(db, "agent_steps"))
        .toEqual(expect.arrayContaining([
          "native_step_id",
          "identity_source",
          "identity_confidence",
        ]));
      expect(tableColumns(db, "exchange_content_filter_status"))
        .toContain("request_comparison_kind");
      expect(tableColumns(db, "exchange_request_fingerprints"))
        .toEqual(expect.arrayContaining(["body_side", "provider_lineage_key"]));
      expect(tableColumns(db, "exchange_content_category_stats"))
        .toContain("body_side");
    } finally {
      db.close();
    }
  });

  test("存在有效 Worker 租约时拒绝重置且不移动数据", async () => {
    const dataDir = await createResetFixture();
    const db = openDeepaaDatabase({ dataDir });
    db.prepare(
      `INSERT INTO worker_lease(id, owner_id, expires_at)
       VALUES(1, 'active-worker', '2099-01-01T00:00:00.000Z')`,
    ).run();
    db.close();

    await expect(resetDeepaaData({ dataDir }))
      .rejects.toThrow(/Worker.*运行|有效租约/u);
    expect(await readFile(
      join(dataDir, "captures", "v2", "capture.jsonl"),
      "utf8",
    )).toBe("raw-history\n");
    expect(await readFile(deepaaDatabasePath(dataDir))).not.toHaveLength(0);
  });

  test("重置目标路径包含符号链接时拒绝且不触碰外部目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepaa-reset-link-"));
    roots.add(root);
    const dataDir = join(root, "data");
    const external = join(root, "external");
    await Promise.all([
      mkdir(join(dataDir, "captures"), { recursive: true }),
      mkdir(external, { recursive: true }),
    ]);
    await writeFile(join(external, "capture.jsonl"), "outside\n", "utf8");
    await symlink(external, join(dataDir, "captures", "v2"), "dir");

    await expect(resetDeepaaData({ dataDir }))
      .rejects.toThrow(/符号链接|实际目录/u);
    expect(await readFile(join(external, "capture.jsonl"), "utf8"))
      .toBe("outside\n");
  });

  test("新库初始化失败时恢复全部活动数据", async () => {
    const dataDir = await createResetFixture();

    await expect(resetDeepaaData({
      dataDir,
      initializeDatabase: () => {
        throw new Error("fixture initialization failed");
      },
    })).rejects.toThrow("fixture initialization failed");

    expect(await readFile(
      join(dataDir, "captures", "v2", "capture.jsonl"),
      "utf8",
    )).toBe("raw-history\n");
    expect(await readFile(join(dataDir, "blobs", "body.bin"), "utf8"))
      .toBe("blob-history");
    expect(await readFile(join(dataDir, "deepaa.sqlite-wal"), "utf8"))
      .toBe("legacy-wal");
    const db = new DeepaaDatabase(deepaaDatabasePath(dataDir), {
      readonly: true,
      fileMustExist: true,
    });
    db.close();
  });
});

async function createResetFixture(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "deepaa-reset-"));
  roots.add(dataDir);
  await Promise.all([
    mkdir(join(dataDir, "config"), { recursive: true }),
    mkdir(join(dataDir, "defaults"), { recursive: true }),
    mkdir(join(dataDir, "captures", "v2"), { recursive: true }),
    mkdir(join(dataDir, "blobs"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(dataDir, "proxy-config.json"), "proxy-config", "utf8"),
    writeFile(join(dataDir, "proxy-routing-status.json"), "routing-status", "utf8"),
    writeFile(join(dataDir, "config", "model-pricing.json"), "pricing", "utf8"),
    writeFile(
      join(dataDir, "config", "development-credentials.json"),
      "credentials-metadata",
      "utf8",
    ),
    writeFile(join(dataDir, "defaults", "prices.json"), "defaults", "utf8"),
    writeFile(
      join(dataDir, "captures", "v2", "capture.jsonl"),
      "raw-history\n",
      "utf8",
    ),
    writeFile(join(dataDir, "blobs", "body.bin"), "blob-history", "utf8"),
  ]);
  openDeepaaDatabase({ dataDir }).close();
  await Promise.all([
    writeFile(join(dataDir, "deepaa.sqlite-wal"), "legacy-wal", "utf8"),
    writeFile(join(dataDir, "deepaa.sqlite-shm"), "legacy-shm", "utf8"),
  ]);
  return dataDir;
}

async function readPreservedFiles(dataDir: string): Promise<Record<string, string>> {
  const paths = [
    "proxy-config.json",
    "proxy-routing-status.json",
    "config/model-pricing.json",
    "config/development-credentials.json",
    "defaults/prices.json",
  ];
  return Object.fromEntries(await Promise.all(paths.map(async path => [
    path,
    await readFile(join(dataDir, path), "utf8"),
  ])));
}

function tableColumns(db: DeepaaDatabase, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>)
    .map(column => column.name);
}
