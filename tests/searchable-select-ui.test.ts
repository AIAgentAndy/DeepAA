import { describe, expect, test } from "vitest";
import { existsSync } from "fs";
import { readFile } from "fs/promises";

const searchableSelectUrl = new URL("../src/components/searchable-select.tsx", import.meta.url);

describe("公共可搜索下拉源码", () => {
  test("公共组件提供完整键盘导航和列表框语义", async () => {
    expect(existsSync(searchableSelectUrl)).toBe(true);
    if (!existsSync(searchableSelectUrl)) return;

    const source = await readFile(searchableSelectUrl, "utf-8");
    expect(source).toContain('role="listbox"');
    expect(source).toContain('role="option"');
    expect(source).toContain("aria-activedescendant");
    expect(source).toContain('event.key === "ArrowDown"');
    expect(source).toContain('event.key === "ArrowUp"');
    expect(source).toContain('event.key === "Enter"');
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("resultMessage");
    // 可选能力（2026-10-07 价格中心选择器）：行中部 hint、最右状态列、置灰不可选行、底部加载更多。
    expect(source).toContain("hint?: string;");
    expect(source).toContain("status?: string;");
    expect(source).toContain("disabled?: boolean;");
    expect(source).toContain("footerAction");
    expect(source).toContain("if (!option || option.disabled) return;");
    // 搜索框下方内容插槽（2026-10-07 家族供应商过滤开关）。
    expect(source).toContain("belowSearch?: ReactNode;");
  });

  test("开发启动弹窗复用公共组件而不是保留私有副本", async () => {
    const source = await readFile(
      new URL("../src/components/development-launch-dialog.tsx", import.meta.url),
      "utf-8",
    );

    expect(source).toContain('from "@/components/searchable-select"');
    expect(source).not.toContain("function SearchableSelect(");
  });
});
