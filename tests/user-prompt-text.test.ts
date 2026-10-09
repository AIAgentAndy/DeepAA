import { describe, expect, test } from "vitest";
import {
  looksLikeInjectedEnvelope,
  pickTurnUserPromptItem,
} from "../src/lib/user-prompt-text";

describe("本 Turn 用户输入正文选取（预览端与完整读取端共用）", () => {
  test("注入信封前缀按 trimStart 后识别", () => {
    expect(looksLikeInjectedEnvelope("<system-reminder>…")).toBe(true);
    expect(looksLikeInjectedEnvelope("  The following skills are available: …")).toBe(true);
    expect(looksLikeInjectedEnvelope("帮我看看这个报错")).toBe(false);
    expect(looksLikeInjectedEnvelope("")).toBe(false);
  });

  test("优先取最后一条人类输入，全部像注入时如实降级取最后一条", () => {
    const items = [
      { id: 1, text: "The following skills are available: x" },
      { id: 2, text: "帮我修复会话追踪页面的 bug" },
      { id: 3, text: "<system-reminder>注入信封</system-reminder>" },
    ];
    expect(pickTurnUserPromptItem(items, item => item.text)?.id).toBe(2);
    const injectedOnly = [
      { id: 1, text: "<system-reminder>a</system-reminder>" },
      { id: 2, text: "<system-reminder>b</system-reminder>" },
    ];
    expect(pickTurnUserPromptItem(injectedOnly, item => item.text)?.id).toBe(2);
  });

  test("空文本条目不参与选取，空集合返回 undefined", () => {
    const items = [
      { id: 1, text: "   " },
      { id: 2, text: "真实的用户输入" },
    ];
    expect(pickTurnUserPromptItem(items, item => item.text)?.id).toBe(2);
    expect(pickTurnUserPromptItem([], item => item.text)).toBeUndefined();
    expect(pickTurnUserPromptItem([{ id: 1 }], () => undefined)).toBeUndefined();
  });
});
