import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AgentTurnBlock } from '../AgentTurnBlock';
import { reconstructIterations } from '../../../lib/agentIterations';
import type { AgentMessage, ToolEvent } from '../../../store/codingSlice';

describe('reconstructIterations', () => {
  it('groups toolEvents by iteration index', () => {
    const toolEvents: ToolEvent[] = [
      { type: 'tool_start', tool: 'read_file', args: { path: 'a.ts' }, iteration: 0, callId: 'c1' },
      { type: 'tool_result', tool: 'read_file', args: { path: 'a.ts' }, result: 'x', iteration: 0, callId: 'c1' },
      { type: 'tool_start', tool: 'write_file', args: { path: 'b.ts' }, iteration: 1, callId: 'c2' },
      { type: 'tool_result', tool: 'write_file', args: { path: 'b.ts' }, result: 'y', iteration: 1, callId: 'c2' },
    ];
    const msg: AgentMessage = { id: '1', role: 'assistant', content: 'done', toolEvents };
    const iterations = reconstructIterations(msg);
    expect(iterations).toHaveLength(2);
    expect(iterations[0].index).toBe(0);
    expect(iterations[0].toolEvents).toHaveLength(2);
    expect(iterations[1].index).toBe(1);
    expect(iterations[1].toolEvents).toHaveLength(2);
    expect(iterations[1].text).toBe('done');
  });

  it('handles empty toolEvents', () => {
    const msg: AgentMessage = { id: '2', role: 'assistant', content: 'just text', toolEvents: [] };
    const iterations = reconstructIterations(msg);
    expect(iterations).toHaveLength(1);
    expect(iterations[0].index).toBe(0);
    expect(iterations[0].text).toBe('just text');
  });

  it('returns existing iterations unchanged', () => {
    const existing = [{ index: 0, text: 'hi', toolEvents: [] }];
    const msg: AgentMessage = { id: '3', role: 'assistant', content: 'hi', iterations: existing, toolEvents: [] };
    const iterations = reconstructIterations(msg);
    expect(iterations).toBe(existing);
  });
});

describe('AgentTurnBlock', () => {
  it('renders a turn with iterations', () => {
    const msg: AgentMessage = {
      id: '4',
      role: 'assistant',
      content: 'I wrote the file',
      iterations: [{ index: 0, text: 'I wrote the file', toolEvents: [] }],
      toolEvents: [],
      isStreaming: false,
    };

    render(<AgentTurnBlock msg={msg} isStreaming={false} copiedMsgId={null} onCopy={() => {}} />);

    expect(screen.getByText(/I wrote the file/)).toBeTruthy();
  });

  it('shows iteration dividers between iterations', () => {
    const msg: AgentMessage = {
      id: '5',
      role: 'assistant',
      content: '',
      iterations: [
        { index: 0, text: 'First', toolEvents: [] },
        { index: 1, text: 'Second', toolEvents: [] },
      ],
      toolEvents: [],
      isStreaming: false,
    };

    render(<AgentTurnBlock msg={msg} isStreaming={false} copiedMsgId={null} onCopy={() => {}} />);

    expect(screen.getByText(/iteration 1/i)).toBeTruthy();
  });

  it('renders copy button', () => {
    const msg: AgentMessage = {
      id: '6',
      role: 'assistant',
      content: 'Copy me',
      toolEvents: [],
      isStreaming: false,
    };

    render(<AgentTurnBlock msg={msg} isStreaming={false} copiedMsgId={null} onCopy={() => {}} />);

    expect(screen.getByLabelText('Copy response')).toBeTruthy();
  });
});
