import { traceLogger, RetrievalTrace } from './traceLogger';
import { getHarnessSnapshot } from './contextService';
import { EvaluationResult, HarnessProposal, TracePattern } from '../types/harness';
import { randomUUID as uuidv4 } from 'crypto';
import { AIProviderFactory } from './aiProviderFactory';
import { logger } from '../utils/logger';

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
    const traceSummary = this.buildTraceSummary(traces.slice(0, 50));
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
          provider = await AIProviderFactory.getProvider(p);
          if (provider.isReady()) {
            model = p === 'groq' ? 'llama-3.1-8b-instant' :
                    p === 'fireworks' ? 'accounts/fireworks/models/llama-v3p1-8b-instruct' :
                    'meta-llama/llama-3.1-8b-instruct';
            break;
          }
        } catch { /* try next provider */ }
      }

      if (!provider) {
        logger.warn('[Proposer] No available provider — falling back to deterministic analysis');
        return this.fallbackDeterministic(traces);
      }

      const response = await provider.complete([
        { role: 'system', content: 'You are a retrieval optimization analyst. Respond in strict JSON only.' },
        { role: 'user', content: prompt },
      ], { model, temperature: 0.2, jsonMode: true, maxTokens: 2048 });

      const analysis = JSON.parse(response.trim());

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
        targetsFailureModes: (analysis.patterns || []).map((p: any) => p.type),
      };
    } catch (error) {
      logger.warn('[Proposer] LLM analysis failed, falling back to deterministic', error instanceof Error ? error.message : String(error));
      return this.fallbackDeterministic(traces);
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

  private validateDeltas(deltas: Record<string, unknown>): Record<string, number> {
    const validated: Record<string, number> = {};
    const snapshot = getHarnessSnapshot();

    for (const [key, value] of Object.entries(deltas)) {
      if (typeof value !== 'number') continue;

      // Ensure values are within reasonable bounds
      if (key.includes('SCORE') || key.includes('THRESHOLD') || key.includes('SIMILARITY')) {
        validated[key] = Math.max(0.3, Math.min(0.99, value));
      } else if (key.includes('COUNT') || key.includes('MAX') || key.includes('LIMIT')) {
        validated[key] = Math.max(1, Math.min(50, Math.round(value)));
      } else {
        validated[key] = value;
      }

      // Skip deltas that don't actually change anything
      if (snapshot[key as keyof typeof snapshot] === validated[key]) {
        delete validated[key];
      }
    }

    return validated;
  }

  /**
   * Fallback deterministic analysis if the LLM is unavailable.
   * Keeps the original hand-coded pattern rules as a safety net.
   */
  private fallbackDeterministic(traces: RetrievalTrace[]): HarnessProposal | null {
    const recent = traces.slice(0, 50);
    const snapshot = getHarnessSnapshot();

    // Pattern: High correction rate
    const corrections = recent.filter(t => t.outcome === 'correction');
    if (corrections.length / recent.length > 0.15) {
      return {
        id: uuidv4(),
        iteration: 0,
        runId: 'fallback',
        ts: new Date().toISOString(),
        deltas: {
          MIN_SCORE_STANDARD_CONTEXT: Math.min(0.80, (snapshot.MIN_SCORE_STANDARD || 0.65) + 0.05),
          DEDUP_SIMILARITY_THRESHOLD: Math.min(0.97, (snapshot.DEDUP_SIMILARITY_THRESHOLD || 0.92) + 0.02),
        },
        rationale: `Fallback: ${corrections.length}/${recent.length} traces marked as correction`,
        targetsFailureModes: ['outcome_degradation'],
      };
    }

    // Pattern: Token overspend
    const avgBudgetUtil = recent.reduce(
      (sum, t) => sum + (t.promptTokens?.total || 0) / Math.max(t.promptTokens?.budget || 1, 1), 0
    ) / Math.max(recent.length, 1);
    if (avgBudgetUtil > 0.90) {
      return {
        id: uuidv4(),
        iteration: 0,
        runId: 'fallback',
        ts: new Date().toISOString(),
        deltas: {
          RETRIEVAL_COUNT_DEFAULT: Math.max(3, (snapshot.RETRIEVAL_COUNT_DEFAULT || 8) - 3),
          RETRIEVAL_COUNT_MASSIVE: Math.max(5, (snapshot.RETRIEVAL_COUNT_MASSIVE || 15) - 5),
        },
        rationale: `Fallback: avg budget utilization ${(avgBudgetUtil * 100).toFixed(0)}%`,
        targetsFailureModes: ['token_overspend'],
      };
    }

    // Pattern: Many candidates are being suppressed; retrieve fewer items by default.
    const avgSuppressionRatio = recent.reduce((sum, trace) => {
      const active = trace.active.length;
      const suppressed = trace.suppressed.length;
      const total = active + suppressed;
      return sum + (total > 0 ? suppressed / total : 0);
    }, 0) / Math.max(recent.length, 1);
    if (avgSuppressionRatio > 0.60) {
      return {
        id: uuidv4(),
        iteration: 0,
        runId: 'fallback',
        ts: new Date().toISOString(),
        deltas: {
          RETRIEVAL_COUNT_DEFAULT: Math.max(3, (snapshot.RETRIEVAL_COUNT_DEFAULT || 8) - 2),
        },
        rationale: `Fallback: avg suppression ratio ${(avgSuppressionRatio * 100).toFixed(0)}%`,
        targetsFailureModes: ['high_suppression'],
      };
    }

    return null;
  }
}

export const proposerAgent = new ProposerAgent();
