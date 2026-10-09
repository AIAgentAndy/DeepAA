import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { openDeepaaDatabase } from "../../src/lib/db/connection.js";

export interface SqliteFixture {
  dataDir: string;
  db: DeepaaDatabase;
  writeV2Lines: (records: unknown[], fileName?: string) => Promise<string>;
  appendRaw: (filePath: string, content: string | Uint8Array) => Promise<void>;
  cleanup: () => Promise<void>;
}

export interface CreateSqliteFixtureOptions {
  dataDirSymlink?: boolean;
}

/**
 * 为数据库测试创建完全隔离的临时目录，避免任何测试读取或修改真实 data 目录。
 */
export async function createSqliteFixture(
  options: CreateSqliteFixtureOptions = {},
): Promise<SqliteFixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "deepaa-sqlite-"));
  let dataDir = fixtureRoot;
  if (options.dataDirSymlink === true) {
    const realDataDir = join(fixtureRoot, "real-data");
    dataDir = join(fixtureRoot, "configured-data");
    await mkdir(realDataDir);
    await symlink(realDataDir, dataDir, "dir");
  }
  const db = openDeepaaDatabase({ dataDir });
  // 30 天投影窗口（docs/上线前架构升级改造.md P0-4）会让固定历史日期的夹具被
  // archived；测试夹具统一写入最大允许窗口（180 天），窗口行为由专项测试单独覆盖。
  await mkdir(join(dataDir, "config"), { recursive: true });
  await writeFile(
    join(dataDir, "config", "retention.json"),
    JSON.stringify({version: 1, rawRetentionDays: 180}) + "\n",
    "utf8",
  );

  return {
    dataDir,
    db,
    writeV2Lines: async (records, fileName = "capture-v2-test.jsonl") => {
      const captureDir = join(dataDir, "captures", "v2");
      await mkdir(captureDir, { recursive: true });
      const filePath = join(captureDir, fileName);
      const content = records.length === 0
        ? ""
        : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
      await writeFile(filePath, content);
      return filePath;
    },
    appendRaw: async (filePath, content) => {
      await appendFile(filePath, content);
    },
    cleanup: async () => {
      if (db.open) {
        db.close();
      }
      await rm(fixtureRoot, { recursive: true, force: true });
    },
  };
}

/** 创建未经迁移的真实 v0 数据库，用于验证迁移失败的原子回滚。 */
export async function createUnmigratedSqliteFixture(): Promise<SqliteFixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "deepaa-sqlite-v0-"));
  const db = new DeepaaDatabase(join(dataDir, "deepaa.sqlite"));

  return {
    dataDir,
    db,
    writeV2Lines: async () => {
      throw new Error("未经迁移的 SQLite fixture 不支持 v2 raw 文件。");
    },
    appendRaw: async () => {
      throw new Error("未经迁移的 SQLite fixture 不支持 v2 raw 文件。");
    },
    cleanup: async () => {
      if (db.open) {
        db.close();
      }
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
