import {describe, expect, test} from "vitest";
import {
  detectCompactionEvidence,
  detectCompactionSummaryMarker,
  hasDshCompactionHeader,
} from "../src/lib/harness/compaction-evidence.js";

/** 三类标记均取自 2026-09-11 真实库取证（docs 调研附二）。 */
const CLAUDE_CONTINUATION = "This session is being continued from a previous conversation that ran out of context. The conversation is summarized";
const CODEX_SUMMARY = "Another language model started to solve this problem and produced a summary of its thinking process.";

describe("压缩证据：摘要标记（claude/zcode 与 codex 形态）", () => {
  test("消息头部命中 claude/zcode 续接标记", () => {
    const result = detectCompactionSummaryMarker([CLAUDE_CONTINUATION]);
    expect(result).toBeDefined();
    expect(result?.kind).toBe("summary_marker");
    expect(result?.markerKind).toBe("continuation");
    expect(result?.confidence).toBe("high");
    expect(result?.preview.startsWith("This session is being continued")).toBe(true);
  });

  test("消息头部命中 codex 摘要标记", () => {
    const result = detectCompactionSummaryMarker([`用户上文…\n${CODEX_SUMMARY}`.slice(0, 0) + CODEX_SUMMARY]);
    expect(result?.markerKind).toBe("codex_summary");
  });

  test("普通消息开头包含少量前缀时仍能命中（头部窗口 200 字符内）", () => {
    const result = detectCompactionSummaryMarker([`<system-reminder>包装\n${CODEX_SUMMARY}`]);
    expect(result?.markerKind).toBe("codex_summary");
  });

  test("正文深处引用模板句式不误报（超出头部窗口）", () => {
    const quoted = `这是一段很长的用户消息。${"填充".repeat(120)} 另外，有人引用了这句话：${CODEX_SUMMARY}`;
    expect(detectCompactionSummaryMarker([quoted])).toBeUndefined();
  });

  test("无标记文本与空输入返回 undefined", () => {
    expect(detectCompactionSummaryMarker(["普通用户消息"])).toBeUndefined();
    expect(detectCompactionSummaryMarker([])).toBeUndefined();
    expect(detectCompactionSummaryMarker([""])).toBeUndefined();
  });
});

describe("压缩证据：dsh 官方 purpose 头", () => {
  test("x-deepseek-harness-compact: 1 命中且为 exact 置信", () => {
    expect(hasDshCompactionHeader({"x-deepseek-harness-compact": "1"})).toBe(true);
    const result = detectCompactionEvidence({"x-deepseek-harness-compact": "1"}, []);
    expect(result).toMatchObject({kind: "purpose_header", confidence: "exact"});
  });

  test("头缺失或为 0 时不命中", () => {
    expect(hasDshCompactionHeader({})).toBe(false);
    expect(hasDshCompactionHeader({"x-deepseek-harness-compact": "0"})).toBe(false);
    expect(hasDshCompactionHeader({"x-deepseek-harness-compact": " "})).toBe(false);
  });
});

describe("压缩证据：purpose 头优先于摘要标记", () => {
  test("同时存在时 purpose 头胜出", () => {
    const result = detectCompactionEvidence(
      {"x-deepseek-harness-compact": "1"},
      [CLAUDE_CONTINUATION],
    );
    expect(result?.kind).toBe("purpose_header");
  });
});
