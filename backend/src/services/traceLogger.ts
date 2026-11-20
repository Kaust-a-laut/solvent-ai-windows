import { readFile } from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger';
import { JsonlAppender, rotatedPath, DEFAULT_JSONL_ROTATION } from '../utils/jsonlAppender';
import { ContextProvenance } from './contextService';

export interface HarnessSnapshot {
  RETRIEVAL_COUNT_DEFAULT: number;
  RETRIEVAL_COUNT_MASSIVE: number;
  RETRIEVAL_COUNT_CONSTRAINED: number;
  MIN_SCORE_STANDARD: number;
  MIN_SCORE_MASSIVE: number;
  SCORE_BOOST_UNIVERSAL: number;
  SCORE_BOOST_META_SUMMARY: number;
  SCORE_BOOST_CRYSTALLIZED: number;
  SCORE_BOOST_PERMANENT_RULE: number;
  SCORE_BOOST_KEYWORD_MATCH: number;
  SCORE_BOOST_TAG_MATCH: number;
  SCORE_BOOST_PER_RETRIEVAL: number;
  SCORE_BOOST_PER_IMPORTANCE: number;
  DEDUP_SIMILARITY_THRESHOLD: number;
  LINKED_MEMORY_SCORE_MULTIPLIER: number;
  SCORE_PENALTY_STALE_CODE: number;
}

export interface RetrievalTrace {
  id: string;
  ts: string;
  responseId: string;
  sessionId: string;
  mode: string;
  provider: string;
  model: string;
  query: string;
  harnessSnapshot: HarnessSnapshot;
  active: ContextProvenance['active'];
  suppressed: ContextProvenance['suppressed'];
  promptTokens: NonNullable<ContextProvenance['promptTokens']>;
  counts: ContextProvenance['counts'];
  pipelineMs: number;
  // Phase A: always null. Phase B will populate with user feedback signals.
  outcome: null | 'correction' | 'crystallized' | 'rerequested' | 'accepted';
}

interface OutcomePatch {
  type: 'outcome_patch';
  traceId: string;
  outcome: RetrievalTrace['outcome'];
  ts: string;
}

const TRACE_FILE = path.join(process.cwd(), '.solvent_retrieval_traces.jsonl');
const ROTATE_1 = rotatedPath(TRACE_FILE, 1);

// 20MB per file (2 rotated generations kept). Appends and rotations are
// serialized on one queue so concurrent writers can't race the rename.
const appender = new JsonlAppender(TRACE_FILE, DEFAULT_JSONL_ROTATION);

class TraceLogger {
  async appendTrace(trace: RetrievalTrace): Promise<void> {
    try {
      await appender.append(JSON.stringify(trace));
    } catch (err) {
      // Fire-and-forget: never let trace logging crash the main request
      logger.warn(`[TraceLogger] Failed to write trace: ${err}`);
    }
  }

  async updateOutcome(traceId: string, outcome: NonNullable<RetrievalTrace['outcome']>): Promise<void> {
    try {
      const patch: OutcomePatch = {
        type: 'outcome_patch',
        traceId,
        outcome,
        ts: new Date().toISOString(),
      };
      await appender.append(JSON.stringify(patch));
    } catch (err) {
      logger.warn(`[TraceLogger] Failed to write outcome patch: ${err}`);
    }
  }

  /**
   * Read traces (oldest first) with outcome patches applied. With no
   * argument this reads the most recent rotated generation and the live
   * file together, so a patch written after a rotation still lands on its
   * trace and "recent traces" don't reset to zero right after rotating.
   */
  async readTraces(filePath?: string): Promise<RetrievalTrace[]> {
    const files = filePath ? [filePath] : [ROTATE_1, TRACE_FILE];

    const traces = new Map<string, RetrievalTrace>();
    const patches = new Map<string, RetrievalTrace['outcome']>();

    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf-8');
      } catch {
        continue; // missing generation
      }
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.type === 'outcome_patch') {
            patches.set(record.traceId, record.outcome);
          } else if (record.id) {
            traces.set(record.id, record as RetrievalTrace);
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    // Apply patches — last patch for a given traceId wins
    for (const [traceId, outcome] of patches) {
      const trace = traces.get(traceId);
      if (trace) trace.outcome = outcome;
    }

    return [...traces.values()];
  }
}

export const traceLogger = new TraceLogger();
