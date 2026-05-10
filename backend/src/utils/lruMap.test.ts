import { describe, it, expect } from 'vitest';
import { LRUMap } from './lruMap';

describe('LRUMap', () => {
  it('rejects non-positive max', () => {
    expect(() => new LRUMap<string, number>(0)).toThrow();
    expect(() => new LRUMap<string, number>(-1)).toThrow();
    expect(() => new LRUMap<string, number>(NaN)).toThrow();
  });

  it('stores and retrieves values', () => {
    const m = new LRUMap<string, number>(3);
    m.set('a', 1);
    m.set('b', 2);
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBe(2);
    expect(m.get('missing')).toBeUndefined();
    expect(m.size).toBe(2);
  });

  it('evicts the oldest entry when over capacity', () => {
    const m = new LRUMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3); // evicts 'a'
    expect(m.has('a')).toBe(false);
    expect(m.has('b')).toBe(true);
    expect(m.has('c')).toBe(true);
    expect(m.size).toBe(2);
  });

  it('bumps recency on get so the touched key survives eviction', () => {
    const m = new LRUMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.get('a'); // 'a' is now most-recent; 'b' is oldest
    m.set('c', 3); // evicts 'b'
    expect(m.has('a')).toBe(true);
    expect(m.has('b')).toBe(false);
    expect(m.has('c')).toBe(true);
  });

  it('peek does not bump recency', () => {
    const m = new LRUMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    expect(m.peek('a')).toBe(1);
    m.set('c', 3); // 'a' is still oldest, evicted
    expect(m.has('a')).toBe(false);
    expect(m.has('b')).toBe(true);
  });

  it('overwrites in place without growing past max', () => {
    const m = new LRUMap<string, number>(2);
    m.set('a', 1);
    m.set('a', 11);
    m.set('a', 111);
    expect(m.size).toBe(1);
    expect(m.get('a')).toBe(111);
  });

  it('delete removes the key', () => {
    const m = new LRUMap<string, number>(2);
    m.set('a', 1);
    expect(m.delete('a')).toBe(true);
    expect(m.delete('a')).toBe(false);
    expect(m.has('a')).toBe(false);
  });

  it('clear empties the map', () => {
    const m = new LRUMap<string, number>(3);
    m.set('a', 1);
    m.set('b', 2);
    m.clear();
    expect(m.size).toBe(0);
    expect(m.has('a')).toBe(false);
  });

  it('drives N+1 entries through the cap and asserts only the cap survives', () => {
    const cap = 100;
    const m = new LRUMap<number, number>(cap);
    for (let i = 0; i < cap + 50; i++) m.set(i, i);
    expect(m.size).toBe(cap);
    // First 50 should be evicted; last `cap` should remain.
    for (let i = 0; i < 50; i++) expect(m.has(i)).toBe(false);
    for (let i = 50; i < cap + 50; i++) expect(m.has(i)).toBe(true);
  });
});
