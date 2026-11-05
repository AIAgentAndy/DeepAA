/**
 * 字节预算有界 LRU（2026-10-10 资源治理公共件，A 修复抽取）。
 *
 * Map 插入序即使用序（命中重插到尾）、超预算从最旧端逐出。
 * bytesOf 由调用方提供（近似值即可，宁可高估——高估只会提前逐出，不会泄漏）。
 *
 * OOM 修复（2026-11-05）：**移除「单条可超预算」例外**——旧语义「至少保留 1 条」
 * 使任一超预算单条（如 124MB 会话的全量 items，真实堆 150-300MB）无视 64MiB 预算
 * 无条件常驻且 GC 永收不走（生产 768MB 堆被打穿的驻留主体）。新语义：单条自身
 * 超预算时**拒绝插入**（返回 false，条目不驻留），调用方本就具备 miss 时从磁盘
 * 有界重建的能力（codex ContentCacheEntry / scheduler SessionContextCache 均然），
 * 首次 set 即超限的条目由调用方按需重建，语义与「被立即逐出」等价且不泄漏。
 */

export interface BoundedLruOptions<V> {
  /** 保留字节总量上限（近似口径，由 bytesOf 定义）。 */
  maxBytes: number;
  /** 值的近似字节成本（在 set 时计算一次）。 */
  bytesOf: (value: V) => number;
}

interface Entry<V> {
  value: V;
  bytes: number;
}

export class BoundedLruMap<K, V> {
  readonly #maxBytes: number;
  readonly #bytesOf: (value: V) => number;
  readonly #entries = new Map<K, Entry<V>>();
  #totalBytes = 0;

  constructor(options: BoundedLruOptions<V>) {
    if (!Number.isFinite(options.maxBytes) || options.maxBytes < 0) {
      throw new Error("BoundedLruMap maxBytes 必须是非负有限数。");
    }
    this.#maxBytes = options.maxBytes;
    this.#bytesOf = options.bytesOf;
  }

  /** 命中即触达（重插到尾）；未命中返回 undefined。 */
  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  /**
   * 插入/覆盖并按预算逐出最旧端。单条自身超预算时拒绝插入（返回 false，
   * OOM 修复新语义——超预算单条不再无条件驻留）；成功返回 true。
   * 覆盖既有键且新值超限时：旧条目保留（不破坏既有可用性）。
   */
  set(key: K, value: V): boolean {
    const previous = this.#entries.get(key);
    if (previous !== undefined) {
      this.#totalBytes -= previous.bytes;
      this.#entries.delete(key);
    }
    const bytes = Math.max(0, this.#bytesOf(value));
    if (bytes > this.#maxBytes) {
      // 单条超预算：拒绝驻留。恢复 previous（若有）使覆盖语义不破坏旧值。
      if (previous !== undefined) {
        this.#entries.set(key, previous);
        this.#totalBytes += previous.bytes;
      }
      return false;
    }
    this.#entries.set(key, {value, bytes});
    this.#totalBytes += bytes;
    while (this.#totalBytes > this.#maxBytes && this.#entries.size > 0) {
      const oldest = this.#entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      const evicted = this.#entries.get(oldest);
      this.#entries.delete(oldest);
      this.#totalBytes -= evicted?.bytes ?? 0;
      // 被逐出的若是刚插入的自身,同样如实逐出（预算是硬约束）。
    }
    return true;
  }

  delete(key: K): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    this.#entries.delete(key);
    this.#totalBytes -= entry.bytes;
    return true;
  }

  /** 当前条目数（观测/测试）。 */
  get size(): number {
    return this.#entries.size;
  }

  /** 当前保留字节总量（近似口径，观测/测试）。 */
  get totalBytes(): number {
    return this.#totalBytes;
  }
}
