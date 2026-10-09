import { describe, expect, test } from "vitest";
import {
  buildConversationJsonl,
  buildConversationMarkdown,
  CONVERSATION_CATEGORY_LABELS,
  countDownloadItems,
  safeDownloadFilename,
  type ExportDownloadSegment,
} from "../src/lib/export-download-format";
import type { ExportContentItem } from "../src/lib/export-content-client";

function fakeItem(overrides: Partial<ExportContentItem>): ExportContentItem {
  return {
    category: "user_real",
    side: "input",
    text: "hello",
    exchangeId: "aexch-1",
    capturedAt: "2026-09-20T10:00:00+08:00",
    isAuxiliary: false,
    agentProtocol: "anthropic-messages",
    jsonPath: "$.input[0]",
    itemOrdinal: 0,
    mediaDescriptors: [],
    ...overrides,
  } as ExportContentItem;
}

const segments: ExportDownloadSegment[] = [
  {
    exchange: {
      exchangeId: "aexch-1",
      capturedAt: "2026-09-20T10:00:00+08:00",
      httpStatus: 200,
      hiddenInheritedInputCount: 0,
    } as ExportDownloadSegment["exchange"],
    items: [
      fakeItem({text: "用户问题"}),
      fakeItem({category: "tool_use", side: "output", text: "Bash", toolName: "Bash"}),
    ],
  },
  {
    exchange: {
      exchangeId: "aexch-2",
      capturedAt: "2026-09-20T10:01:00+08:00",
      hiddenInheritedInputCount: 0,
    } as ExportDownloadSegment["exchange"],
    items: [fakeItem({exchangeId: "aexch-2", text: "第二条"})],
  },
];

const fixedTime = (value: string | Date) => `T:${typeof value === "string" ? value : "now"}`;

describe("步骤正文导出序列化（export-download-format）", () => {
  test("Markdown 输出标题、分节与行分条形态，含 HTTP 状态与工具名", () => {
    const markdown = buildConversationMarkdown({
      heading: "本步新增 · aexch-1",
      segments,
      formatDateTime: fixedTime,
    });
    expect(markdown.startsWith("# 本步新增 · aexch-1\n")).toBe(true);
    expect(markdown).toContain("> 共 3 条 · T:now");
    expect(markdown).toContain("## aexch-1 · T:2026-09-20T10:00:00+08:00 · HTTP 200");
    expect(markdown).toContain(`- [input/${CONVERSATION_CATEGORY_LABELS.user_real}] 用户问题`);
    expect(markdown).toContain(`- [output/${CONVERSATION_CATEGORY_LABELS.tool_use} · Bash] Bash`);
    // 无 HTTP 状态的请求不拼接状态后缀。
    expect(markdown).toContain("## aexch-2 · T:2026-09-20T10:01:00+08:00\n");
    expect(markdown).not.toContain("## aexch-2 · T:2026-09-20T10:01:00+08:00 · HTTP");
  });

  test("JSONL 每行一个可解析的对话条目对象，跨分节保持顺序", () => {
    const jsonl = buildConversationJsonl({heading: "任意", segments});
    const lines = jsonl.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    const parsed = lines.map(line => JSON.parse(line) as {exchangeId: string; text: string});
    expect(parsed.map(item => item.exchangeId)).toEqual(["aexch-1", "aexch-1", "aexch-2"]);
    expect(parsed[1].text).toBe("Bash");
  });

  test("空内容时 JSONL 返回空字符串，条数统计跨分节求和", () => {
    expect(buildConversationJsonl({heading: "空", segments: []})).toBe("");
    expect(countDownloadItems({heading: "x", segments})).toBe(3);
    expect(countDownloadItems({heading: "x", segments: []})).toBe(0);
  });

  test("下载文件名按白名单收敛并折叠首尾连字符", () => {
    expect(safeDownloadFilename("aexch-01f111")).toBe("aexch-01f111");
    // 全部为非法字符时折叠为空，回退固定名。
    expect(safeDownloadFilename("带 空 格/斜杠")).toBe("export");
    expect(safeDownloadFilename("")).toBe("export");
  });
});
