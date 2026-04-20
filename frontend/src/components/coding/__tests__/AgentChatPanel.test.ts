import { describe, it, expect } from 'vitest';
import type { AgentMessage, ToolEvent, AgentIteration } from '../../../store/codingSlice';

// These tests exercise the pure logic that mirrors the SSE event handler in
// AgentChatPanel.tsx. The handler itself is tightly coupled to React refs and
// store callbacks, so we replicate the reduction here and assert invariants.

interface HandlerState {
  iterations: AgentIteration[];
  content: string;
  textIteration: number;
}

function makeInitial(): HandlerState {
  return { iterations: [], content: '', textIteration: 0 };
}

/** Mirror of the text_delta reducer (post-flush, single delta case). */
function applyTextDelta(state: HandlerState, delta: string): HandlerState {
  const iters = [...state.iterations];
  const existing = iters.find(it => it.index === state.textIteration);
  if (existing) {
    existing.text += delta;
  } else {
    iters.push({ index: state.textIteration, text: delta, toolEvents: [] });
  }
  return { ...state, iterations: iters, content: state.content + delta };
}

/** Mirror of the tool_start reducer. */
function applyToolStart(state: HandlerState, event: ToolEvent): HandlerState {
  const iters = [...state.iterations];
  const existing = iters.find(it => it.index === event.iteration);
  if (existing) existing.toolEvents = [...existing.toolEvents, event];
  else iters.push({ index: event.iteration, text: '', toolEvents: [event] });
  return {
    ...state,
    iterations: iters,
    textIteration: event.iteration + 1, // key invariant: next text goes to N+1
  };
}

describe('SSE orchestration — iteration tracking', () => {
  it('text_delta before any tool call lands on iteration 0', () => {
    let s = makeInitial();
    s = applyTextDelta(s, 'hello ');
    s = applyTextDelta(s, 'world');
    expect(s.iterations).toHaveLength(1);
    expect(s.iterations[0]!.index).toBe(0);
    expect(s.iterations[0]!.text).toBe('hello world');
    expect(s.content).toBe('hello world');
  });

  it('tool_start at iter=0 advances textIteration so next deltas land on iter=1', () => {
    let s = makeInitial();
    s = applyTextDelta(s, 'thinking... ');
    const toolStart: ToolEvent = {
      type: 'tool_start', tool: 'read_file', iteration: 0, callId: 'c1',
    };
    s = applyToolStart(s, toolStart);
    s = applyTextDelta(s, 'I read the file.');
    expect(s.iterations).toHaveLength(2);
    expect(s.iterations[0]!.toolEvents).toHaveLength(1);
    expect(s.iterations[1]!.index).toBe(1);
    expect(s.iterations[1]!.text).toBe('I read the file.');
  });

  it('accumulates multiple tool events within the same iteration bucket', () => {
    let s = makeInitial();
    const t1: ToolEvent = { type: 'tool_start', tool: 'read_file', iteration: 0, callId: 'c1' };
    const t2: ToolEvent = { type: 'tool_start', tool: 'list_files', iteration: 0, callId: 'c2' };
    s = applyToolStart(s, t1);
    s = applyToolStart(s, t2);
    expect(s.iterations).toHaveLength(1);
    expect(s.iterations[0]!.toolEvents).toHaveLength(2);
    expect(s.textIteration).toBe(1);
  });
});

describe('SSE orchestration — beforeContent capture timing', () => {
  it('captures beforeContent on tool_start for write tools', () => {
    const openFiles = [{ path: 'a.ts', content: 'original' }];
    const start: ToolEvent = {
      type: 'tool_start', tool: 'write_file', iteration: 0, callId: 'c1',
      args: { path: 'a.ts' },
    };
    const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'create_file']);
    if (WRITE_TOOL_NAMES.has(start.tool)) {
      const path = start.args?.path as string;
      const snap = openFiles.find(f => f.path === path)?.content;
      if (snap) start.beforeContent = snap;
    }
    expect(start.beforeContent).toBe('original');
  });

  it('does not capture beforeContent for read tools', () => {
    const start: ToolEvent = {
      type: 'tool_start', tool: 'read_file', iteration: 0, callId: 'c1',
      args: { path: 'a.ts' },
    };
    const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'create_file']);
    expect(WRITE_TOOL_NAMES.has(start.tool)).toBe(false);
    expect(start.beforeContent).toBeUndefined();
  });
});

describe('SSE orchestration — coalesced delta flush semantics', () => {
  it('flush concatenates all buffered deltas before applying', () => {
    let s = makeInitial();
    const buffered = ['Hel', 'lo ', 'wor', 'ld'];
    const combined = buffered.join('');
    s = applyTextDelta(s, combined);
    expect(s.iterations[0]!.text).toBe('Hello world');
    expect(s.content).toBe('Hello world');
  });
});

describe('AgentMessage legacy persistence shape', () => {
  it('messages can carry either iterations or legacy toolEvents', () => {
    const modern: AgentMessage = {
      id: '1', role: 'assistant', content: 'done',
      iterations: [{ index: 0, text: 'done', toolEvents: [] }],
    };
    const legacy: AgentMessage = {
      id: '2', role: 'assistant', content: 'ok',
      toolEvents: [{ type: 'tool_start', tool: 'x', iteration: 0, callId: 'c1' }],
    };
    expect(modern.iterations).toBeDefined();
    expect(legacy.toolEvents).toBeDefined();
  });
});
