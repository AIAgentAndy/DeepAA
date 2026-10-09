import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, test} from "vitest";
import {readFile} from "node:fs/promises";
import {ProviderCatalogReview} from "../src/components/proxy-management/provider-catalog-review.js";
import type {ProviderCatalogReview as ProviderCatalogReviewData} from "../src/lib/provider-catalog/service.js";
import type {ProviderCatalogDiffItem} from "../src/lib/provider-catalog/diff.js";

/**
 * 新建供应商「预设模型」面板的默认勾选行为（2026-10-07 用户确认，取代默认全选）：
 * 默认仅勾选目录首位推荐模型，用户可加选其余模型。回归背景：f21d17a 只改了文案、
 * 页面状态初始值与服务端兜底，组件内部勾选状态仍初始化为全部可计价模型，并通过
 * onSelectionChange 挂载回传把页面已设好的「仅首位」覆盖成全量（实测已选 15/15）。
 */

function diffItem(id: string, priced: boolean): ProviderCatalogDiffItem {
  return {
    id,
    kind: "added",
    // diff.ts 的 item() 中 selected 标志语义 = priced（有价格映射），不是「推荐勾选」。
    selected: priced,
    priced,
    vendor: "zhipu",
    ...(priced ? {pricing: {input: 0.5, output: 2}} : {}),
  };
}

function reviewWith(models: Array<{id: string; priced: boolean}>): ProviderCatalogReviewData {
  const added = models.map(model => diffItem(model.id, model.priced));
  return {
    presetId: "zhipu-coding-plan",
    expectedRevision: 1,
    source: "offline",
    sourceHash: "test-hash",
    fetchedAt: "2026-10-08T00:00:00.000Z",
    publishedAt: "2026.10.07.01",
    pricingProviderId: "zhipu",
    providerName: "智谱",
    region: "cn",
    currency: "CNY",
    diff: {
      providerId: "zhipu",
      added,
      existing: [],
      removed: [],
      candidateCount: added.length,
      processedCount: added.length,
      limited: false,
    },
    candidateCount: added.length,
    processedCount: added.length,
    limited: false,
    models: models.map(model => ({
      id: model.id,
      vendor: "zhipu",
      currency: "CNY" as const,
      ...(model.priced ? {pricing: {input: 0.5, output: 2}} : {}),
      supportedAgents: ["codex" as const],
    })),
  };
}

function renderCreateMode(review: ProviderCatalogReviewData): string {
  return renderToStaticMarkup(createElement(ProviderCatalogReview, {
    review,
    busy: false,
    createMode: true,
    onCancel: () => undefined,
    onConfirm: () => Promise.resolve(),
  }));
}

/** 截取单个模型卡片（<label> 分段）的 HTML，避免前一张卡片的 checked 干扰断言。 */
function cardHtml(html: string, id: string): string {
  return html.split("<label").find(part => part.includes(`<code>${id}</code>`)) ?? "";
}

describe("新建供应商预设模型默认勾选", () => {
  test("默认仅勾选目录首位推荐模型，其余候选不勾选", () => {
    const html = renderCreateMode(reviewWith([
      {id: "glm-5.3", priced: true},
      {id: "glm-5.3-flash", priced: true},
      {id: "glm-5.3-air", priced: true},
    ]));
    expect(cardHtml(html, "glm-5.3")).toContain('checked=""');
    expect(cardHtml(html, "glm-5.3-flash")).not.toContain('checked=""');
    expect(cardHtml(html, "glm-5.3-air")).not.toContain('checked=""');
    // 底部计数跟随默认勾选：修复前组件初始化为全部可计价模型（此处会是 3）。
    expect(html).toContain("当前选择 1 个");
  });

  test("目录首位缺价格映射时默认勾选首个可计价候选（diff selected 语义 = priced）", () => {
    const html = renderCreateMode(reviewWith([
      {id: "glm-preview", priced: false},
      {id: "glm-5.3", priced: true},
      {id: "glm-5.3-flash", priced: true},
    ]));
    expect(cardHtml(html, "glm-preview")).not.toContain('checked=""');
    expect(cardHtml(html, "glm-5.3")).toContain('checked=""');
    expect(cardHtml(html, "glm-5.3-flash")).not.toContain('checked=""');
    expect(html).toContain("当前选择 1 个");
  });

  test("用户主动勾选不被重置：重置 effect 只依赖默认勾选集，与 selectedIds 解耦", async () => {
    const source = await readFile(
      new URL("../src/components/proxy-management/provider-catalog-review.tsx", import.meta.url), "utf8",
    );
    expect(source).toContain("const defaultSelectedIds = useMemo(() => selectableIds.slice(0, 1), [selectableIds]);");
    // 重置回「仅首位」只允许发生在 review 更新（切换预设/刷新目录）时；
    // 依赖 selectedIds 或可选集本体会让每次勾选都触发重置、清掉用户选择。
    expect(source).toContain("}, [defaultSelectedIds]);");
    expect(source).not.toContain("}, [selectableIds]);");
    expect(source).not.toContain("}, [allIds]);");
    expect(source).not.toContain("setSelectedIds(allIds)");
  });
});
