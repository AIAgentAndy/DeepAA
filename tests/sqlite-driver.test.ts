/**
 * sqlite-driver 兼容层测试（2026-10-08 better-sqlite3 → node:sqlite 切换）：
 * 锁定 better-sqlite3 兼容语义与 node:sqlite 实测能力边界；全部落盘在
 * vitest 临时沙箱，绝不触碰真实 ~/.deepaa。
 */

import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {DeepaaDatabase} from "../src/lib/db/sqlite-driver";

const sandbox = await mkdtemp(join(tmpdir(), "deepaa-sqlite-driver-"));

beforeAll(async () => {
  await DeepaaDatabase; // 触发模块加载（含 ExperimentalWarning 只打一次）
});

afterAll(async () => {
  await rm(sandbox, {recursive: true, force: true});
});

describe("基础 API 兼容", () => {
  const db = new DeepaaDatabase(":memory:");

  test("位置参数与命名参数（裸键名绑定 :name）", () => {
    db.exec("CREATE TABLE t(a TEXT, b INTEGER)");
    db.prepare("INSERT INTO t(a, b) VALUES(:a, :b)").run({a: "x", b: 1});
    db.prepare("INSERT INTO t(a, b) VALUES(?, ?)").run("y", 2);
    expect(db.prepare("SELECT b FROM t WHERE a=:a").get({a: "x"})).toEqual({b: 1});
    expect(db.prepare("SELECT COUNT(*) c FROM t").get()).toEqual({c: 2});
  });

  test("run() 返回 {changes, lastInsertRowid}", () => {
    const result = db.prepare("INSERT INTO t(a, b) VALUES(?, ?)").run("z", 3);
    expect(result.changes).toBe(1);
    expect(result.lastInsertRowid).toBe(3);
  });

  test("get 无行返回 undefined；all 空返回 []", () => {
    expect(db.prepare("SELECT 1 WHERE 0").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 WHERE 0").all()).toEqual([]);
  });

  test("pluck()：get/all/iterate 取首列值", () => {
    expect(db.prepare("SELECT b FROM t WHERE a=?").pluck().get("x")).toBe(1);
    expect(db.prepare("SELECT a FROM t ORDER BY b").pluck().all()).toEqual(["x", "y", "z"]);
    const iterated: unknown[] = [];
    for (const value of db.prepare("SELECT a FROM t ORDER BY b").pluck().iterate()) {
      iterated.push(value);
    }
    expect(iterated).toEqual(["x", "y", "z"]);
  });

  test("窗口函数（zcode 推送下压依赖）", () => {
    const rows = db.prepare(
      "SELECT b, MAX(b) OVER (ORDER BY a) m FROM t ORDER BY b",
    ).all() as Array<{b: number; m: number}>;
    expect(rows.map(row => row.m)).toEqual([1, 2, 3]);
  });

  test("exec 返回 this 可链式", () => {
    expect(db.exec("SELECT 1")).toBe(db);
  });

  test("绑定对象的多余键被容忍（better-sqlite3 语义；条件拼 SQL 场景）", () => {
    // SQL 只引用 :a，但对象带多余键——better-sqlite3 忽略、node:sqlite 原生拒绝。
    expect(db.prepare("SELECT :a v").get({a: 7, credentialId: 1, targetId: 2})).toEqual({v: 7});
    expect(db.prepare("SELECT :a v").run({a: 7, unused: 0}).changes).toBe(1);
    // 注：缺失必需键时 node:sqlite 绑定 NULL 而非抛错（better-sqlite3 抛
    // "Missing named parameter"）——调用方恒传超集对象，不依赖该差异。
  });
});

describe("pragma 语义（better-sqlite3 兼容）", () => {
  const db = new DeepaaDatabase(":memory:");

  test("simple 读取返回首列标量；user_version / freelist_count", () => {
    db.exec("PRAGMA user_version = 42");
    expect(db.pragma("user_version", {simple: true})).toBe(42);
    expect(db.pragma("freelist_count", {simple: true})).toBe(0);
  });

  test("赋值形式执行并返回 undefined；多行读取返回行数组（table_info）；0 行返回 []；单行单列返回标量", () => {
    expect(db.pragma("busy_timeout = 5000")).toBeUndefined();
    expect(db.pragma("busy_timeout", {simple: true})).toBe(5000);
    db.exec("CREATE TABLE tt(x INTEGER PRIMARY KEY, y TEXT)");
    const info = db.pragma("table_info(tt)") as Array<{name: string}>;
    expect(info.map(column => column.name)).toEqual(["x", "y"]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    // better-sqlite3 语义：单行单列非 simple 读取返回标量。
    expect(db.pragma("busy_timeout")).toBe(5000);
  });

  test("单行单列非 simple 读取返回标量（better-sqlite3 语义；:memory: 默认 journal）", () => {
    expect(db.pragma("journal_mode")).toBe("memory");
  });
});

describe("transaction 语义", () => {
  const db = new DeepaaDatabase(":memory:");

  test("提交：函数返回值透传；inTransaction 状态", () => {
    db.exec("CREATE TABLE tx(v INTEGER)");
    const write = db.transaction((value: number) => {
      db.prepare("INSERT INTO tx(v) VALUES(?)").run(value);
      return value * 2;
    });
    expect(write(21)).toBe(42);
    expect(db.prepare("SELECT COUNT(*) c FROM tx").get()).toEqual({c: 1});
  });

  test("回滚：抛错重抛且写入不落库", () => {
    const fail = db.transaction(() => {
      db.prepare("INSERT INTO tx(v) VALUES(?)").run(99);
      throw new Error("boom");
    });
    expect(() => fail()).toThrow("boom");
    expect(db.prepare("SELECT COUNT(*) c FROM tx").get()).toEqual({c: 1});
    expect(db.inTransaction).toBe(false);
  });

  test("提交失败不僵尸化、不覆盖原始错误（2026-10-08 Claude 审核修复：延迟外键违例在 COMMIT 时刻确定性复现）", () => {
    const path = join(sandbox, "commit-fail.sqlite");
    const cdb = new DeepaaDatabase(path);
    cdb.pragma("foreign_keys = ON");
    cdb.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY)");
    cdb.exec("CREATE TABLE child(pid INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)");
    cdb.exec("INSERT INTO parent VALUES(1)");
    const failing = cdb.transaction(() => {
      cdb.prepare("INSERT INTO child VALUES(?)").run(1);
      cdb.prepare("INSERT INTO child VALUES(?)").run(999); // 延迟违例：COMMIT 时才失败
    });
    // 原始外键错误透传——绝不能被清理 ROLLBACK 的错误覆盖（"cannot rollback"
    // 之类的普通 SQLITE_ERROR 是修复前的症状）。
    let caught: unknown;
    try {
      failing();
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : "";
    expect(message).toContain("FOREIGN KEY");
    expect(message).not.toMatch(/rollback/i);
    // 事务确已终结：不留僵尸（否则后续事务会被误判嵌套、savepoint"成功"却零提交）。
    expect(cdb.inTransaction).toBe(false);
    const ok = cdb.transaction(() => {
      cdb.prepare("INSERT INTO child VALUES(?)").run(1);
    });
    expect(() => ok()).not.toThrow();
    expect(cdb.prepare("SELECT COUNT(*) c FROM child WHERE pid = 999").get()).toEqual({c: 0});
    expect(cdb.prepare("SELECT COUNT(*) c FROM child").get()).toEqual({c: 1});
    cdb.close();
  });

  test("嵌套事务（better-sqlite3 语义）：内层自动 SAVEPOINT——内层回滚不破坏外层，外层回滚全部撤销", () => {    const innerFail = db.transaction((): never => {
      db.prepare("INSERT INTO tx(v) VALUES(?)").run(99);
      throw new Error("inner boom");
    });
    const outer = db.transaction((mode: "inner-commit" | "inner-rollback" | "outer-fail") => {
      db.prepare("INSERT INTO tx(v) VALUES(?)").run(10);
      const inner = db.transaction((value: number) => {
        db.prepare("INSERT INTO tx(v) VALUES(?)").run(value);
      });
      if (mode === "inner-commit") {
        inner(11); // 内层提交：随外层一并落库
      } else if (mode === "inner-rollback") {
        expect(() => innerFail()).toThrow("inner boom");
        // 内层 savepoint 回滚只撤销内层写入，外层事务继续可用。
        expect(db.prepare("SELECT COUNT(*) c FROM tx").get()).toEqual({c: 4});
      }
      if (mode === "outer-fail") throw new Error("outer boom");
    });
    outer("inner-commit");
    expect(db.prepare("SELECT COUNT(*) c FROM tx").get()).toEqual({c: 3});
    expect(() => outer("inner-rollback")).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) c FROM tx").get()).toEqual({c: 4}); // 10+11 + 10
    expect(() => outer("outer-fail")).toThrow("outer boom");
    expect(db.prepare("SELECT COUNT(*) c FROM tx").get()).toEqual({c: 4}); // 外层回滚撤销全部
    expect(db.inTransaction).toBe(false);
  });
});

describe("文件库与只读链路（zcode 双链路红线模式）", () => {
  test("WAL + auto_vacuum + .name 属性", () => {
    const path = join(sandbox, "wal.sqlite");
    const db = new DeepaaDatabase(path);
    db.pragma("journal_mode = WAL");
    db.pragma("auto_vacuum = INCREMENTAL");
    expect(db.pragma("journal_mode", {simple: true})).toBe("wal");
    expect(db.name).toBe(path);
    expect(db.open).toBe(true);
    db.close();
    expect(db.open).toBe(false);
  });

  test("readonly 打开：主库与 ATTACH 库写入均拒绝（errcode=8），读取正常", () => {
    const mainPath = join(sandbox, "main.sqlite");
    const srcPath = join(sandbox, "src.sqlite");
    new DeepaaDatabase(srcPath).exec("CREATE TABLE s(x)").close();
    const writer = new DeepaaDatabase(mainPath);
    writer.exec("CREATE TABLE m(x)");
    writer.exec("INSERT INTO m VALUES(1)");
    writer.close();

    const ro = new DeepaaDatabase(mainPath, {readonly: true, fileMustExist: true});
    expect(ro.prepare("SELECT COUNT(*) c FROM m").get()).toEqual({c: 1});
    expect(() => ro.exec("INSERT INTO m VALUES(2)")).toThrowError(expect.objectContaining({errcode: 8}) as never);
    ro.exec(`ATTACH DATABASE '${srcPath}' AS srcdb`);
    expect(() => ro.exec("CREATE TABLE srcdb.fail(x)")).toThrowError(
      expect.objectContaining({errcode: 8}) as never,
    );
    expect(ro.prepare("SELECT COUNT(*) c FROM srcdb.s").get()).toEqual({c: 0});
    ro.pragma("query_only = ON");
    ro.close();
  });

  test("fileMustExist：缺文件抛错（含路径）；timeout 选项映射 busy_timeout", () => {
    const missing = join(sandbox, "missing.sqlite");
    expect(() => new DeepaaDatabase(missing, {fileMustExist: true})).toThrow(missing);
    const db = new DeepaaDatabase(join(sandbox, "timeout.sqlite"), {timeout: 2500});
    expect(db.pragma("busy_timeout", {simple: true})).toBe(2500);
    db.close();
  });
});
