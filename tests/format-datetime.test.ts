import {describe, expect, test} from "vitest";
import {formatVersionDateTime} from "../src/lib/format-datetime.js";

describe("版本时间展示（固定东八区）", () => {
  test("UTC ISO（LiteLLM 导入时间）固定换算为东八区", () => {
    expect(formatVersionDateTime("2026-09-07T08:19:19.000Z")).toBe("2026-09-07 16:19:19");
    expect(formatVersionDateTime("2026-09-07T16:20:02Z")).toBe("2026-09-08 00:20:02");
    expect(formatVersionDateTime("2026-09-06T16:20:02.123Z")).toBe("2026-09-07 00:20:02");
  });

  test("空格分隔墙钟（目录发布规范）原样展示，不二次偏移", () => {
    expect(formatVersionDateTime("2026-09-06 16:20:02")).toBe("2026-09-06 16:20:02");
    expect(formatVersionDateTime("2026-09-06 16:20")).toBe("2026-09-06 16:20");
  });

  test("历史 T 分隔无时区存储统一为空格展示", () => {
    expect(formatVersionDateTime("2026-09-07T16:10:37")).toBe("2026-09-07 16:10:37");
  });

  test("纯日期与无法解析值原样返回", () => {
    expect(formatVersionDateTime("2026-09-05")).toBe("2026-09-05");
    expect(formatVersionDateTime("not-a-date")).toBe("not-a-date");
    expect(formatVersionDateTime(undefined)).toBe("");
    expect(formatVersionDateTime("")).toBe("");
  });
});
