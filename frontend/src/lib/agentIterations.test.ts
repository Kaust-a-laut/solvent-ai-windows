import { describe, expect, it } from 'vitest';
import { reconstructIterations } from './agentIterations';
import type { AgentMessage, ToolEvent } from '../store/codingSlice';

function makeEvent(iteration: number, tool: string, callId: string): ToolEvent {
  return { type: 'tool_start', tool, iteration, callId };
}

describe('reconstructIterations', () => {
  it('returns iterations verbatim when already populated', () => {
    const msg: AgentMessage = {
      id: 'a',
      role: 'assistant',
      content: 'final',
      iterations: [
        { index: 0, text: 'one', toolEvents: [] },
        { index: 1, text: 'two', toolEvents: [] },
      ],
    };
    const result = reconstructIterations(msg);
    expect(result).toHaveLength(2);
    expect(result[0]!.text).toBe('one');
  });

  it('groups flat toolEvents by iteration index', () => {
    const msg: AgentMessage = {
      id: 'a',
      role: 'assistant',
      content: 'final text',
      toolEvents: [
        makeEvent(0, 'read_file', 'c1'),
        makeEvent(1, 'write_file', 'c2'),
        makeEvent(0, 'list_files', 'c3'),
      ],
    };
    const result = reconstructIterations(msg);
    expect(result).toHaveLength(2);
    expect(result[0]!.index).toBe(0);
    expect(result[0]!.toolEvents).toHaveLength(2);
    expect(result[1]!.index).toBe(1);
    expect(result[1]!.text).toBe('final text'); // final text attaches to last bucket
  });

  it('produces a solo bucket when there are no tool events', () => {
    const msg: AgentMessage = {
      id: 'a',
      role: 'assistant',
      content: 'just text',
      toolEvents: [],
    };
    const result = reconstructIterations(msg);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe('just text');
    expect(result[0]!.toolEvents).toEqual([]);
  });

  it('sorts iteration buckets by index', () => {
    const msg: AgentMessage = {
      id: 'a',
      role: 'assistant',
      content: '',
      toolEvents: [
        makeEvent(2, 't', 'c1'),
        makeEvent(0, 't', 'c2'),
        makeEvent(1, 't', 'c3'),
      ],
    };
    const result = reconstructIterations(msg);
    expect(result.map(r => r.index)).toEqual([0, 1, 2]);
  });
});
