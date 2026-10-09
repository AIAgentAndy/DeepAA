"use client";

import {useEffect, useState} from "react";

/**
 * 维护测试模式常驻横幅（2026-09-11）。
 *
 * 仅当环境变量 DEEPAA_CATALOG_PATH 生效（官方目录维护人员「先测后发」验证）时显示：
 * 提示当前实例读的是本地草稿目录、未联网、且数据与正常实例隔离，避免把测试结果
 * 误当线上状态。客户端拉取模式，保证静态外壳下也能反映真实运行时配置。
 */
export function CatalogMaintenanceBanner() {
  const [override, setOverride] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/provider-catalog/maintenance-mode", {cache: "no-store"})
      .then(response => (response.ok ? response.json() : undefined))
      .then(body => {
        if (!cancelled && body?.override === true) setOverride(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!override) return null;

  return (
    <div className="catalog-maintenance-banner" role="status">
      维护测试模式：模型目录来自本地草稿文件（DEEPAA_CATALOG_PATH），未联网；本实例数据与正常实例隔离，
      请勿据此判断线上状态。测试完成后请移除该环境变量重启。
    </div>
  );
}
