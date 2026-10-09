import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {describe, expect, test} from "vitest";

const componentDir = join(process.cwd(), "src", "components", "proxy-management");

async function readComponent(name: string): Promise<string> {
  return await readFile(join(componentDir, name), "utf8");
}

/**
 * 供应商管理「故障转移模型」UI 结构守卫（与 proxy-management-ui.test.ts 同风格：
 * 源码文本断言，不做 DOM 渲染）。
 */
describe("供应商管理：故障转移模型 UI", () => {
  test("密钥与模型表格使用「故障转移」列头与「设置故障转移模型」入口", async () => {
    const source = await readComponent("proxy-resources-tab.tsx");
    expect(source).toContain("<th>故障转移</th>");
    expect(source).toContain("+ 设置故障转移模型");
    expect(source).not.toContain("<th>备份模型</th>");
    expect(source).not.toContain("设置故障转移备份");
    expect(source).toContain("ProxyFallbackDialog");
    expect(source).toContain("supportedModelFallbacks");
    // 备份 chips 展示「模型 ID · 供应商名」（公共标签函数）。
    expect(source).toContain("formatFallbackEntryLabel");
    // 级联提示：移除模型时告知会清理其它供应商故障转移模型链中的引用。
    expect(source).toContain("从所有供应商的故障转移模型链中移除对该模型的引用");
    // 展开编辑行跨 7 列。
    expect(source).toContain("colSpan={7}");
  });

  test("弹层标题为「故障转移模型」，候选按共同可服务 Agent 口径收集", async () => {
    const source = await readComponent("proxy-fallback-dialog.tsx");
    expect(source).toContain("collectFallbackCandidateOptions");
    expect(source).toContain("servableAgentsForModel");
    expect(source).toContain("MAX_TARGET_MODEL_FALLBACKS");
    expect(source).toContain("故障转移模型 · {modelId}");
    expect(source).toContain("需与主模型存在共同可用的 Agent");
    expect(source).toContain("已选（按优先级尝试");
    expect(source).not.toContain("有交集");
    // 主模型无可服务 Agent 时的明确提示。
    expect(source).toContain("主模型当前没有任何可用的 Agent 适用");
    // 优先级语义：上移/下移。
    expect(source).toContain("上移");
    expect(source).toContain("下移");
    // 候选卡片与已选列表均展示模型 ID + 供应商名。
    expect(source).toContain("fallbackCardModel");
    expect(source).toContain("fallbackCardTarget");
    expect(source).toContain("fallbackDraftName");
  });

  test("弹层两条提示文案为用户确认版本", async () => {
    const source = await readComponent("proxy-fallback-dialog.tsx");
    expect(source).toContain("建议所有闭源模型（如：GPT、Claude类）优先设置相同模型ID（如 中转站A gpt-5.6-sol → 中转站B gpt-5.6-sol，可以跨供应商）的故障转移备份模型，以最大可能性的复用上游提示词缓存。");
    expect(source).toContain("请求过程中，一旦切换到备份模型，系统会在下一次检测到上下文压缩时才自动尝试切回主力模型（兜底：长期未压缩约 2 小时后也会自动尝试切回），以最大化利用缓存及平衡主力模型可用性。");
  });

  test("弹层头部含故障转移图标，遵循受控弹层惯例", async () => {
    const source = await readComponent("proxy-fallback-dialog.tsx");
    expect(source).toContain("ArrowRightLeft");
    expect(source).toContain("fallbackIconBadge");
    expect(source).toContain("styles.dialogBackdrop");
    expect(source).toContain("Escape");
    expect(source).toContain('role="dialog"');
  });

  test("公共抽取：候选收集/可服务口径在域模块、展示标签在 failover-display", async () => {
    const domain = await readFile(join(process.cwd(), "src", "lib", "proxy-management-domain.ts"), "utf8");
    expect(domain).toContain("export function collectFallbackCandidateOptions");
    expect(domain).toContain("export function modelServableForAgent");
    expect(domain).toContain("export function servableAgentsForModel");
    const display = await readFile(join(process.cwd(), "src", "lib", "failover-display.ts"), "utf8");
    expect(display).toContain("export function formatFallbackEntryLabel");
  });
});
