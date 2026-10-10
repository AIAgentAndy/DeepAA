/**
 * Playwright 同步整体截止（2026-10-10 修复）。
 *
 * 缺陷背景：`page.evaluate` 不受 Playwright 任何默认超时约束（goto / fill /
 * press / waitFor* 各有显式或默认超时，evaluate 没有），页内 fetch 挂起（站点
 * 不结束响应、连接半开）会让 evaluate 永久 pending——finally 里的
 * `browser.close()` 永不执行（Chromium 进程泄漏），外层单飞调度器的 running
 * 永不释放（后续账号 / 套餐 / 对账 tick 全部直接 return；数据库侧 10 分钟陈旧
 * 救援同样依赖 tick 存活，对此无效）。
 *
 * 语义：到期先执行 release（关浏览器，使 pending 的 evaluate 以 "Target closed"
 * 真正拒绝、资源真正释放），再以稳定错误码拒绝走正常同步失败路径（记录失败 +
 * 退避）。`Promise.race` 会给所有输入挂接处理器，输家的迟到拒绝不会变成
 * unhandledRejection。
 */
export const PLAYWRIGHT_SYNC_DEADLINE_MS = 180_000;

export interface PlaywrightDeadline {
  /** 工作先完成则透传其结果并保持沉默（定时器由 clear 收尾）。 */
  race<T>(work: Promise<T>): Promise<T>;
  /** 正常路径收尾：清除定时器（此后 deadline 永不触发）。 */
  clear(): void;
}

export function createPlaywrightDeadline(
  release: () => void,
  deadlineMs: number = PLAYWRIGHT_SYNC_DEADLINE_MS,
): PlaywrightDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timer = undefined;
      try {
        release();
      } catch {
        /* release 失败不掩盖超时根因。 */
      }
      reject(new Error(`SYNC_PLAYWRIGHT_DEADLINE_EXCEEDED（${deadlineMs}ms，浏览器已强制关闭）`));
    }, deadlineMs);
    timer.unref?.();
  });
  // 防御性挂接：race 从未被调用（evaluate 之前的步骤抛错）时，到期拒绝也不得
  // 变成 unhandledRejection。
  deadline.catch(() => undefined);
  return {
    race<T>(work: Promise<T>): Promise<T> {
      return Promise.race([work, deadline]);
    },
    clear(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
