/**
 * 字节预算有界 LRU（2026-10-10 资源治理公共件，A 修复抽取）。
 *
 * 语义对齐 dsh 适配器的内联正文缓存惯例：Map 插入序即使用序（命中重插到尾）、
 * 超预算从最旧端逐出、**至少保留 1 条**（避免「刚插入即被自身逐出」的自噬）。
 * bytesOf 由调用方提供（近似值即可，宁可高估——高估只会提前逐出，不会泄漏）。
 * 供 codex 正文 items 缓存使用；dsh 现有内联实现语义相同，为控制改动风险暂不迁移。
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
   * 插入/覆盖并按预算逐出最旧端；至少保留刚插入的这条（同 dsh 惯例）。
   * 单条自身超预算时不逐出自己（否则 set 立即失效，调用方无法使用）。
   */
  set(key: K, value: V): void {
    const previous = this.#entries.get(key);
    if (previous !== undefined) {
      this.#totalBytes -= previous.bytes;
      this.#entries.delete(key);
    }
    const bytes = Math.max(0, this.#bytesOf(value));
    this.#entries.set(key, {value, bytes});
    this.#totalBytes += bytes;
    while (this.#totalBytes > this.#maxBytes && this.#entries.size > 1) {
      const oldest = this.#entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      const evicted = this.#entries.get(oldest);
      this.#entries.delete(oldest);
      this.#totalBytes -= evicted?.bytes ?? 0;
    }
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
