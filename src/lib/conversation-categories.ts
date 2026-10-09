import type { ConversationSemanticCategory } from "./conversation-semantics";

/**
 * 输入/输出侧的可见类别集合，是交互内容页、完整导出与 SQLite 规划层共享的唯一来源。
 * 以前这套集合在 UI、export-queries、内容流各维护一份，任何一侧漏改都会造成
 * “UI 显示全部但服务端仍按全局类别过滤”的分叉。
 */
export const INPUT_CONTENT_CATEGORIES: ConversationSemanticCategory[] = [
  "system",
  "developer",
  "user_real",
  "user_injected",
  "tool_result",
  "control",
  "unknown_input",
];

export const OUTPUT_CONTENT_CATEGORIES: ConversationSemanticCategory[] = [
  "assistant",
  "tool_use",
  "reasoning",
  "refusal",
  "tool_result",
  "control",
  "unknown_output",
];

export const ALL_CONTENT_CATEGORIES: ConversationSemanticCategory[] = [
  ...new Set([...INPUT_CONTENT_CATEGORIES, ...OUTPUT_CONTENT_CATEGORIES]),
];

export const INPUT_CONTENT_CATEGORY_SET: ReadonlySet<ConversationSemanticCategory> =
  new Set(INPUT_CONTENT_CATEGORIES);

export const OUTPUT_CONTENT_CATEGORY_SET: ReadonlySet<ConversationSemanticCategory> =
  new Set(OUTPUT_CONTENT_CATEGORIES);

/** 选中类别与指定侧的可见类别集合求交集；交集为空表示该侧不做过滤（全部展示）。 */
export function selectedCategoriesForSide(
  categories: readonly ConversationSemanticCategory[],
  side: "input" | "output",
): ConversationSemanticCategory[] {
  const sideCategories = side === "input"
    ? INPUT_CONTENT_CATEGORY_SET
    : OUTPUT_CONTENT_CATEGORY_SET;
  return categories.filter(category => sideCategories.has(category));
}

/**
 * 单条 item 的类别可见性：显式空选择全部隐藏；该侧未选中任何类别时按“全部”展示；
 * 否则只展示该侧选中的类别。与 export-queries 的按侧 SQL 条件保持一致。
 */
export function categorySelectedForSide(
  side: "input" | "output",
  category: ConversationSemanticCategory,
  categories: readonly ConversationSemanticCategory[],
  categoriesExplicit: boolean | undefined,
): boolean {
  if (categories.length === 0) return categoriesExplicit !== true;
  const selected = selectedCategoriesForSide(categories, side);
  if (selected.length === 0) return true;
  return selected.includes(category);
}
