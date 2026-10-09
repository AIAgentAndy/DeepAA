const MAX_CONCURRENT_EXPLICIT_RAW_TASKS = 2;

export interface ExplicitRawLease {
  release: () => void;
}

export interface ExplicitRawLeaseMetrics {
  active: number;
  busy: number;
}

const metrics: ExplicitRawLeaseMetrics = {
  active: 0,
  busy: 0,
};

/**
 * Next 后链路的所有显式 Raw 消费入口共享此额度。
 * 单个页面任务内部必须顺序读取 Exchange，不能为每条正文重复获取额度。
 */
export function acquireExplicitRawLease(): ExplicitRawLease | undefined {
  if (metrics.active >= MAX_CONCURRENT_EXPLICIT_RAW_TASKS) {
    metrics.busy += 1;
    return undefined;
  }
  metrics.active += 1;
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      metrics.active = Math.max(0, metrics.active - 1);
    },
  };
}

export function getExplicitRawLeaseMetrics(): ExplicitRawLeaseMetrics {
  return { ...metrics };
}

export function resetExplicitRawLeasesForTests(): void {
  metrics.active = 0;
  metrics.busy = 0;
}
