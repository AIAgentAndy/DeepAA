import {describe, expect, test} from "vitest";
import {readFile} from "node:fs/promises";
import {PROVIDER_PRESETS} from "../src/lib/provider-presets.js";

/** 解析随包目录的预设行声明（跳过注释、空行与 meta 行），得到 (catalogKey, presetKey) → planCreditFormula。 */
async function catalogPresetPlanCreditMap(): Promise<Map<string, "none" | undefined>> {
  const raw = await readFile("data/defaults/llm_catalog.jsonl", "utf8");
  const result = new Map<string, "none" | undefined>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof parsed.schemaVersion === "number") continue;
    if (typeof parsed.catalogKey !== "string" || !Array.isArray(parsed.presets)) continue;
    for (const preset of parsed.presets) {
      if (!preset || typeof preset !== "object") continue;
      const presetKey = (preset as Record<string, unknown>).presetKey;
      if (typeof presetKey !== "string") continue;
      const formula = (preset as Record<string, unknown>).planCreditFormula;
      result.set(`${parsed.catalogKey}/${presetKey}`, formula === "none" ? "none" : undefined);
    }
  }
  return result;
}

describe("预设级积分公式声明（2026-10-07 守护测试）", () => {
  test("火山 Coding Plan 双端一致声明 none；其余全部预设（含 Agent Plan/智谱/OpenCode Go）不声明", async () => {
    const catalog = await catalogPresetPlanCreditMap();
    expect(catalog.size).toBeGreaterThan(0);
    // 目录侧：只有 volcengine-coding-plan 声明 none。
    const declared = [...catalog.entries()].filter(([, formula]) => formula === "none").map(([key]) => key);
    expect(declared).toEqual(["volcengine-plan/volcengine-coding-plan"]);
    // 注册表侧：与目录逐一对齐（含「都不声明」的预设）。
    for (const preset of PROVIDER_PRESETS) {
      const catalogFormula = catalog.get(`${preset.catalogKey}/${preset.id}`);
      expect(preset.planCreditFormula ?? catalogFormula, `预设 ${preset.id} 注册表与目录声明不一致`).toBe(catalogFormula ?? undefined);
    }
  });

  test("关键样本：Agent Plan / 智谱 / OpenCode Go / Kimi 等精确公式预设绝不被误声明为 none", () => {
    const byId = new Map(PROVIDER_PRESETS.map(preset => [preset.id, preset]));
    expect(byId.get("volcengine-coding-plan")?.planCreditFormula).toBe("none");
    for (const id of ["volcengine-plan", "zhipu-coding-plan", "zhipu-cn", "opencode-go", "kimi-coding", "minimax-plan", "qwenai-token-plan", "tencent-tokenhub-plan"]) {
      expect(byId.get(id)?.planCreditFormula, `预设 ${id} 不得声明 planCreditFormula`).toBeUndefined();
    }
  });
});
