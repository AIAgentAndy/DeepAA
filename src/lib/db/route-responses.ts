import { InvalidCursorError } from "./cursors";
import {
  RawBodyExceedsPreviewBudgetError,
  UnsafeRawReferenceError,
} from "./workbench-queries";

/**
 * node:sqlite 错误码（主码；扩展码经 & 0xff 归并，如 SQLITE_BUSY_SNAPSHOT 517
 * → BUSY 5）。2026-10-08 better-sqlite3 → node:sqlite 切换：错误对象形态由
 * `SqliteError.code="SQLITE_BUSY"` 字符串变为 `code='ERR_SQLITE_ERROR'` +
 * 数字 `errcode`。
 */
const SQLITE_UNAVAILABLE_ERRCODES = new Set([
  3, // SQLITE_PERM
  5, // SQLITE_BUSY（含 SQLITE_BUSY_* 扩展码）
  6, // SQLITE_LOCKED（含 SQLITE_LOCKED_* 扩展码）
  8, // SQLITE_READONLY（含 SQLITE_READONLY_* 扩展码）
  10, // SQLITE_IOERR（含 SQLITE_IOERR_* 扩展码）
  14, // SQLITE_CANTOPEN
]);
const FILESYSTEM_UNAVAILABLE_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOTDIR",
  "EISDIR",
  "EEXIST",
]);

export function notFoundResponse(message: string): Response {
  return Response.json({
    error: { code: "not_found", message },
  }, { status: 404 });
}

export function invalidParameterResponse(
  code: string,
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status: 400 });
}

/** API 不泄漏 SQLite 路径、锁和底层异常，只暴露稳定错误语义。 */
export function workbenchRouteErrorResponse(error: unknown): Response {
  if (error instanceof InvalidCursorError) {
    return invalidParameterResponse("invalid_cursor", error.message);
  }
  if (error instanceof UnsafeRawReferenceError) {
    return invalidParameterResponse("unsafe_raw_reference", error.message);
  }
  if (error instanceof RawBodyExceedsPreviewBudgetError) {
    return invalidParameterResponse(error.code, error.message);
  }
  if (error instanceof URIError) {
    return invalidParameterResponse("invalid_parameter", "路径参数编码无效。");
  }
  if (!isDerivedDatabaseUnavailable(error)) {
    return Response.json({
      error: {
        code: "internal_error",
        message: "服务端处理请求失败。",
      },
    }, { status: 500 });
  }
  return Response.json({
    error: {
      code: "derived_unavailable",
      message: "派生数据库暂时不可用，请稍后重试。",
    },
    derivedStatus: "failed",
  }, { status: 503 });
}

function isDerivedDatabaseUnavailable(error: unknown): boolean {
  if (isSqliteUnavailableErrcode(error)) return true;
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && FILESYSTEM_UNAVAILABLE_CODES.has(code);
}

function isSqliteUnavailableErrcode(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("errcode" in error)) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  if (typeof errcode !== "number" || !Number.isInteger(errcode)) return false;
  return SQLITE_UNAVAILABLE_ERRCODES.has(errcode & 0xff);
}
