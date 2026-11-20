/**
 * Insertion-order LRU map. `get` and `set` bump the entry to most-recent.
 * When the map exceeds `max`, the least-recently-touched key is evicted.
 *
 * Backed by a plain Map, which preserves insertion order in JS — the trick is
 * to delete-then-set on every touch so the iterator order matches recency.
 */
export class LRUMap<K, V> {
  private readonly max: number;
  private readonly map = new Map<K, V>();

  constructor(max: number) {
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error('LRUMap max must be a positive finite number');
    }
    this.max = max;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** Read without bumping recency — useful when you only need to check presence. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  clear(): void {
    this.map.clear();
  }
}
