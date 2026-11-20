import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AgentActionCard } from '../AgentActionCard';
import type { ToolEvent } from '../../../store/codingSlice';

describe('AgentActionCard', () => {
  const mockStartEvent = (tool: string, args?: Record<string, unknown>): ToolEvent => ({
    type: 'tool_start',
    tool,
    args: args || {},
    iteration: 0,
    callId: 'test-call-1',
  });

  const mockResultEvent = (tool: string, result?: unknown, args?: Record<string, unknown>): ToolEvent => ({
    type: 'tool_result',
    tool,
    args: args || {},
    result: result ?? 'done',
    iteration: 0,
    callId: 'test-call-1',
  });

  it('renders file write card in collapsed state', () => {
    const start = mockStartEvent('write_file', { path: 'src/auth.ts' });
    const result = mockResultEvent('write_file', 'content here', { path: 'src/auth.ts' });

    render(
      <AgentActionCard
        startEvent={start}
        resultEvent={result}
        previousContent="old content"
      />
    );

    expect(screen.getByText(/auth\.ts/)).toBeTruthy();
  });

  it('renders file write card in pending state', () => {
    const start = mockStartEvent('write_file', { path: 'src/auth.ts' });

    render(<AgentActionCard startEvent={start} />);

    expect(screen.getByText(/auth\.ts/)).toBeTruthy();
  });

  it('renders test runner passed state', () => {
    const start = mockStartEvent('run_tests', {});
    const result = mockResultEvent('run_tests', '5 passed, 0 failed', {});

    render(<AgentActionCard startEvent={start} resultEvent={result} />);

    expect(screen.getByText(/run_tests/)).toBeTruthy();
  });

  it('renders build check clean state', () => {
    const start: ToolEvent = {
      type: 'tool_start',
      tool: '__build_check__',
      args: { files: ['src/a.ts'] },
      iteration: 0,
      callId: 'build-1',
    };
    const result: ToolEvent = {
      type: 'tool_result',
      tool: '__build_check__',
      args: { files: ['src/a.ts'] },
      result: { errors: null },
      iteration: 0,
      callId: 'build-1',
    };

    render(<AgentActionCard startEvent={start} resultEvent={result} />);

    expect(screen.getByText(/build check/)).toBeTruthy();
  });

  it('renders build check errors state', () => {
    const start: ToolEvent = {
      type: 'tool_start',
      tool: '__build_check__',
      args: { files: ['src/a.ts'] },
      iteration: 0,
      callId: 'build-2',
    };
    const result: ToolEvent = {
      type: 'tool_result',
      tool: '__build_check__',
      args: { files: ['src/a.ts'] },
      result: { errors: 'TS2345: Argument of type...' },
      iteration: 0,
      callId: 'build-2',
    };

    render(<AgentActionCard startEvent={start} resultEvent={result} />);

    expect(screen.getByText(/build check/)).toBeTruthy();
  });

  it('renders git commit card', () => {
    const start = mockStartEvent('git_commit', { message: 'feat: add auth' });
    const result = mockResultEvent('git_commit', 'sha: abc1234', { message: 'feat: add auth' });

    render(<AgentActionCard startEvent={start} resultEvent={result} />);

    expect(screen.getByText(/feat: add auth/)).toBeTruthy();
  });

  it('renders log entry for read tools (no card border)', () => {
    const start = mockStartEvent('read_file', { path: 'src/utils.ts' });
    const result = mockResultEvent('read_file', 'file content', { path: 'src/utils.ts' });

    render(<AgentActionCard startEvent={start} resultEvent={result} />);

    const card = screen.getByText(/src\/utils\.ts/).closest('[data-variant="log"]');
    expect(card).toBeTruthy();
  });

  it('expands on click for file write', () => {
    const start = mockStartEvent('write_file', { path: 'src/auth.ts' });
    const result = mockResultEvent('write_file', 'new content', { path: 'src/auth.ts' });

    render(
      <AgentActionCard
        startEvent={start}
        resultEvent={result}
        previousContent="old content"
      />
    );

    const card = screen.getByText(/auth\.ts/).closest('[role="button"]') || screen.getByText(/auth\.ts/);
    fireEvent.click(card);

    const expanded = document.querySelector('pre');
    expect(expanded).toBeTruthy();
  });
});
