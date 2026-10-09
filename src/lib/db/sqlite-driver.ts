/**
 * SQLite 驱动统一层（2026-10-08 用户确认：better-sqlite3 → node:sqlite 整体切换）。
 *
 * 项目对 SQLite 的使用全部收敛在本模块暴露的 better-sqlite3 兼容 API 上：
 * - 消灭唯一的原生依赖（CN 网络预编译下载失败 / Windows ARM 无预编译 / node-gyp
 *   兜底全部消失，安装链路变纯 JS）；
 * - node:sqlite（Node ≥22.13 无需 flag）与 better-sqlite3 在我们用到的核心同步
 *   API 上等价（命名参数裸键名、run() 返回 {changes,lastInsertRowid}、
 *   readonly+ATTACH 只读链路、WAL、窗口函数、iterate——均已实测）；
 * - 差异点在此适配：`.pragma()` / `.transaction()` / `.pluck()`（node:sqlite 无）
 *   与 `.name` / 构造选项（readonly/timeout/fileMustExist）。
 *
 * 注意：错误对象形态不同——node:sqlite 抛 `code='ERR_SQLITE_ERROR'` + 数字
 * `errcode`（主码；扩展码经 `& 0xff` 归并），消息不含 "SQLITE_BUSY" 等字样，
 * 错误分类见 src/lib/db/route-responses.ts。
 */

import {existsSync} from "node:fs";
import {DatabaseSync, type StatementSync} from "node:sqlite";

/** better-sqlite3 兼容的 run() 返回形态（node:sqlite 原生一致）。 */
export interface DeepaaRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteOpenOptions {
  /** 只读打开（不存在文件时报错，等价 readonly+fileMustExist 组合）。 */
  readonly?: boolean;
  /** 文件必须已存在，否则抛错（better-sqlite3 fileMustExist）。 */
  fileMustExist?: boolean;
  /** busy handler 等待毫秒数（better-sqlite3 timeout 选项）。 */
  timeout?: number;
}

type BindParameters = unknown[] | [Record<string, unknown>];

/**
 * 语句包装：补齐 better-sqlite3 的 `.pluck()`（取首列值——src 内 10+ 处依赖）
 * 并统一 get/all/iterate 的参数传递（位置展开或单个命名参数对象）。
 */
export class DeepaaStatement {
  readonly raw: StatementSync;
  /** better-sqlite3 兼容：语句的 SQL 源文本（测试探针按 source 匹配语句）。 */
  readonly source: string;
  private plucking = false;

  constructor(raw: StatementSync, source: string) {
    this.raw = raw;
    this.source = source;
    // 固化裸键名绑定（业务大量 {targetId} → @targetId）：矩阵内版本默认允许
    //（22.13/22.19 实测），显式开启防未来默认翻转；invokeLenient 的多余键
    // 剔除只有在此前提下才绝对安全（否则"未知参数"可能只是裸键名被拒）。
    raw.setAllowBareNamedParameters?.(true);
  }

  pluck(on = true): this {
    this.plucking = on;
    return this;
  }

  get(...params: BindParameters): unknown {
    const plain = toPlainRow(this.invokeLenient("get", params));
    return this.plucking ? pluckRow(plain) : plain;
  }

  all(...params: BindParameters): unknown[] {
    const rows = this.invokeLenient("all", params) as unknown[];
    const plain = rows.map(toPlainRow);
    return this.plucking ? plain.map(pluckRow) : plain;
  }

  run(...params: BindParameters): DeepaaRunResult {
    return this.invokeLenient("run", params) as DeepaaRunResult;
  }

  iterate(...params: BindParameters): IterableIterator<unknown> {
    const iterator = this.invokeLenient("iterate", params) as IterableIterator<unknown>;
    const plucking = this.plucking;
    return (function* wrapped() {
      for (const row of iterator) {
        const plain = toPlainRow(row);
        yield plucking ? pluckRow(plain) : plain;
      }
    })();
  }

  /**
   * better-sqlite3 容忍绑定对象中的多余键，node:sqlite 严格拒绝（实测
   * "Unknown named parameter 'x'"）——该错误发生在**绑定期、语句未执行**，
   * 剔除多余键重试绝对安全；缺失必需键的错误形态不同，直接原样抛出。
   * 代码面：sync-engine 等处会按条件拼 SQL（如凭据过滤段），对象键是超集。
   */
  private invokeLenient(method: "get" | "all" | "run" | "iterate", params: BindParameters): unknown {
    let current = params;
    for (let attempt = 0; ; attempt++) {
      try {
        return (this.raw[method] as (...args: unknown[]) => unknown)(...(current as unknown[]));
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const match = message.match(/^Unknown named parameter ["'](.+?)["']/);
        if (
          !match || attempt >= 100
          || !Array.isArray(current) || current.length !== 1
          || typeof current[0] !== "object" || current[0] === null
        ) {
          throw error;
        }
        const next = {...(current[0] as Record<string, unknown>)};
        delete next[match[1]!];
        current = [next];
      }
    }
  }
}

/**
 * 行值归一：node:sqlite 对 BLOB 返回裸 Uint8Array（`toString("hex")`/`equals`
 * 等 Buffer 方法不可用——指纹体系全是 BLOB(32) SHA-256，实测造成继承判定全灭），
 * better-sqlite3 返回 Buffer——统一转回 Buffer。
 */
function normalizeValue(value: unknown): unknown {
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

function pluckRow(row: unknown): unknown {
  if (row === undefined || row === null) return row;
  const values = Object.values(row as Record<string, unknown>);
  return values[0];
}

/**
 * 行对象归一：node:sqlite 返回无原型（null prototype）对象，better-sqlite3 返回
 * 普通对象——assert.deepEqual 严格比较原型不同即判不等（实测造成 67 个测试
 * 失败）。统一展开为普通对象并逐值归一（BLOB → Buffer），与 better-sqlite3 对齐。
 */
function toPlainRow(row: unknown): unknown {
  if (row === null || row === undefined || typeof row !== "object") return row;
  const plain: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    plain[key] = normalizeValue(value);
  }
  return plain;
}

/** node:sqlite 错误（code='ERR_SQLITE_ERROR' + 数字 errcode）→ better-sqlite3 风格码名。 */
const SQLITE_PRIMARY_CODE_NAMES = new Map<number, string>([
  [1, "SQLITE_ERROR"], [2, "SQLITE_INTERNAL"], [3, "SQLITE_PERM"], [4, "SQLITE_ABORT"],
  [5, "SQLITE_BUSY"], [6, "SQLITE_LOCKED"], [7, "SQLITE_NOMEM"], [8, "SQLITE_READONLY"],
  [9, "SQLITE_INTERRUPT"], [10, "SQLITE_IOERR"], [11, "SQLITE_CORRUPT"], [12, "SQLITE_NOTFOUND"],
  [13, "SQLITE_FULL"], [14, "SQLITE_CANTOPEN"], [15, "SQLITE_PROTOCOL"], [16, "SQLITE_EMPTY"],
  [17, "SQLITE_SCHEMA"], [18, "SQLITE_TOOBIG"], [19, "SQLITE_CONSTRAINT"], [20, "SQLITE_MISMATCH"],
  [21, "SQLITE_MISUSE"], [22, "SQLITE_NOLFS"], [23, "SQLITE_AUTH"], [25, "SQLITE_RANGE"],
  [26, "SQLITE_NOTADB"],
]);

/**
 * 实测确认的扩展码（2026-10-08 Node 22.19）：RAISE(ABORT) 触发器与 UNIQUE/CHECK
 * 在本驱动下均归并为 1811、FK=787、NOT NULL=1299——诊断字符串与 better-sqlite3
 * 的常用形态对齐即可，不追求逐扩展码精确命名。
 */
const SQLITE_EXTENDED_CODE_NAMES = new Map<number, string>([
  [787, "SQLITE_CONSTRAINT_FOREIGNKEY"],
  [1299, "SQLITE_CONSTRAINT_NOTNULL"],
  [1811, "SQLITE_CONSTRAINT_TRIGGER"],
  [262, "SQLITE_LOCKED_SHAREDCACHE"],
  [517, "SQLITE_BUSY_SNAPSHOT"],
]);

/** 派生/诊断层记录 errorCode 用的兼容转换：非 node:sqlite 错误返回 undefined。 */
export function sqliteErrorCodeName(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {code?: unknown; errcode?: unknown};
  if (candidate.code !== "ERR_SQLITE_ERROR" || typeof candidate.errcode !== "number") {
    return undefined;
  }
  const errcode = candidate.errcode;
  return SQLITE_EXTENDED_CODE_NAMES.get(errcode)
    ?? SQLITE_PRIMARY_CODE_NAMES.get(errcode & 0xff)
    ?? `SQLITE_ERR_${errcode}`;
}

export class DeepaaDatabase {
  readonly raw: DatabaseSync;
  private readonly filePath: string;
  /** 自有关闭状态（不依赖 raw 属性）：Node 22.13 无 isOpen，按属性兜底会误报。 */
  private closed = false;

  constructor(path: string, options: SqliteOpenOptions = {}) {
    if (options.fileMustExist && !existsSync(path)) {
      throw new Error(`unable to open database file: ${path}`);
    }
    this.filePath = path;
    this.raw = new DatabaseSync(path, options.readonly === true ? {readOnly: true} : {});
    if (options.timeout !== undefined) {
      this.raw.exec(`PRAGMA busy_timeout = ${options.timeout}`);
    }
  }

  /** better-sqlite3 兼容：数据库文件路径（WAL 清理等派生路径依赖）。 */
  get name(): string {
    return this.filePath;
  }

  /**
   * 打开状态：以自有标记为准（跨版本确定）。raw 属性不可靠——Node 22.13 的
   * `open` 是重开方法、`isOpen` 尚不存在，按属性兜底会把已关闭连接误报为可用，
   * 导致共享连接缓存（getDeepaaDatabase）复用已关闭连接。
   */
  get open(): boolean {
    return !this.closed;
  }

  /**
   * 事务状态：新版 Node 暴露 `isTransaction`/`inTransaction` 属性；旧版（实测
   * 22.13 两者皆无）退回探针——尝试 BEGIN：失败即已在事务内（失败的 BEGIN 无
   * 副作用），成功则紧跟空 ROLLBACK 抵消。事务控制全部经由 transaction()，
   * 不依赖该 getter 的性能关键路径。
   */
  get inTransaction(): boolean {
    const candidate = this.raw as unknown as {isTransaction?: unknown; inTransaction?: unknown};
    if (typeof candidate.isTransaction === "boolean") return candidate.isTransaction;
    if (typeof candidate.inTransaction === "boolean") return candidate.inTransaction;
    try {
      this.raw.exec("BEGIN");
      this.raw.exec("ROLLBACK");
      return false;
    } catch {
      return true;
    }
  }

  prepare(sql: string): DeepaaStatement {
    return new DeepaaStatement(this.raw.prepare(sql), sql);
  }

  exec(sql: string): this {
    this.raw.exec(sql);
    return this;
  }

  close(): this {
    if (this.closed) return this;
    this.raw.close();
    this.closed = true;
    return this;
  }

  /**
   * better-sqlite3 语义的 pragma：含 "=" 视为赋值（exec 执行、无返回）；读取时
   * `{simple: true}` 返回首行首列值（无行 undefined）；否则 0 行 → `[]`、
   * 单行单列 → 标量（如 journal_mode）、其余 → 行数组（`table_info(...)`、
   * `foreign_key_check` 等）。
   */
  pragma(source: string, options?: {simple?: boolean}): unknown {
    if (source.includes("=")) {
      this.raw.exec(`PRAGMA ${source}`);
      return undefined;
    }
    const rows = (this.raw.prepare(`PRAGMA ${source}`).all() as unknown[]).map(toPlainRow) as Array<Record<string, unknown>>;
    if (options?.simple) {
      return rows.length === 0 ? undefined : Object.values(rows[0]!)[0];
    }
    if (rows.length === 1) {
      const values = Object.values(rows[0]!);
      if (values.length === 1) return values[0];
    }
    return rows;
  }

  /**
   * better-sqlite3 语义的事务（本项目全部调用为无选项普通形态，调用即执行；
   * 抛错回滚并重抛）。BEGIN 默认 DEFERRED，与 better-sqlite3 一致；
   * **嵌套自动降级 SAVEPOINT**（better-sqlite3 同语义）——通过「先试 BEGIN、
   * 失败即已在事务内」自愈判定，不依赖任何版本差异的状态属性（实测 22.13 无
   * isTransaction/inTransaction，裸 BEGIN 嵌套会直接报错）。
   */
  transaction<Arguments extends unknown[], Result>(
    fn: (...args: Arguments) => Result,
  ): (...args: Arguments) => Result {
    return (...args: Arguments) => {
      let topLevel = false;
      try {
        this.raw.exec("BEGIN");
        topLevel = true;
      } catch {
        topLevel = false; // 已在事务内（含任何来源的事务）→ savepoint 降级。
      }
      if (!topLevel) {
        const savepoint = `deepaa_sp_${++DeepaaDatabase.savepointSeq}`;
        this.raw.exec(`SAVEPOINT ${savepoint}`);
        let nested: Result;
        try {
          nested = fn(...args);
          this.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (error) {
          // 清理 best-effort：回滚语句自身失败（如 SQLite 已自动回滚）不得
          // 覆盖原始错误向上传播。
          try {
            this.raw.exec(`ROLLBACK TO ${savepoint}`);
            this.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
          } catch { /* 保留原始错误 */ }
          throw error;
        }
        return nested;
      }
      let result: Result;
      try {
        result = fn(...args);
        // COMMIT 必须在 try 内：SQLITE_FULL/IOERR/BUSY 等提交失败会让事务
        // **保持打开**——落在 try 外将僵尸化（后续嵌套 savepoint“成功”却
        // 零提交，失败写入悬挂到连接关闭，2026-10-08 Claude 审核复现）。
        this.raw.exec("COMMIT");
      } catch (error) {
        // 部分提交失败 SQLite 已自动回滚，无脑二次 ROLLBACK 会抛普通
        // SQLITE_ERROR 覆盖原始错误（实测 SQLITE_FULL → SQLITE_ERROR）。
        try { this.raw.exec("ROLLBACK"); } catch { /* 保留原始错误 */ }
        throw error;
      }
      return result;
    };
  }

  private static savepointSeq = 0;
}
