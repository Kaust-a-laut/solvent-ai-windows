import { traceLogger, RetrievalTrace } from './traceLogger';
import { getHarnessSnapshot } from './contextService';
import { EvaluationResult, HarnessProposal, TracePattern } from '../types/harness';
import { randomUUID as uuidv4 } from 'crypto';
import { AIProviderFactory } from './aiProviderFactory';
import { logger } from '../utils/logger';
import { parseLlmJson } from '../utils/llmJson';

type Deltas = HarnessProposal['deltas'];
type DeltaKey = keyof Deltas;

/**
 * Allowed proposal keys with per-key [min, max] bounds (and integer-ness).
 * The old generic "any key containing SCORE → [0.3, 0.99]" clamp inflated
 * small boosts such as SCORE_BOOST_PER_RETRIEVAL (0.02) by up to 15×.
 */
const DELTA_BOUNDS: Record<DeltaKey, { min: number; max: number; int?: boolean }> = {
  MIN_SCORE_STANDARD_CONTEXT: { min: 0.3, max: 0.95 },
  MIN_SCORE_MASSIVE_CONTEXT: { min: 0.2, max: 0.95 },
  RETRIEVAL_COUNT_DEFAULT: { min: 1, max: 20, int: true },
  RETRIEVAL_COUNT_MASSIVE: { min: 1, max: 50, int: true },
  RETRIEVAL_COUNT_CONSTRAINED: { min: 1, max: 20, int: true },
  DEDUP_SIMILARITY_THRESHOLD: { min: 0.8, max: 0.99 },
  SCORE_BOOST_UNIVERSAL: { min: 0, max: 0.6 },
  SCORE_BOOST_KEYWORD_MATCH: { min: 0, max: 0.4 },
  SCORE_BOOST_TAG_MATCH: { min: 0, max: 0.4 },
  SCORE_BOOST_PER_RETRIEVAL: { min: 0, max: 0.1 },
  SCORE_BOOST_PER_IMPORTANCE: { min: 0, max: 0.15 },
  SCORE_PENALTY_STALE_CODE: { min: 0.1, max: 1 },
};

// Snapshot names (what the LLM is shown) → proposal names.
const DELTA_KEY_ALIASES: Record<string, DeltaKey> = {
  MIN_SCORE_STANDARD: 'MIN_SCORE_STANDARD_CONTEXT',
  MIN_SCORE_MASSIVE: 'MIN_SCORE_MASSIVE_CONTEXT',
};

// Proposal names → snapshot names, for the "does this change anything?" check.
const SNAPSHOT_KEY: Partial<Record<DeltaKey, string>> = {
  MIN_SCORE_STANDARD_CONTEXT: 'MIN_SCORE_STANDARD',
  MIN_SCORE_MASSIVE_CONTEXT: 'MIN_SCORE_MASSIVE',
};

interface ProposerContext {
  runId: string;
  iteration: number;
  priorProposals: HarnessProposal[];
  priorEvaluations: { proposalId: string; result: EvaluationResult }[];
}

/**
 * LLM-based proposer that reads raw trace files and proposes harness deltas
 * with rationale. Replaces the hand-coded pattern engine from Phase C.
 */
export class ProposerAgent {
  /**
   * Analyzes recent traces using an LLM and proposes a new harness configuration.
   * Returns null if the LLM doesn't identify clear improvement directions.
   */
  async propose(ctx: ProposerContext): Promise<HarnessProposal | null> {
    const traces = await traceLogger.readTraces();
    if (traces.length < 10) return null; // Need minimum signal

    // Serialize traces into a compact summary the LLM can analyze
    // Traces are stored oldest-first — the most recent 50 are the tail.
    const traceSummary = this.buildTraceSummary(traces.slice(-50));
    const currentConfig = JSON.stringify(getHarnessSnapshot(), null, 2);

    // Include prior proposals and their outcomes to avoid repeating failed approaches
    const priorSection = ctx.priorProposals.length > 0
      ? `\n\nPRIOR PROPOSALS (with evaluation outcomes):\n${ctx.priorProposals.map((p, i) => {
          const evalResult = ctx.priorEvaluations.find(e => e.proposalId === p.id);
          return `${i + 1}. ${p.rationale}\n   Deltas: ${JSON.stringify(p.deltas)}\n   Outcome: ${evalResult ? JSON.stringify(evalResult.result) : 'not yet evaluated'}`;
        }).join('\n\n')}\n\nDo NOT repeat proposals that did not improve outcomes.`
      : '';

    const prompt = `You are a retrieval optimization analyst for an AI coding assistant's RAG system.

ANALYZE these recent retrieval traces (most recent 50) and identify failure patterns:

${traceSummary}

CURRENT HARNESS CONFIGURATION:
${currentConfig}
${priorSection}

TASK:
1. Identify the MOST SEVERE failure pattern in the traces (prioritize: correction rate > low scores > high suppression > token overspend > duplicate retrieval)
2. Propose specific parameter changes to the harness configuration that would address this pattern
3. Explain WHY each change addresses the observed failure

CONSTRAINTS:
- Parameter values must stay within reasonable bounds (scores: 0.5-0.95, counts: 1-20, thresholds: 0.8-0.99)
- Propose at most 3 parameter changes per iteration
- Each delta must have a clear rationale tied to observed evidence

Output STRICT JSON only:
{
  "patterns": [{"type": "outcome_degradation|low_score_noise|high_suppression|token_overspend|duplicate_retrieval", "description": "...", "severity": "high|medium|low", "evidence": "specific trace evidence"}],
  "deltas": {"PARAM_NAME": newValue, ...},
  "rationale": "Why these changes address the observed failures"
}`;

    try {
      // Use a cheap model — this is analysis, not reasoning-heavy
      const providerCandidates = ['groq', 'fireworks', 'openrouter'];
      let provider: Awaited<ReturnType<typeof AIProviderFactory.getProvider>> | null = null;
      let model = '';

      for (const p of providerCandidates) {
        try {
          // Only keep a candidate that is actually usable — assigning before
          // the check left the last *unready* provider in `provider` when
          // every candidate failed, so the fallback below never ran.
          const candidate = await AIProviderFactory.getProvider(p);
          const keyed = (candidate as { hasConfiguredKey?: () => boolean }).hasConfiguredKey?.();
          if (candidate.isReady() && keyed !== false) {
            provider = candidate;
            model = p === 'groq' ? 'llama-3.1-8b-instant' :
                    p === 'fireworks' ? 'accounts/fireworks/models/gpt-oss-120b' :
                    'meta-llama/llama-3.1-8b-instruct';
            break;
          }
        } catch { /* try next provider */ }
      }

      if (!provider) {
        logger.warn('[Proposer] No available provider — falling back to deterministic analysis');
        return this.fallbackDeterministic(traces, ctx);
      }

      const response = await provider.complete([
        { role: 'system', content: 'You are a retrieval optimization analyst. Respond in strict JSON only.' },
        { role: 'user', content: prompt },
      ], { model, temperature: 0.2, jsonMode: true, maxTokens: 2048 });

      // Reasoning models prepend <think>…</think>; others fence the JSON.
      const analysis = parseLlmJson<{ deltas?: Record<string, unknown>; rationale?: string; patterns?: Array<{ type?: string }> }>(response);

      // Validate deltas are within bounds
      const validatedDeltas = this.validateDeltas(analysis.deltas || {});
      if (Object.keys(validatedDeltas).length === 0) return null;

      return {
        id: uuidv4(),
        iteration: ctx.iteration,
        runId: ctx.runId,
        ts: new Date().toISOString(),
        deltas: validatedDeltas,
        rationale: analysis.rationale || 'LLM-proposed optimization',
        targetsFailureModes: (Array.isArray(analysis.patterns) ? analysis.patterns : [])
          .map(p => p?.type)
          .filter((t): t is string => typeof t === 'string'),
      };
    } catch (error) {
      logger.warn('[Proposer] LLM analysis failed, falling back to deterministic', error instanceof Error ? error.message : String(error));
      return this.fallbackDeterministic(traces, ctx);
    }
  }

  private buildTraceSummary(traces: RetrievalTrace[]): string {
    const lines: string[] = [];
    for (const t of traces) {
      const avgActiveScore = t.active.length > 0
        ? t.active.reduce((s, a) => s + (a.score || 0), 0) / t.active.length
        : 0;
      const suppressionRatio = (t.active.length + t.suppressed.length) > 0
        ? t.suppressed.length / (t.active.length + t.suppressed.length)
        : 0;
      const budgetUtil = (t.promptTokens?.total || 0) / Math.max(t.promptTokens?.budget || 1, 1);

      lines.push(JSON.stringify({
        id: t.id.slice(0, 8),
        outcome: t.outcome,
        active: t.active.length,
        suppressed: t.suppressed.length,
        avgScore: avgActiveScore.toFixed(2),
        suppressionRatio: suppressionRatio.toFixed(2),
        budgetUtil: budgetUtil.toFixed(2),
      }));
    }
    return lines.join('\n');
  }

  private validateDeltas(deltas: Record<string, unknown>): Deltas {
    const validated: Partial<Record<DeltaKey, number>> = {};
    const snapshot = getHarnessSnapshot() as unknown as Record<string, number>;

    for (const [rawKey, value] of Object.entries(deltas ?? {})) {
      const key = (DELTA_KEY_ALIASES[rawKey] ?? rawKey) as DeltaKey;
      const bounds = DELTA_BOUNDS[key];
      // Unknown keys and non-finite values (NaN, Infinity, strings) are dropped.
      if (!bounds) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;

      let v = Math.max(bounds.min, Math.min(bounds.max, value));
      if (bounds.int) v = Math.round(v);

      // Skip deltas that don't actually change anything
      const current = snapshot[SNAPSHOT_KEY[key] ?? key];
      if (current === v) continue;
      validated[key] = v;
    }

    return validated;
  }

  /**
   * Fallback deterministic analysis if the LLM is unavailable.
   * Keeps the original hand-coded pattern rules as a safety net, tagged with
   * the caller's run/iteration, and rotates past proposals already tried in
   * this run so repeated iterations don't re-submit the same deltas.
   */
  private fallbackDeterministic(traces: RetrievalTrace[], ctx: ProposerContext): HarnessProposal | null {
    const recent = traces.slice(-50);
    const snapshot = getHarnessSnapshot();
    const candidates: Array<Pick<HarnessProposal, 'deltas' | 'rationale' | 'targetsFailureModes'>> = [];

    // Pattern: High correction rate
    const corrections = recent.filter(t => t.outcome === 'correction');
    if (corrections.length / Math.max(recent.length, 1) > 0.15) {
      candidates.push({
        deltas: {
          MIN_SCORE_STANDARD_CONTEXT: Math.min(0.80, (snapshot.MIN_SCORE_STANDARD || 0.65) + 0.05),
          DEDUP_SIMILARITY_THRESHOLD: Math.min(0.97, (snapshot.DEDUP_SIMILARITY_THRESHOLD || 0.92) + 0.02),
        },
        rationale: `Fallback: ${corrections.length}/${recent.length} traces marked as correction`,
        targetsFailureModes: ['outcome_degradation'],
      });
      candidates.push({
        deltas: {
          MIN_SCORE_STANDARD_CONTEXT: Math.min(0.85, (snapshot.MIN_SCORE_STANDARD || 0.65) + 0.10),
        },
        rationale: `Fallback (stronger): ${corrections.length}/${recent.length} traces marked as correction`,
        targetsFailureModes: ['outcome_degradation'],
      });
    }

    // Pattern: Token overspend
    const avgBudgetUtil = recent.reduce(
      (sum, t) => sum + (t.promptTokens?.total || 0) / Math.max(t.promptTokens?.budget || 1, 1), 0
    ) / Math.max(recent.length, 1);
    if (avgBudgetUtil > 0.90) {
      candidates.push({
        deltas: {
          RETRIEVAL_COUNT_DEFAULT: Math.max(3, (snapshot.RETRIEVAL_COUNT_DEFAULT || 8) - 3),
          RETRIEVAL_COUNT_MASSIVE: Math.max(5, (snapshot.RETRIEVAL_COUNT_MASSIVE || 15) - 5),
        },
        rationale: `Fallback: avg budget utilization ${(avgBudgetUtil * 100).toFixed(0)}%`,
        targetsFailureModes: ['token_overspend'],
      });
    }

    // Pattern: Many candidates are being suppressed; retrieve fewer items by default.
    const avgSuppressionRatio = recent.reduce((sum, trace) => {
      const active = trace.active.length;
      const suppressed = trace.suppressed.length;
      const total = active + suppressed;
      return sum + (total > 0 ? suppressed / total : 0);
    }, 0) / Math.max(recent.length, 1);
    if (avgSuppressionRatio > 0.60) {
      candidates.push({
        deltas: {
          RETRIEVAL_COUNT_DEFAULT: Math.max(3, (snapshot.RETRIEVAL_COUNT_DEFAULT || 8) - 2),
        },
        rationale: `Fallback: avg suppression ratio ${(avgSuppressionRatio * 100).toFixed(0)}%`,
        targetsFailureModes: ['high_suppression'],
      });
    }

    const tried = new Set(ctx.priorProposals.map(p => stableDeltaKey(p.deltas)));
    const next = candidates.find(c => !tried.has(stableDeltaKey(c.deltas)));
    if (!next) return null;

    return {
      id: uuidv4(),
      iteration: ctx.iteration,
      runId: ctx.runId,
      ts: new Date().toISOString(),
      ...next,
    };
  }
}

function stableDeltaKey(deltas: Deltas): string {
  return JSON.stringify(Object.entries(deltas ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

export const proposerAgent = new ProposerAgent();
