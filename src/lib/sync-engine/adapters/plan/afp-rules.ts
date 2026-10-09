export interface AfpTokenUsage {
  inputTokens: number;
  cacheReadTokens?: number;
  outputTokens: number;
}

export interface AfpFactors {
  input: number;
  output: number;
  /** 缓存命中若未单独声明，按 input 系数计入。 */
  cachedInput?: number;
}

/** 火山套餐 AFP 基础公式：加权 Token / 10000。 */
export function calculateAfp(
  usage: AfpTokenUsage,
  factors: AfpFactors,
): number {
  const inputTokens = Math.max(0, usage.inputTokens);
  const cacheReadTokens = Math.max(0, usage.cacheReadTokens ?? 0);
  const outputTokens = Math.max(0, usage.outputTokens);
  const cacheFactor = factors.cachedInput ?? factors.input;
  return (
    inputTokens * factors.input
    + cacheReadTokens * cacheFactor
    + outputTokens * factors.output
  ) / 10_000;
}
