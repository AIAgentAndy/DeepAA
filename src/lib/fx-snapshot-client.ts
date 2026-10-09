/**
 * 目录 fx 快照的前端加载（2026-09-28 币种展示配套）：
 * 一次性拉取 /api/model-pricing?view=fx（几十字节），模块级缓存全页复用；
 * 供供应商页/仪表盘「原值（约￥等值）」的括号换算（resolveDisplayFxRate 的 fxUsdCny 入参）。
 * 拉取失败保持 undefined：展示层降级为不带括号等值，绝不让汇率缺失阻塞页面。
 */

import {useEffect, useState} from "react";

export interface FxSnapshotInfo {
  rate: number;
  asOf?: string;
  source?: string;
  /** true = 生效配置无 fx 快照，rate 是随包默认值（展示端可据此提示口径不确定）。 */
  fallback: boolean;
}

const FX_ENDPOINT = "/api/model-pricing?view=fx";

let cached: FxSnapshotInfo | undefined;
let inflight: Promise<FxSnapshotInfo | undefined> | undefined;

/** 加载 fx 快照（默认命中模块级缓存；force 强制刷新）。失败返回 undefined。 */
export async function loadFxSnapshot(force = false): Promise<FxSnapshotInfo | undefined> {
  if (cached && !force) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const response = await fetch(FX_ENDPOINT, {cache: "no-store"});
      if (!response.ok) return undefined;
      const payload = await response.json() as {fx?: {rate?: unknown; asOf?: unknown; source?: unknown; fallback?: unknown}};
      const fx = payload.fx;
      if (!fx || typeof fx.rate !== "number" || !Number.isFinite(fx.rate) || fx.rate <= 0) return undefined;
      cached = {
        rate: fx.rate,
        ...(typeof fx.asOf === "string" ? {asOf: fx.asOf} : {}),
        ...(typeof fx.source === "string" ? {source: fx.source} : {}),
        fallback: fx.fallback === true,
      };
      return cached;
    } catch {
      return undefined;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** 客户端 hook：一次性读取目录 fx 快照（模块级缓存复用）。 */
export function useFxSnapshot(): FxSnapshotInfo | undefined {
  const [snapshot, setSnapshot] = useState<FxSnapshotInfo | undefined>(cached);
  useEffect(() => {
    if (cached) {
      setSnapshot(cached);
      return;
    }
    let alive = true;
    void loadFxSnapshot().then(info => {
      if (alive && info) setSnapshot(info);
    });
    return () => {
      alive = false;
    };
  }, []);
  return snapshot;
}
