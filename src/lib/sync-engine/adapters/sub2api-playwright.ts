import type {SyncInput} from "../types";
import {SyncAuthRequiredError} from "../types";
import type {Sub2ApiPayloads} from "./sub2api";
import {createPlaywrightDeadline} from "./playwright-deadline";

const LOGIN_TIMEOUT_MS = 30_000;
const TOKEN_WAIT_TIMEOUT_MS = 20_000;

/**
 * Sub2API Playwright 登录器：只负责打开控制台登录页、自动填邮箱密码完成登录，
 * 数据一律在页面内同源 fetch 面板自带 API（/api/v1/user/profile、/api/v1/keys、/api/v1/groups/rates），
 * 解析层与 HTTP 主链路共用（parseSub2ApiPayloads）。
 * 验证码 / 2FA / OIDC 场景下首次登录需要用户人工完成一次。
 */
export async function sub2ApiSyncViaPlaywright(
  input: SyncInput,
): Promise<Sub2ApiPayloads> {
  // playwright 是可选运行时依赖：通过动态 import 加载，未安装时给出明确提示。
  // 使用 new Function 包装以避免静态解析把可选依赖打进代理/业务产物。
  const playwright = await loadPlaywright();

  const channel = process.env.SYNC_BROWSER_CHANNEL?.trim() || undefined;
  const browser = await playwright.chromium.launch({
    headless: true,
    ...(channel ? {channel} : {}),
  });
  // 整体截止（2026-10-10 修复，锚点 = 浏览器启动后）：page.evaluate 无 Playwright
  // 默认超时，页内 fetch 挂起会永久 pending——finally 的 close 不执行（浏览器泄漏）、
  // 单飞调度器 running 永不释放。到期强制关浏览器并走正常同步失败路径。
  const deadline = createPlaywrightDeadline(() => {
    void browser.close().catch(() => undefined);
  });
  try {
    const page = await browser.newPage();
    await page.goto(`${input.consoleBaseUrl.replace(/\/+$/u, "")}/login`, {
      waitUntil: "domcontentloaded",
      timeout: LOGIN_TIMEOUT_MS,
    });

    const passwordInput = page.locator('input[type="password"]');
    if (await passwordInput.count() > 0) {
      const emailInput = page.locator(
        'input[type="email"], input[name="email"], input[autocomplete="email"], input[name="username"]',
      ).first();
      if (await emailInput.count() > 0) {
        await emailInput.fill(input.username);
      }
      await passwordInput.fill(input.password);
      await Promise.all([
        page.waitForLoadState("networkidle", {timeout: 15_000}).catch(() => undefined),
        passwordInput.press("Enter"),
      ]);
    }

    await page.waitForFunction(
      () => {
        const token = localStorage.getItem("access_token") || localStorage.getItem("token");
        return typeof token === "string" && token.length > 0;
      },
      {timeout: TOKEN_WAIT_TIMEOUT_MS},
    ).catch(() => undefined);

    const payloads = await deadline.race(page.evaluate(async () => {
      const token = localStorage.getItem("access_token") || localStorage.getItem("token") || "";
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(token ? {authorization: `Bearer ${token}`} : {}),
      };
      const grab = async (path: string): Promise<unknown> => {
        try {
          // 页内单请求超时（字面量：evaluate 序列化不携带外部作用域）：站点挂起时
          // 该端点快速失败为 null，不拖住整个 evaluate；整体兜底由外层 deadline 负责。
          const response = await fetch(path, {
            headers,
            credentials: "same-origin",
            signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
              ? AbortSignal.timeout(20_000)
              : undefined,
          });
          return response.ok ? await response.json() : null;
        } catch {
          return null;
        }
      };
      return {
        profile: await grab("/api/v1/user/profile"),
        keys: await grab("/api/v1/keys?page=1&page_size=200"),
        rates: await grab("/api/v1/groups/rates"),
      };
    }));

    const selfData = payloads && typeof payloads === "object" && "profile" in payloads
      ? (payloads as Sub2ApiPayloads)
      : undefined;
    if (!selfData) throw new SyncAuthRequiredError("SYNC_PLAYWRIGHT_PAYLOAD_INVALID");
    return selfData;
  } finally {
    deadline.clear();
    await browser.close().catch(() => undefined);
  }
}

async function loadPlaywright(): Promise<{
  chromium: {launch(options?: Record<string, unknown>): Promise<BrowserLike>};
}> {
  try {
    return await new Function("return import('playwright')")() as never;
  } catch {
    throw new Error(
      "PLAYWRIGHT_NOT_INSTALLED：需要先执行 pnpm install 并安装 chromium（pnpm exec playwright install chromium），"
      + "或设置 SYNC_BROWSER_CHANNEL=chrome 复用系统 Chrome",
    );
  }
}

interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

interface PageLike {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  locator(selector: string): LocatorLike;
  waitForLoadState(state: string, options: Record<string, unknown>): Promise<void>;
  waitForFunction(fn: () => unknown, options: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
}

interface LocatorLike {
  count(): Promise<number>;
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
  first(): LocatorLike;
}
