import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';

export interface PlanStep {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'skipped';
  notes?: string;
}

export interface AgentReflection {
  ts: string;
  verified: string[];
  assumed: string[];
  next: string;
}

export interface AgentScratchpad {
  sessionId: string;
  plan: PlanStep[];
  reflections: AgentReflection[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Per-session agent scratchpad manager.
 * Stores plans and reflections that are injected into the system prompt
 * on every subsequent API call so the model always sees the current plan state.
 */
export class AgentScratchpadService {
  private scratchpads: Map<string, AgentScratchpad> = new Map();

  /** Get existing scratchpad or create a new one for the session. */
  getOrCreate(sessionId: string): AgentScratchpad {
    if (!this.scratchpads.has(sessionId)) {
      this.scratchpads.set(sessionId, {
        sessionId,
        plan: [],
        reflections: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return this.scratchpads.get(sessionId)!;
  }

  /** Create a new plan for a session. Replaces any existing plan. */
  createPlan(sessionId: string, stepTitles: string[]): PlanStep[] {
    const pad = this.getOrCreate(sessionId);
    pad.plan = stepTitles.map(title => ({
      id: randomUUID().slice(0, 8),
      title,
      status: 'pending',
    }));
    pad.updatedAt = new Date().toISOString();
    logger.info(`[Scratchpad] Created plan with ${pad.plan.length} steps for session ${sessionId}`);
    return pad.plan;
  }

  /** Update a step's status and optional notes. */
  updateStep(sessionId: string, stepId: string, status: PlanStep['status'], notes?: string): PlanStep | null {
    const pad = this.getOrCreate(sessionId);
    const step = pad.plan.find(s => s.id === stepId);
    if (!step) return null;
    step.status = status;
    if (notes) step.notes = notes;
    pad.updatedAt = new Date().toISOString();
    return step;
  }

  /** Add a reflection checkpoint. */
  addReflection(sessionId: string, verified: string[], assumed: string[], next: string): AgentReflection {
    const pad = this.getOrCreate(sessionId);
    const reflection: AgentReflection = {
      ts: new Date().toISOString(),
      verified,
      assumed,
      next,
    };
    pad.reflections.push(reflection);
    pad.updatedAt = new Date().toISOString();
    logger.info(`[Scratchpad] Added reflection for session ${sessionId}: "${next.slice(0, 80)}"`);
    return reflection;
  }

  /**
   * Render the scratchpad as a text block for system prompt injection.
   * This is called before each API request in generateChatCompletionWithEvents.
   */
  renderForPrompt(sessionId: string): string | null {
    const pad = this.scratchpads.get(sessionId);
    if (!pad) return null;

    const parts: string[] = [];

    // Render plan
    if (pad.plan.length > 0) {
      parts.push('═══ CURRENT PLAN ═══');
      pad.plan.forEach((step, i) => {
        const icon = step.status === 'completed' ? '✓' :
                     step.status === 'in_progress' ? '●' :
                     step.status === 'blocked' ? '✗' :
                     step.status === 'skipped' ? '—' : '○';
        parts.push(`  ${icon} Step ${i + 1} [${step.id}]: ${step.title}${step.notes ? ` (${step.notes})` : ''}`);
      });
    }

    // Render latest reflection
    if (pad.reflections.length > 0) {
      const latest = pad.reflections[pad.reflections.length - 1]!;
      parts.push('');
      parts.push('═══ LATEST REFLECTION ═══');
      parts.push(`  Verified: ${latest.verified.join('; ') || 'none'}`);
      parts.push(`  Assumed: ${latest.assumed.join('; ') || 'none'}`);
      parts.push(`  Next: ${latest.next}`);
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  /** Get the raw scratchpad data (for frontend plan strip display via SSE). */
  getScratchpad(sessionId: string): AgentScratchpad | null {
    return this.scratchpads.get(sessionId) ?? null;
  }

  /** Delete a session's scratchpad. */
  dispose(sessionId: string): void {
    this.scratchpads.delete(sessionId);
  }

  /** Clear all scratchpads. */
  clear(): void {
    this.scratchpads.clear();
  }
}

export const agentScratchpadService = new AgentScratchpadService();
