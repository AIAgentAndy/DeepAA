import {
  SyncAuthRequiredError,
  type SyncConnector,
  type SyncInput,
  type SyncResult,
} from "../types";
import {NewApiAdapter, parseNewApiPayloads, type NewApiPayloads} from "./newapi";
import {newApiSyncViaPlaywright} from "./newapi-playwright";
import {Sub2ApiAdapter, parseSub2ApiPayloads, type Sub2ApiPayloads} from "./sub2api";
import {sub2ApiSyncViaPlaywright} from "./sub2api-playwright";

/**
 * 中转站合并适配器：用户只选择“中转站（基于Sub2API或NEW API）”，
 * 首次同步固定先按 Sub2API 探测（历史占比更高），失败后再按 New API；
 * 成功后由 SyncService 把实际识别的类型写入 console-credentials.json，
 * 后续同步通过 SyncInput.resolvedProvider 直达对应适配器，不再循环探测。
 * 单个类型内沿用既有降级规则：HTTP 登录失败且允许时走 Playwright 登录。
 */
export class RelayAdapter implements SyncConnector {
  readonly providerType = "relay" as const;
  readonly capabilities = {balance: true, rates: true, quota: false, auth: "http" as const};
  private readonly sub2api: Sub2ApiAdapter;
  private readonly newapi: NewApiAdapter;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.sub2api = new Sub2ApiAdapter(fetchImpl);
    this.newapi = new NewApiAdapter(fetchImpl);
  }

  async sync(input: SyncInput): Promise<SyncResult> {
    if (input.resolvedProvider === "sub2api") return this.runResolved(this.sub2api, input);
    if (input.resolvedProvider === "newapi") return this.runResolved(this.newapi, input);
    let sub2apiReason = "";
    let newApiReason = "";
    try {
      const result = await this.runResolved(this.sub2api, input);
      return result;
    } catch (error) {
      sub2apiReason = friendlySyncFailure(error);
    }
    try {
      return await this.runResolved(this.newapi, input);
    } catch (error) {
      newApiReason = friendlySyncFailure(error);
    }
    throw new Error(
      "中转站自动识别失败，该站点未通过 Sub2API / New API 登录校验：\n"
      + `· Sub2API 方式：${sub2apiReason}\n`
      + `· New API 方式：${newApiReason}\n`
      + "请先确认「控制台地址」能打开站点登录页且账号密码有效；浏览器登录组件可选，缺失不影响 HTTP 直连。",
    );
  }

  /** 单类型同步：HTTP 登录失败时按既有规则降级 Playwright 登录。 */
  private async runResolved(
    adapter: Sub2ApiAdapter | NewApiAdapter,
    input: SyncInput,
  ): Promise<SyncResult> {
    try {
      return await adapter.sync(input);
    } catch (error) {
      if (error instanceof SyncAuthRequiredError && input.allowPlaywright) {
        try {
          const payloads = adapter.providerType === "sub2api"
            ? await sub2ApiSyncViaPlaywright(input)
            : await newApiSyncViaPlaywright(input);
          const resolved = await Promise.all(input.credentials.map(async credential => ({
            id: credential.id,
            label: credential.label,
            key: await input.resolveCredential(credential.id),
          })));
          return adapter.providerType === "sub2api"
            ? parseSub2ApiPayloads(payloads as Sub2ApiPayloads, resolved)
            : parseNewApiPayloads(payloads as NewApiPayloads, resolved);
        } catch (playwrightError) {
          throw new Error(
            `${errorMessage(playwrightError)}；HTTP 登录失败原因：${errorMessage(error)}`,
          );
        }
      }
      throw error;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PLAYWRIGHT_MISSING_PATTERN = /Executable doesn't exist|Looks like Playwright|playwright install/iu;
const BROWSER_LOGIN_UNAVAILABLE = "浏览器登录未执行：本机未安装 Playwright 浏览器（可选组件）；如需浏览器登录，可运行 pnpm exec playwright install，或设置环境变量 SYNC_BROWSER_CHANNEL=chrome 复用系统 Chrome";

/**
 * 单个站点的失败摘要：给人看的短句。
 * - Playwright 缺浏览器（带 ASCII 大框的原始报错）折叠为一句话；
 * - 其余错误截掉多行装饰（遇到 ╔ 框线或换行即截断）。
 */
export function friendlySyncFailure(error: unknown): string {
  const raw = errorMessage(error);
  if (PLAYWRIGHT_MISSING_PATTERN.test(raw)) {
    // HTTP 层的真实原因（登录 404/密码错误等）通常在 Playwright 错误之前已被
    // 调用方拼进同一条消息里，这里只替换浏览器部分，避免吞掉关键信息。
    const httpPart = raw.split("browserType.launch")[0]?.trim().replace(/[；;]\s*$/, "") ?? "";
    return httpPart && !PLAYWRIGHT_MISSING_PATTERN.test(httpPart)
      ? `${httpPart}；${BROWSER_LOGIN_UNAVAILABLE}`
      : BROWSER_LOGIN_UNAVAILABLE;
  }
  const boxIndex = raw.search(/[╔╚]/u);
  const singleLine = (boxIndex >= 0 ? raw.slice(0, boxIndex) : raw).split("\n")[0]?.trim() ?? raw;
  return singleLine || raw;
}
