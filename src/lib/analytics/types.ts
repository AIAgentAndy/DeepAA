export type AnalyticsPreset = "today" | "24h" | "this_week" | "7d" | "this_month" | "30d";
export type AnalyticsGranularity = "hour" | "day";

export interface AnalyticsWindow {
  start: string;
  end: string;
}

export interface AnalyticsRangeResult {
  preset: AnalyticsPreset;
  timezone: string;
  range: AnalyticsWindow;
  granularity: AnalyticsGranularity;
  now: string;
}

export type UsageQuality = "exact" | "estimated" | "unavailable";
export type PricingStatus =
  | "priced"
  | "unpriced_unmatched"
  | "unpriced_ambiguous"
  | "unpriced_unverified"
  | "unpriced_stale"
  | "not_applicable";
export type ResultClass =
  | "success"
  | "client_error"
  | "upstream_error"
  | "proxy_error"
  | "cancelled"
  | "incomplete"
  | "unknown";
export type TotalTokensBasis = "provider" | "derived" | "legacy_unknown" | "unavailable";
export type ReferenceCostStatus = "available" | "estimated" | "missing_price" | "unavailable";
export type ValueEstimationStatus =
  | "available"
  | "missing_fee"
  | "missing_reference_price"
  | "currency_mismatch"
  | "incomplete_window"
  | "low_quality";
