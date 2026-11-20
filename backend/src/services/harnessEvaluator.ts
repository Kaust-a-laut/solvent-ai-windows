import { traceLogger, RetrievalTrace } from './traceLogger';
import { HarnessProposal, EvaluationResult } from '../types/harness';
import { MIN_SCORE_STANDARD_CONTEXT } from './contextService';

type ProvenanceItem = RetrievalTrace['active'][number];

/** A trace after the proposal's parameters are re-applied, plus a simulated acceptance proxy in [0, 1]. */
interface SimulatedTrace extends RetrievalTrace {
  simulatedAcceptance: number;
}

const SEARCH_SET_SIZE = 50;

/** Rough token estimate for a provenance item (≈4 chars/token). */
function itemTokens(item: ProvenanceItem, fallback: number): number {
  return typeof item.text === 'string' && item.text.length > 0 ? Math.ceil(item.text.length / 4) : fallback;
}

/**
 * Evaluates a proposed harness configuration against the existing trace data.
 *
 * In Phase C, this is a retrospective evaluation: it simulates how the proposed
 * parameters would have filtered the existing traces. In Phase C+, this would
 * run the proposed config live against a held-out search set of real queries.
 */
export class HarnessEvaluator {
  /**
   * Evaluates a proposal by simulating its parameter changes against
   * the recent trace history.
   */
  async evaluate(proposal: HarnessProposal, allTraces?: RetrievalTrace[]): Promise<EvaluationResult> {
    const traces = allTraces || await traceLogger.readTraces();
    if (traces.length === 0) {
      return this.emptyResult(proposal);
    }

    // Traces are stored oldest-first (append-only JSONL), so the most recent
    // 50 are the tail — slice(0, 50) evaluated against the oldest history.
    const searchSet = traces.slice(-SEARCH_SET_SIZE);

    // Simulate: apply the proposed deltas and re-evaluate which items would have been active/suppressed
    const simulated = this.simulateProposal(searchSet, proposal);

    // Compute metrics
    const total = simulated.length;
    const acceptance = simulated.reduce((s, t) => s + t.simulatedAcceptance, 0);
    const corrections = simulated.filter(t => t.outcome === 'correction').length;

    const avgActive = simulated.reduce((s, t) => s + t.active.length, 0) / total;
    const avgSuppressed = simulated.reduce((s, t) => s + t.suppressed.length, 0) / total;
    const avgTokens = simulated.reduce((s, t) => s + (t.promptTokens?.total || 0), 0) / total;
    const avgMs = simulated.reduce((s, t) => s + t.pipelineMs, 0) / total;

    // Per-mode breakdown
    const byMode: Record<string, { count: number; acceptanceRate: number; avgTokens: number }> = {};
    for (const t of simulated) {
      const mode = t.mode || 'unknown';
      if (!byMode[mode]) byMode[mode] = { count: 0, acceptanceRate: 0, avgTokens: 0 };
      byMode[mode].count++;
      byMode[mode].acceptanceRate += t.simulatedAcceptance;
      byMode[mode].avgTokens += t.promptTokens?.total || 0;
    }
    for (const mode of Object.keys(byMode)) {
      const entry = byMode[mode]!;
      entry.acceptanceRate /= entry.count;
      entry.avgTokens /= entry.count;
    }

    return {
      proposalId: proposal.id,
      runId: proposal.runId,
      ts: new Date().toISOString(),
      searchSetSize: searchSet.length,
      acceptanceRate: acceptance / total,
      correctionRate: corrections / total,
      avgActiveItems: avgActive,
      avgSuppressedItems: avgSuppressed,
      avgPromptTokens: avgTokens,
      avgPipelineMs: avgMs,
      byMode,
      isParetoOptimal: true, // Will be updated by the optimizer
      traceIds: searchSet.map(t => t.id),
    };
  }

  private simulateProposal(traces: RetrievalTrace[], proposal: HarnessProposal): SimulatedTrace[] {
    const deltas = proposal.deltas as Record<string, number | undefined>;
    // The proposer sees getHarnessSnapshot(), which names the threshold
    // MIN_SCORE_STANDARD, while the proposal type uses
    // MIN_SCORE_STANDARD_CONTEXT — honour either.
    const newMin = deltas.MIN_SCORE_STANDARD_CONTEXT ?? deltas.MIN_SCORE_STANDARD;
    const countCap = deltas.RETRIEVAL_COUNT_DEFAULT;

    return traces.map(trace => {
      const oldMin = trace.harnessSnapshot?.MIN_SCORE_STANDARD ?? MIN_SCORE_STANDARD_CONTEXT;
      const originalActive = trace.active ?? [];
      const originalSuppressed = trace.suppressed ?? [];

      let active: ProvenanceItem[] = originalActive;
      let suppressed: ProvenanceItem[] = originalSuppressed;

      if (newMin !== undefined) {
        if (newMin > oldMin) {
          // Stricter: items between the old and new threshold drop out.
          const demoted = active.filter(item => (item.score || 0) < newMin);
          active = active.filter(item => (item.score || 0) >= newMin);
          suppressed = [...demoted, ...suppressed];
        } else if (newMin < oldMin) {
          // Looser: suppressed items that only missed the old threshold come back.
          const promoted = suppressed.filter(item => {
            const score = item.score || 0;
            return score >= newMin && score < oldMin;
          });
          const promotedSet = new Set(promoted);
          active = [...active, ...promoted];
          suppressed = suppressed.filter(item => !promotedSet.has(item));
        }
      }

      if (countCap !== undefined && active.length > countCap) {
        // Keep the highest-scoring items; the rest move to suppressed rather
        // than vanishing from the trace.
        const sorted = [...active].sort((a, b) => (b.score || 0) - (a.score || 0));
        active = sorted.slice(0, Math.max(0, countCap));
        suppressed = [...sorted.slice(Math.max(0, countCap)), ...suppressed];
      }

      // Recompute prompt tokens from the items that changed state.
      const activeSet = new Set(active);
      const originalActiveSet = new Set(originalActive);
      const memoryTokens = trace.promptTokens?.memory ?? 0;
      const perItemFallback = originalActive.length > 0 ? memoryTokens / originalActive.length : 0;
      const removedTokens = originalActive
        .filter(item => !activeSet.has(item))
        .reduce((s, item) => s + itemTokens(item, perItemFallback), 0);
      const addedTokens = active
        .filter(item => !originalActiveSet.has(item))
        .reduce((s, item) => s + itemTokens(item, perItemFallback), 0);
      const promptTokens = trace.promptTokens
        ? {
            ...trace.promptTokens,
            memory: Math.max(0, memoryTokens - removedTokens + addedTokens),
            total: Math.max(0, (trace.promptTokens.total || 0) - removedTokens + addedTokens),
          }
        : trace.promptTokens;

      // Acceptance proxy weighted by how much of the originally retrieved
      // context survives. An accepted answer that loses its context is less
      // likely to stay accepted; a corrected answer whose low-scoring items
      // were filtered out gets partial credit for removing noise.
      const retained = originalActive.filter(item => activeSet.has(item)).length;
      const coverage = originalActive.length > 0 ? retained / originalActive.length : 1;
      let simulatedAcceptance = 0;
      if (trace.outcome === 'accepted') simulatedAcceptance = coverage;
      else if (trace.outcome === 'correction') simulatedAcceptance = (1 - coverage) * 0.5;

      return {
        ...trace,
        active,
        suppressed,
        promptTokens: promptTokens as RetrievalTrace['promptTokens'],
        simulatedAcceptance,
      };
    });
  }

  private emptyResult(proposal: HarnessProposal): EvaluationResult {
    return {
      proposalId: proposal.id,
      runId: proposal.runId,
      ts: new Date().toISOString(),
      searchSetSize: 0,
      acceptanceRate: 0,
      correctionRate: 0,
      avgActiveItems: 0,
      avgSuppressedItems: 0,
      avgPromptTokens: 0,
      avgPipelineMs: 0,
      byMode: {},
      isParetoOptimal: false,
      traceIds: [],
    };
  }
}

export const harnessEvaluator = new HarnessEvaluator();
