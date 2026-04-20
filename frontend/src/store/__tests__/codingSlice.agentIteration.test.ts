import { describe, it, expect } from 'vitest';
import type { AgentIteration, AgentMessage, ToolEvent } from '../codingSlice';

describe('AgentIteration type definitions', () => {
  it('AgentIteration interface exists with correct structure', () => {
    const iteration: AgentIteration = {
      index: 0,
      text: 'Hello world',
      toolEvents: [],
    };
    expect(iteration.index).toBe(0);
    expect(iteration.text).toBe('Hello world');
    expect(iteration.toolEvents).toEqual([]);
  });

  it('AgentMessage can have iterations field', () => {
    const iterations: AgentIteration[] = [
      { index: 0, text: 'First iteration', toolEvents: [] },
      { index: 1, text: 'Second iteration', toolEvents: [] },
    ];
    
    const msg: AgentMessage = {
      id: 'test-1',
      role: 'assistant',
      content: 'Full content',
      iterations,
      toolEvents: [],
    };

    expect(msg.iterations).toHaveLength(2);
    expect(msg.iterations?.[0].index).toBe(0);
    expect(msg.iterations?.[1].index).toBe(1);
  });

  it('AgentMessage works without iterations (backward compatibility)', () => {
    const msg: AgentMessage = {
      id: 'test-2',
      role: 'assistant',
      content: 'Just content',
      toolEvents: [],
    };

    expect(msg.iterations).toBeUndefined();
    expect(msg.content).toBe('Just content');
  });

  it('AgentIteration can contain toolEvents', () => {
    const toolEvents: ToolEvent[] = [
      {
        type: 'tool_start',
        tool: 'read_file',
        args: { path: 'src/test.ts' },
        iteration: 0,
        callId: 'call-1',
      },
      {
        type: 'tool_result',
        tool: 'read_file',
        args: { path: 'src/test.ts' },
        result: 'content',
        iteration: 0,
        callId: 'call-1',
      },
    ];

    const iteration: AgentIteration = {
      index: 0,
      text: 'Reading file',
      toolEvents,
    };

    expect(iteration.toolEvents).toHaveLength(2);
    expect(iteration.toolEvents[0].type).toBe('tool_start');
    expect(iteration.toolEvents[1].type).toBe('tool_result');
  });
});
