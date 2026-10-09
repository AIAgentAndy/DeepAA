"use client";

/**
 * 保留窗口范围提示（2026-09-21 用户确认）：会话追踪 / 交互内容页的查询区旁
 * 展示「超过保留天数的数据可能不完整」说明；「数据清理机制」为锚点，经
 * deepaa:open-storage-management 事件通道（与价格中心 deepaa:open-pricing-settings
 * 同一模式）打开右上角「管理」菜单挂载的存储管理弹窗。
 */
export const OPEN_STORAGE_MANAGEMENT_EVENT = "deepaa:open-storage-management";

export function RetentionScopeNotice({
  retentionDays,
  stacked = false,
}: {
  retentionDays: number;
  /** 查询区右侧的两行展示（会话追踪时间条）；缺省单行（交互内容筛选区）。 */
  stacked?: boolean;
}) {
  return (
    <span className={`retention-scope-notice${stacked ? " stacked" : ""}`}>
      按 <button
        type="button"
        className="retention-scope-link"
        onClick={() => window.dispatchEvent(new Event(OPEN_STORAGE_MANAGEMENT_EVENT))}
      >数据清理机制</button> 配置{stacked ? <br /> : "，"}
      超过 {retentionDays} 天范围的数据可能不完整。
    </span>
  );
}
