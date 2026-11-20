import { describe, it, expect } from 'vitest';
import { parseLlmJson } from './llmJson';

describe('parseLlmJson', () => {
  it('parses plain JSON', () => {
    expect(parseLlmJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips <think> blocks and markdown fences', () => {
    expect(parseLlmJson('<think>hmm {not json}</think>\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('recovers JSON surrounded by prose', () => {
    expect(parseLlmJson('Here you go: {"results":[1,2]} — done.')).toEqual({ results: [1, 2] });
  });

  it('throws when there is no JSON', () => {
    expect(() => parseLlmJson('no json here')).toThrow();
  });
});
