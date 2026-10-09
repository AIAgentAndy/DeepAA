export interface NiceTickOptions {
  /** 请求数量等离散指标不允许出现小数刻度。 */
  integerOnly?: boolean;
}

const NICE_MULTIPLIERS = [1, 2, 2.5, 5, 10] as const;

/**
 * 按当前可见最大值生成贴近数据的 Y 轴刻度。
 * 允许最多七段，是为了满足 65M 使用 10M 步进并以 70M 封顶的展示规则。
 */
export function buildNiceTicks(maximum: number, options: NiceTickOptions = {}): number[] {
  if (!Number.isFinite(maximum) || maximum <= 0) return [0, 1];
  const rawStep = maximum / 7;
  const power = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / power;
  const multiplier = NICE_MULTIPLIERS.find(value => normalized <= value) ?? 10;
  let step = multiplier * power;
  if (options.integerOnly) step = Math.max(1, Math.ceil(step));
  const top = Math.ceil(maximum / step) * step;
  const intervals = Math.max(1, Math.round(top / step));
  return Array.from({length: intervals + 1}, (_, index) => normalizeFloatingPoint(index * step));
}

/** Token 坐标轴固定使用 M/K，避免亿单位造成阅读跳变。 */
export function formatTokenAxis(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${formatCompact(value / 1_000_000)}M`;
  if (absolute >= 1_000) return `${formatCompact(value / 1_000)}K`;
  return formatCompact(value);
}

function formatCompact(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.0+$/u, "").replace(/(\.\d*[1-9])0+$/u, "$1");
}

function normalizeFloatingPoint(value: number): number {
  return Number(value.toPrecision(12));
}
