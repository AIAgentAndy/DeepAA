export interface TimeCursor {
  time: string;
  id: string;
}

export class InvalidCursorError extends Error {
  readonly code = "invalid_cursor";

  constructor() {
    super("cursor 格式无效。");
    this.name = "InvalidCursorError";
  }
}

export function encodeCursor(value: TimeCursor): string {
  assertCursorValue(value);
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(
  value: string | null | undefined,
): TimeCursor | undefined {
  if (!value) return undefined;
  if (value.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InvalidCursorError();
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length === 0 || decoded.length > 1_024) {
      throw new InvalidCursorError();
    }
    const parsed = JSON.parse(decoded.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new InvalidCursorError();
    }
    const row = parsed as Record<string, unknown>;
    if (
      Object.keys(row).length !== 2
      || typeof row.time !== "string"
      || typeof row.id !== "string"
    ) {
      throw new InvalidCursorError();
    }
    const cursor = { time: row.time, id: row.id };
    assertCursorValue(cursor);
    return cursor;
  } catch (error) {
    if (error instanceof InvalidCursorError) throw error;
    throw new InvalidCursorError();
  }
}

function assertCursorValue(value: TimeCursor): void {
  if (
    !value.time
    || !value.id
    || Buffer.byteLength(value.time) > 256
    || Buffer.byteLength(value.id) > 512
  ) {
    throw new InvalidCursorError();
  }
}
