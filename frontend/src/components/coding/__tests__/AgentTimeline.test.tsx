import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AgentTimeline } from '../AgentTimeline';
import type { AgentMessage } from '../../../store/codingSlice';

describe('AgentTimeline', () => {
  const userMsg: AgentMessage = { id: 'u1', role: 'user', content: 'Hello agent' };
  const assistantMsg: AgentMessage = {
    id: 'a1',
    role: 'assistant',
    content: 'Hi there',
    toolEvents: [],
    isStreaming: false,
  };

  it('renders empty state with sparkles', () => {
    render(<AgentTimeline agentMessages={[]} isGenerating={false} copiedMsgId={null} onCopy={() => {}} fileSnapshots={new Map()} />);
    expect(screen.getByText(/Ask the agent anything/)).toBeTruthy();
  });

  it('renders user messages', () => {
    render(<AgentTimeline agentMessages={[userMsg]} isGenerating={false} copiedMsgId={null} onCopy={() => {}} fileSnapshots={new Map()} />);
    expect(screen.getByText('Hello agent')).toBeTruthy();
  });

  it('renders assistant messages via AgentTurnBlock', () => {
    render(<AgentTimeline agentMessages={[assistantMsg]} isGenerating={false} copiedMsgId={null} onCopy={() => {}} fileSnapshots={new Map()} />);
    expect(screen.getByText('Hi there')).toBeTruthy();
  });

  it('skips build_check user messages', () => {
    const buildCheckMsg: AgentMessage = {
      id: 'bc1',
      role: 'user',
      content: '[build_check after writing src/a.ts]\nTypeScript errors...',
    };
    render(<AgentTimeline agentMessages={[buildCheckMsg]} isGenerating={false} copiedMsgId={null} onCopy={() => {}} fileSnapshots={new Map()} />);
    expect(screen.queryByText(/TypeScript errors/)).toBeNull();
  });
});
