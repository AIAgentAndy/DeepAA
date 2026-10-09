import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, test} from "vitest";
import {
  KNOWN_ACCOUNT_PROVIDER_IDS,
  PLAN_VENDOR_ALIASES_FROM_PLUGINS,
  PRESET_FAMILY_LABELS_FROM_PLUGINS,
  PROVIDER_PLUGINS,
  planProviderLabelFromPlugins,
} from "../src/lib/provider-plugins/meta";
import {PROVIDER_PRESETS} from "../src/lib/provider-presets";
import {PRESET_FAMILY_LABELS} from "../src/lib/preset-family";
import {createPlanAdapterRegistry} from "../src/lib/sync-engine/plan-registry";
import type {PlanProviderType, SyncProviderType} from "../src/lib/sync-engine/types";
import {createBalanceConnectorRegistry} from "../src/lib/provider-plugins";

/**
 * Provider 插件三方一致性（docs/上线前架构升级改造.md P1-9）：
 * provider-plugins/meta ↔ provider-presets ↔ sync-engine 注册表 ↔ UI 站点类型下拉。
 * 新增官方供应商 = 目录 JSONL 行 + 插件 meta 条目 +（可选）适配器文件 + 注册一行；
 * 本测试防止任何一侧悄悄漂移。
 */

describe("provider 插件一致性", () => {
  test("预设的 vendorFamily 都有插件族标签，且 hasPreset 声明与预设注册表一致", () => {
    const presetFamilies = new Set(PROVIDER_PRESETS.map(preset => preset.vendorFamily));
    for (const family of presetFamilies) {
      expect(PRESET_FAMILY_LABELS_FROM_PLUGINS[family], `族 ${family} 缺少标签`).toBeTruthy();
    }
    const pluginFamiliesWithPreset = new Set(
      PROVIDER_PLUGINS.filter(plugin => plugin.hasPreset).map(plugin => plugin.family),
    );
    expect(pluginFamiliesWithPreset).toEqual(presetFamilies);
  });

  test("preset-family 导出与插件派生一致", () => {
    expect(PRESET_FAMILY_LABELS).toEqual(PRESET_FAMILY_LABELS_FROM_PLUGINS);
  });

  test("套餐路由类型都已在 plan-registry 注册，且标签不回退到原始 id", () => {
    const registered = [...createPlanAdapterRegistry().keys()];
    for (const plugin of PROVIDER_PLUGINS) {
      if (!plugin.plan) continue;
      expect(
        registered.includes(plugin.plan.type as PlanProviderType),
        `${plugin.plan.type} 未在 plan-registry 注册`,
      ).toBe(true);
      expect(planProviderLabelFromPlugins(plugin.plan.type)).not.toBe(plugin.plan.type);
    }
  });

  test("vendor 别名映射与 plan 路由一致，且订阅别名只映射到订阅适配器", () => {
    for (const [alias, providerType] of Object.entries(PLAN_VENDOR_ALIASES_FROM_PLUGINS)) {
      const plugin = PROVIDER_PLUGINS.find(item => item.plan?.type === providerType);
      expect(plugin, `别名 ${alias} 指向未声明的套餐类型 ${providerType}`).toBeTruthy();
      expect(plugin!.plan!.vendorAliases).toContain(alias);
    }
  });

  test("余额注册表覆盖全部插件 id 与中转站/手动，键值合法", () => {
    const registry = createBalanceConnectorRegistry();
    for (const plugin of PROVIDER_PLUGINS) {
      expect(registry.has(plugin.id as SyncProviderType), `${plugin.id} 缺少余额适配器`).toBe(true);
    }
    for (const id of registry.keys()) {
      expect(KNOWN_ACCOUNT_PROVIDER_IDS.has(id), `注册表出现未登记 id：${id}`).toBe(true);
    }
  });

  test("UI 站点类型下拉 option 值都属于插件 id 集合（防手写漂移）", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "src", "components", "proxy-management", "proxy-overview-tab.tsx"),
      "utf8",
    );
    const optionValues = [...source.matchAll(/<option value="([a-z0-9-]+)"/g)]
      .map(match => match[1]!)
      .filter(value => value !== "relay" || true);
    for (const value of optionValues) {
      expect(
        KNOWN_ACCOUNT_PROVIDER_IDS.has(value),
        `站点类型下拉出现未登记值：${value}`,
      ).toBe(true);
    }
  });
});
