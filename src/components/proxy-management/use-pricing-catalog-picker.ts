"use client";

import {useCallback, useEffect, useRef, useState} from "react";
import type {ModelPriceEntry} from "@/lib/pricing";
import type {SearchableSelectOption} from "@/components/searchable-select";

/** 选择器分页大小：官方预设默认按当前供应商过滤时条目通常不足一页，全部直出。 */
export const PRICING_PICKER_PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 250;

/**
 * 搜索词家族 → 官方供应商（2026-10-07 用户确认，先支持四类）：搜索 claude/gpt/grok/gemini
 * 类模型时默认只展示官方直供供应商条目，避免中转站同名模型淹没候选；用户可取消勾选看全部。
 * 仅在无显式供应商过滤（如中转站目标未开「仅显示」）时生效，官方预设的显式过滤优先。
 */
export const SEARCH_FAMILY_VENDORS: ReadonlyArray<{pattern: RegExp; vendor: string}> = [
  {pattern: /claude/iu, vendor: "anthropic"},
  {pattern: /gpt/iu, vendor: "openai"},
  {pattern: /grok/iu, vendor: "xai"},
  {pattern: /gemini/iu, vendor: "gemini"},
];

/** 目标价格映射的最小结构（ProxyTarget.pricing.modelVendors 的形状子集）。 */
interface AddedModelVendorMapping {
  vendor?: string;
  priceEntryId?: string;
}

/**
 * 价格中心选择器专用取数（2026-10-07 用户确认，密钥与模型页签与向导共用）：
 * 服务端 `vendor`/`search` 参数查询 + 每页 100 条累积分页。
 *
 * 为什么不复用页面共享的 pricingModels（limit=200 全量截断列表）：启用校验、缺失
 * 映射补拉等消费点依赖那份全量列表；选择器若在客户端再按 vendor 过滤，会把不在
 * 前 200 条内的供应商条目全部滤空（opencode-go 事故）。选择器按 vendor 走服务端
 * 过滤，天然拿到该供应商全部条目。
 *
 * 「已加入」判定是条目级（模型 × 供应商，2026-10-07 修复）：同名模型跨供应商时，
 * 只有目标价格映射（modelVendors[runtimeModelId] 的 priceEntryId/vendor）命中 的
 * 那一条显示「已加入」；同名但绑定其它供应商条目的行显示「同名已加入」并同样置灰
 * ——一个模型名在白名单里只有一条价格映射，点击同名条目无法产生新映射。
 */
export function usePricingCatalogPicker(input: {
  /** 供应商过滤值（undefined = 全部供应商）；与开关状态由调用方决定后传入。 */
  vendor?: string;
  /** 目标白名单（runtimeModelId 列表）：命中即视为名称已加入（含绑定其它条目的情况）。 */
  supportedModels: readonly string[];
  /** 目标价格映射（runtimeModelId → {vendor, priceEntryId}）：条目级「已加入」判定依据。 */
  modelVendors?: Readonly<Record<string, AddedModelVendorMapping>>;
}) {
  const {vendor, supportedModels, modelVendors} = input;
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [entries, setEntries] = useState<ModelPriceEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  /* 家族过滤：搜索词命中四类家族且无显式供应商过滤时，默认只查官方供应商条目。 */
  const familyVendor = vendor === undefined || vendor === ""
    ? SEARCH_FAMILY_VENDORS.find(item => item.pattern.test(debouncedSearch))?.vendor
    : undefined;
  const [familyOnly, setFamilyOnly] = useState(true);
  // 家族出现/切换时恢复默认勾选（每个新家族默认只展示官方供应商）。
  useEffect(() => {
    setFamilyOnly(true);
  }, [familyVendor]);
  const effectiveVendor = vendor ?? (familyOnly ? familyVendor : undefined);

  const fetchPage = useCallback(async (offset: number, replace: boolean): Promise<void> => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    replace ? setLoading(true) : setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        view: "catalog",
        limit: String(PRICING_PICKER_PAGE_SIZE),
        offset: String(offset),
      });
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (effectiveVendor) params.set("vendor", effectiveVendor);
      const response = await fetch(`/api/model-pricing?${params.toString()}`, {cache: "no-store"});
      const body = await response.json() as {items?: ModelPriceEntry[]; total?: number};
      // 过期响应（搜索词/供应商已变化）直接丢弃，绝不回写旧结果。
      if (requestIdRef.current !== requestId) return;
      const items = Array.isArray(body.items) ? body.items : [];
      setEntries(replace ? items : current => {
        const seen = new Set(current.map(item => item.id));
        return [...current, ...items.filter(item => !seen.has(item.id))];
      });
      setTotal(typeof body.total === "number" ? body.total : items.length);
    } catch {
      if (requestIdRef.current === requestId) {
        if (replace) {
          setEntries([]);
          setTotal(0);
        }
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [debouncedSearch, effectiveVendor]);

  // 搜索词或供应商（显式/家族）变化：回到第一页重新拉取。
  useEffect(() => {
    void fetchPage(0, true);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    void fetchPage(entries.length, false);
  }, [entries.length, fetchPage]);

  // 条目级判定：名称已在白名单 → 置灰；映射命中本条目 → 「已加入」，否则「同名已加入」。
  const supportedSet = new Set(supportedModels);
  const options: SearchableSelectOption[] = entries.map(entry => {
    const runtimeId = runtimeModelIdOf(entry);
    const nameAdded = supportedSet.has(runtimeId);
    const mapping = modelVendors?.[runtimeId];
    const entryVendor = (entry.vendor || entry.litellmProvider || "").trim().toLowerCase();
    const thisEntryAdded = nameAdded && Boolean(mapping && (mapping.priceEntryId
      ? mapping.priceEntryId === entry.id
      : (mapping.vendor || "").trim().toLowerCase() === entryVendor));
    return {
      value: entry.id,
      label: runtimeId,
      hint: entry.vendor || entry.litellmProvider || "未知供应商",
      status: !nameAdded ? "可加入" : thisEntryAdded ? "已加入" : "同名已加入",
      disabled: nameAdded,
    };
  });
  const addedCount = entries.filter(entry => {
    const runtimeId = runtimeModelIdOf(entry);
    const mapping = modelVendors?.[runtimeId];
    if (!supportedSet.has(runtimeId) || !mapping) return false;
    const entryVendor = (entry.vendor || entry.litellmProvider || "").trim().toLowerCase();
    return mapping.priceEntryId ? mapping.priceEntryId === entry.id
      : (mapping.vendor || "").trim().toLowerCase() === entryVendor;
  }).length;

  return {
    search,
    setSearch,
    entries,
    options,
    loading,
    loadingMore,
    /** 服务端总条数（含已加入行）。 */
    total,
    /** 当前已加载条目中已按本条目加入白名单的数量（供计数文案展示）。 */
    addedCount,
    /** 搜索词命中的家族供应商（仅无显式供应商过滤时出现；供搜索框下方的开关行展示）。 */
    familyVendor,
    /** 家族开关状态（默认 true=只看官方供应商；家族切换时自动复位）。 */
    familyOnly,
    setFamilyOnly,
    hasMore: entries.length < total,
    loadMore,
    /** 按条目 ID 解析选中项（供 addModel 直接消费，不依赖页面共享列表）。 */
    findEntryById: (id: string) => entries.find(entry => entry.id === id),
  };
}

function runtimeModelIdOf(entry: ModelPriceEntry): string {
  return entry.runtimeModelId || entry.match || entry.patterns[0] || entry.id;
}
