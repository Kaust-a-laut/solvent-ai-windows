/**
 * Discriminated union for Agent SSE events.
 * Each event type carries a specific payload shape.
 */

export interface ToolStartEvent {
  type: 'tool_start';
  tool: string;
  args: Record<string, unknown>;
  iteration: number;
  callId: string;
  /** Snapshot of the file content before a write-tool ran. Used for undo. */
  beforeContent?: string;
}

export interface ToolResultEvent {
  type: 'tool_result';
  tool: string;
  args?: Record<string, unknown>;
  result: unknown;
  iteration: number;
  callId: string;
}

export interface ToolErrorEvent {
  type: 'tool_error';
  tool: string;
  error: string;
  iteration: number;
  callId: string;
}

export interface TextDeltaEvent {
  type: 'text_delta';
  content: string;
}

export interface TextCompleteEvent {
  type: 'text_complete';
  content: string;
}

export interface DoneEvent {
  type: 'done';
}

export interface ErrorEvent {
  type: 'error';
  message: string;
}

export interface UsageEvent {
  type: 'usage';
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
}

export interface BrowserToolEvent {
  type: 'browser-tool';
  tool: string;
  callId: string;
}

export interface PlanUpdateEvent {
  type: 'plan_update';
  plan: {
    steps: Array<{ id: string; title: string; status: string; notes?: string }>;
  };
}

export type AgentEvent =
  | ToolStartEvent
  | ToolResultEvent
  | ToolErrorEvent
  | TextDeltaEvent
  | TextCompleteEvent
  | UsageEvent
  | DoneEvent
  | ErrorEvent
  | BrowserToolEvent
  | PlanUpdateEvent;
