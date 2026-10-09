import {describe, expect, test} from "vitest";
import {
  COMPACTION_SUMMARY_MARKER_TEXTS,
  DSH_COMPACT_HEADER,
  hasCompactionSummaryMarkerBytes,
} from "../src/proxy/gateway-prefix.js";
import {SUMMARY_MARKERS, detectCompactionSummaryMarker} from "../src/lib/harness/compaction-evidence";

/**
 * 守卫测试：代理构建不含业务派生模块，压缩标记在代理侧持有副本
 * （src/proxy/gateway-prefix.ts）；两侧常量必须保持一致，防止单侧漂移。
 */
describe("压缩标记常量同步（代理副本 ↔ harness 证据层）", () => {
  test("摘要标记文本逐条一致", () => {
    expect(COMPACTION_SUMMARY_MARKER_TEXTS).toEqual(SUMMARY_MARKERS.map(marker => marker.text));
  });

  test("dsh 压缩头名称一致", () => {
    expect(DSH_COMPACT_HEADER).toBe("x-deepseek-harness-compact");
  });

  test("代理侧字节匹配与 harness 文本检测同判", () => {
    const continuation = SUMMARY_MARKERS.find(marker => marker.kind === "continuation")!.text;
    const codexSummary = SUMMARY_MARKERS.find(marker => marker.kind === "codex_summary")!.text;
    const positive = Buffer.from(`{"model":"m","messages":[{"role":"user","content":"${continuation} 后续内容"}]}`);
    const positiveCodex = Buffer.from(`{"model":"m","messages":[{"role":"user","content":"${codexSummary}"}]}`);
    const negative = Buffer.from('{"model":"m","messages":[{"role":"user","content":"普通对话内容"}]}');
    expect(hasCompactionSummaryMarkerBytes(positive)).toBe(true);
    expect(hasCompactionSummaryMarkerBytes(positiveCodex)).toBe(true);
    expect(hasCompactionSummaryMarkerBytes(negative)).toBe(false);
    // harness 侧对同样的文本同样命中（同判校验）。
    expect(detectCompactionSummaryMarker([continuation])).toBeDefined();
    expect(detectCompactionSummaryMarker(["普通对话内容"])).toBeUndefined();
  });
});
