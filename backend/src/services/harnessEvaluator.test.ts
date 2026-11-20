import { describe, it, expect } from 'vitest';
import type { RetrievalTrace } from './traceLogger';
import { harnessEvaluator } from './harnessEvaluator';
import type { HarnessProposal } from '../types/harness';

const proposal = (deltas: Record<string, number>): HarnessProposal => ({
  id: 'p', runId: 'r', iteration: 1, ts: '', deltas: deltas as HarnessProposal['deltas'],
  rationale: '', targetsFailureModes: [],
});

const trace = (i: number, outcome: RetrievalTrace['outcome'], scores: number[], suppressed: number[] = []): RetrievalTrace => ({
  id: `t${i}`,
  outcome,
  mode: 'chat',
  pipelineMs: 100,
  active: scores.map((score, j) => ({ id: `a${i}-${j}`, text: 'x'.repeat(400), type: 'memory', score, status: 'active' })),
  suppressed: suppressed.map((score, j) => ({ id: `s${i}-${j}`, text: 'y'.repeat(400), type: 'memory', score, status: 'suppressed' })),
  promptTokens: { memory: scores.length * 100, rules: 0, workspace: 0, conversationHistory: 0, systemPrompt: 0, total: 1000 + scores.length * 100, budget: 4096 },
} as unknown as RetrievalTrace);

describe('HarnessEvaluator', () => {
  it('evaluates the most recent 50 traces, not the oldest', async () => {
    const traces = Array.from({ length: 80 }, (_, i) => trace(i, 'accepted', [0.7]));
    const result = await harnessEvaluator.evaluate(proposal({}), traces);
    expect(result.searchSetSize).toBe(50);
    expect(result.traceIds[0]).toBe('t30');
    expect(result.traceIds[49]).toBe('t79');
  });

  it('accepts the snapshot key MIN_SCORE_STANDARD as well as MIN_SCORE_STANDARD_CONTEXT', async () => {
    const traces = [trace(0, 'accepted', [0.62, 0.9])];
    const a = await harnessEvaluator.evaluate(proposal({ MIN_SCORE_STANDARD: 0.7 }), traces);
    const b = await harnessEvaluator.evaluate(proposal({ MIN_SCORE_STANDARD_CONTEXT: 0.7 }), traces);
    expect(a.avgActiveItems).toBe(1);
    expect(b.avgActiveItems).toBe(1);
  });

  it('recomputes tokens and acceptance instead of reporting them unchanged', async () => {
    const traces = [trace(0, 'accepted', [0.62, 0.9]), trace(1, 'correction', [0.61, 0.95])];
    const base = await harnessEvaluator.evaluate(proposal({}), traces);
    const strict = await harnessEvaluator.evaluate(proposal({ MIN_SCORE_STANDARD_CONTEXT: 0.7 }), traces);
    expect(strict.avgPromptTokens).toBeLessThan(base.avgPromptTokens);
    expect(strict.acceptanceRate).not.toBe(base.acceptanceRate);
    expect(strict.avgSuppressedItems).toBe(1);
  });

  it('moves count-capped items into suppressed', async () => {
    const traces = [trace(0, 'accepted', [0.9, 0.8, 0.7, 0.65])];
    const result = await harnessEvaluator.evaluate(proposal({ RETRIEVAL_COUNT_DEFAULT: 2 }), traces);
    expect(result.avgActiveItems).toBe(2);
    expect(result.avgSuppressedItems).toBe(2);
  });

  it('promotes suppressed items when the threshold is lowered', async () => {
    const traces = [trace(0, 'accepted', [0.9], [0.55, 0.3])];
    const result = await harnessEvaluator.evaluate(proposal({ MIN_SCORE_STANDARD_CONTEXT: 0.5 }), traces);
    expect(result.avgActiveItems).toBe(2);
    expect(result.avgSuppressedItems).toBe(1);
  });
});

describe('ProposerAgent.validateDeltas', () => {
  it('uses per-key bounds, maps snapshot aliases, and drops unknown / non-finite keys', async () => {
    const { proposerAgent } = await import('./proposerAgent');
    const validate = (d: Record<string, unknown>) =>
      (proposerAgent as unknown as { validateDeltas(x: Record<string, unknown>): Record<string, number> }).validateDeltas(d);
    const out = validate({
      SCORE_BOOST_PER_RETRIEVAL: 0.03, // small boost must not be clamped up to 0.3
      MIN_SCORE_STANDARD: 0.7,         // alias → MIN_SCORE_STANDARD_CONTEXT
      RETRIEVAL_COUNT_DEFAULT: 99.4,   // clamped + rounded
      SCORE_BOOST_TAG_MATCH: NaN,
      NOT_A_REAL_KEY: 0.5,
    });
    expect(out).toEqual({
      SCORE_BOOST_PER_RETRIEVAL: 0.03,
      MIN_SCORE_STANDARD_CONTEXT: 0.7,
      RETRIEVAL_COUNT_DEFAULT: 20,
    });
  });
});
