/**
 * Playwright 同步整体截止守卫（2026-10-10 修复）。
 *
 * 缺陷背景：page.evaluate 不受 Playwright 任何默认超时约束，页内 fetch 挂起
 * （站点不结束响应）会让 evaluate 永久 pending——finally 里的 browser.close()
 * 永不执行（Chromium 进程泄漏），外层单飞调度器的 running 永不释放（账号/
 * 套餐/对账全部停摆）。
 *
 * 锁定 createPlaywrightDeadline 四条语义：工作先完成则透传且不触发 release；
 * 到期先 release（强制关浏览器）再以稳定错误码拒绝；deadline 触发后输家的
 * 迟到拒绝不产生 unhandledRejection；race 从未被调用时 clear 无泄漏。
 */
import assert from "node:assert/strict";
import {describe, test} from "vitest";
import {createPlaywrightDeadline} from "@/lib/sync-engine/adapters/playwright-deadline";

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe("Playwright 同步整体截止（2026-10-10 evaluate 永久挂起修复）", () => {
  test("工作先完成：结果透传、release 不触发、定时器清理", async () => {
    let released = false;
    const deadline = createPlaywrightDeadline(() => {
      released = true;
    }, 30);
    assert.equal(await deadline.race(Promise.resolve("ok")), "ok");
    deadline.clear();
    await sleep(80);
    assert.equal(released, false, "正常完成后不得触发强制关闭");
  });

  test("到期：先 release 再以稳定错误码拒绝", async () => {
    let released = false;
    const deadline = createPlaywrightDeadline(() => {
      released = true;
    }, 30);
    await assert.rejects(
      deadline.race(new Promise<never>(() => undefined)),
      /SYNC_PLAYWRIGHT_DEADLINE_EXCEEDED/u,
    );
    assert.equal(released, true, "超时必须先强制关闭浏览器（pending evaluate 才会真正释放）");
    deadline.clear();
  });

  test("deadline 触发后输家的迟到拒绝不产生 unhandledRejection", async () => {
    const deadline = createPlaywrightDeadline(() => undefined, 30);
    let rejectWork: ((reason?: unknown) => void) | undefined;
    const work = new Promise<string>((_, reject) => {
      rejectWork = reject;
    });
    await assert.rejects(deadline.race(work), /SYNC_PLAYWRIGHT_DEADLINE_EXCEEDED/u);
    // 模拟浏览器被关闭后 evaluate 的迟到拒绝：race 已处理过该输入，不得变成
    // 进程级 unhandledRejection。
    rejectWork?.(new Error("Target closed"));
    await sleep(30);
  });

  test("未 race 直接 clear：无定时器泄漏、无未处理拒绝", async () => {
    const deadline = createPlaywrightDeadline(() => {
      throw new Error("clear 之后不得触发 release");
    }, 30);
    deadline.clear();
    await sleep(80);
  });
});
