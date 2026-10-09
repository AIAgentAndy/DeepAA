/**
 * Plan Calculator 注册表（设计 4.4/10.3）：目录 Profile.calculator → 现有
 * computePlanCredit 公式族的映射与合法性校验。新增全新公式=新增受测试插件。
 */
import type {PlanCreditRules} from "@/lib/pricing";
import type {ProviderPlanProfile} from "./types";

export type SupportedCalculatorKind = "token_weighted" | "afp_weighted" | "money_to_credits" | "market_share";

export interface CalculatorBinding {
  kind: SupportedCalculatorKind;
  /** computePlanCredit 的公式族名（与 kind 同名）。 */
  formula: PlanCreditRules["formula"];
  /** 校验 Profile calculator 字段是否满足该公式输入；返回错误消息数组。 */
  validate: (calculator: ProviderPlanProfile["calculator"]) => string[];
}

export const CALCULATOR_REGISTRY: Readonly<Record<SupportedCalculatorKind, CalculatorBinding>> = {
  token_weighted: {
    kind: "token_weighted",
    formula: "token_weighted",
    // 无 calculator 级强制字段（divisor 缺省 10000）；模型级 planFactors 由逐模型投影校验。
    validate: () => [],
  },
  afp_weighted: {
    kind: "afp_weighted",
    formula: "afp_weighted",
    validate: calculator =>
      calculator.cacheRead === undefined || calculator.cacheRead === "input"
        ? []
        : ["afp_weighted 只支持 cacheRead=input（缓存按输入系数计入官方口径）"],
  },
  money_to_credits: {
    kind: "money_to_credits",
    formula: "money_to_credits",
    validate: calculator =>
      typeof calculator.creditsPerCurrency === "number" && Number.isFinite(calculator.creditsPerCurrency) && calculator.creditsPerCurrency > 0
        ? []
        : ["money_to_credits 计算器必须声明 creditsPerCurrency > 0"],
  },
  /* 市价份额制（OpenCode Go）：无逐请求积分公式——分子=市价消耗（估算走市价回退），
     分母=模型×档位月度美元额度（模型级 planMonthlyLimitUsd 投影为 quotaTiers）。 */
  market_share: {
    kind: "market_share",
    formula: "market_share",
    validate: calculator =>
      calculator.unit === "USD"
        ? []
        : ["market_share 计算器必须声明 unit=USD（模型级 planMonthlyLimitUsd 为美元口径）"],
  },
};

export function isSupportedCalculatorKind(value: unknown): value is SupportedCalculatorKind {
  return typeof value === "string" && value in CALCULATOR_REGISTRY;
}

/** Profile → 现有公式名映射（编译投影消费）；不支持的 kind 由调用方先行隔离。 */
export function calculatorFormulaFor(profile: ProviderPlanProfile): PlanCreditRules["formula"] | undefined {
  const calculator = profile.calculator;
  if (!isSupportedCalculatorKind(calculator?.kind)) return undefined;
  const binding = CALCULATOR_REGISTRY[calculator.kind];
  return binding.validate(calculator).length === 0 ? binding.formula : undefined;
}

/** Profile calculator 字段合法性；返回错误消息数组（空=通过）。 */
export function validateProfileCalculator(profile: ProviderPlanProfile): string[] {
  const calculator = profile.calculator;
  if (!calculator || !isSupportedCalculatorKind(calculator.kind)) {
    return [`calculator.kind 未知或不支持: ${String(calculator?.kind)}`];
  }
  return CALCULATOR_REGISTRY[calculator.kind].validate(calculator);
}
