import { describe, expect, test } from "vitest";
import {
  sharedSelectionFromSearchParams,
  sharedSelectionQuery,
  tokenPricingHierarchyAfterChange,
  tokenPricingHierarchyAfterResolution,
  topLevelHref,
  topLevelNavHref,
  workbenchSelectionQuery,
} from "../src/lib/shared-selection.js";

describe("一级页面公共上下文", () => {
  test("只按固定顺序传播单值六级上下文", () => {
    const query = sharedSelectionQuery(new URLSearchParams(
      "target=api&agent=codex&session=asess-1&thread=athread-1&turn=aturn-1&step=ex-1&offset=50&cursor=abc",
    ));

    expect(query).toBe("target=api&agent=codex&session=asess-1&thread=athread-1&turn=aturn-1&step=ex-1");
    expect(sharedSelectionQuery({
      target: "api",
      agent: "codex",
      session: "s",
      thread: "th",
      turn: "t",
      step: "ex",
    })).toBe("target=api&agent=codex&session=s&thread=th&turn=t&step=ex");
  });

  test("多选目标或 Agent 不会被任意收敛成单值", () => {
    expect(sharedSelectionFromSearchParams(new URLSearchParams(
      "target=a,b&agent=codex,claude&session=asess-1&thread=athread-1&cursor=abc",
    ))).toEqual({ session: "asess-1", thread: "athread-1" });
    expect(sharedSelectionFromSearchParams(new URLSearchParams(
      "target=a&target=b&agent=codex&agent=claude&session=asess-1",
    ))).toEqual({ session: "asess-1" });
  });

  test("从 URL 提取 Thread，三个一级路径往返都保留同一六级查询串", () => {
    const params = new URLSearchParams(
      "target=api&agent=codex&session=asess-1&thread=athread-1&turn=aturn-1&step=ex-1&limit=500",
    );

    expect(sharedSelectionFromSearchParams(params).thread).toBe("athread-1");
    const query = "target=api&agent=codex&session=asess-1&thread=athread-1&turn=aturn-1&step=ex-1";
    expect(topLevelHref("/", params)).toBe(`/?${query}`);
    expect(topLevelHref("/export", params)).toBe(`/export?${query}`);
    expect(topLevelHref("/token-pricing", params)).toBe(`/token-pricing?${query}`);
  });

  test("Token 价格层级联动可由客户端安全的公共选择模块提供", () => {
    const current = {
      session: "session-old",
      thread: "thread-old",
      turn: "turn-old",
      step: "step-old",
    };

    expect(tokenPricingHierarchyAfterChange(current, "session", "session-new")).toEqual({
      session: "session-new",
      thread: "",
      turn: "",
      step: "",
    });
    expect(tokenPricingHierarchyAfterChange(current, "thread", "thread-new")).toEqual({
      session: "session-old",
      thread: "thread-new",
      turn: "",
      step: "",
    });
    expect(tokenPricingHierarchyAfterChange(current, "turn", "turn-new")).toEqual({
      session: "session-old",
      thread: "thread-old",
      turn: "turn-new",
      step: "",
    });
    expect(tokenPricingHierarchyAfterChange(current, "step", "step-new")).toEqual({
      session: "session-old",
      thread: "thread-old",
      turn: "turn-old",
      step: "step-new",
    });
  });

  test("旧服务端未解析 Thread 时保留当前 URL 上下文", () => {
    expect(tokenPricingHierarchyAfterResolution({
      session: "session-old",
      thread: "thread-from-url",
      turn: "turn-old",
      step: "step-old",
    }, {
      session: "session-resolved",
      thread: "",
      turn: "turn-resolved",
      step: "step-resolved",
    })).toEqual({
      session: "session-resolved",
      thread: "thread-from-url",
      turn: "turn-resolved",
      step: "step-resolved",
    });
  });

  test("无参数首页解析默认路径后生成六级业务参数并把私有 view 放在最后", () => {
    expect(workbenchSelectionQuery({
      target: "catapi.chat",
      agent: "codex",
      session: "asess-1",
      thread: "athread-1",
      turn: "aturn-1",
      step: "ex-1",
    }, "thread")).toBe(
      "target=catapi.chat&agent=codex&session=asess-1&thread=athread-1&turn=aturn-1&step=ex-1&view=thread",
    );
  });

  test("顶部导航：三个数据页之间互带六级业务上下文（2026-09-24）", () => {
    const params = new URLSearchParams(
      "target=catapi.chat&agent=codex&session=asess-1&thread=athread-1&turn=aturn-1&step=astep-1&view=turn",
    );
    const query = "target=catapi.chat&agent=codex&session=asess-1&thread=athread-1&turn=aturn-1&step=astep-1";

    expect(topLevelNavHref("/export", "/sessions", params)).toBe(`/export?${query}`);
    expect(topLevelNavHref("/token-pricing", "/export", params)).toBe(`/token-pricing?${query}`);
    expect(topLevelNavHref("/sessions", "/token-pricing", params)).toBe(`/sessions?${query}`);
  });

  test("顶部导航：切向仪表盘/供应商管理不带参数，从这两页切向数据页也不带（2026-09-24）", () => {
    const params = new URLSearchParams(
      "target=catapi.chat&agent=codex&session=asess-1&thread=athread-1&turn=aturn-1&step=astep-1",
    );

    expect(topLevelNavHref("/dashboard", "/sessions", params)).toBe("/dashboard");
    expect(topLevelNavHref("/proxy-management", "/token-pricing", params)).toBe("/proxy-management");
    expect(topLevelNavHref("/sessions", "/dashboard", params)).toBe("/sessions");
    expect(topLevelNavHref("/export", "/proxy-management", params)).toBe("/export");
    expect(topLevelNavHref("/token-pricing", "/dashboard", params)).toBe("/token-pricing");
  });
});
