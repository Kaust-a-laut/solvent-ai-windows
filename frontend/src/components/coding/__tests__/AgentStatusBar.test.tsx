import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AgentStatusBar } from '../AgentStatusBar';

describe('AgentStatusBar', () => {
  it('renders model selector', () => {
    render(
      <AgentStatusBar
        isGenerating={false}
        currentAction=""
        iteration={0}
        model="google/gemini-2.5-pro-exp-03-25"
        onStop={() => {}}
        onClear={() => {}}
        onModelChange={() => {}}
      />
    );
    expect(screen.getByText(/Gemini 2\.5 Pro/)).toBeTruthy();
  });

  it('shows stop button when generating', () => {
    const onStop = vi.fn();
    render(
      <AgentStatusBar
        isGenerating={true}
        currentAction="Writing file..."
        iteration={1}
        model="google/gemini-2.5-pro-exp-03-25"
        onStop={onStop}
        onClear={() => {}}
        onModelChange={() => {}}
      />
    );
    
    expect(screen.getByText(/Stop/)).toBeTruthy();
    expect(screen.getByText(/Writing file/)).toBeTruthy();
    expect(screen.getByText(/Iter 1/)).toBeTruthy();
  });

  it('shows clear button when not generating', () => {
    const onClear = vi.fn();
    render(
      <AgentStatusBar
        isGenerating={false}
        currentAction=""
        iteration={0}
        model="google/gemini-2.5-pro-exp-03-25"
        onStop={() => {}}
        onClear={onClear}
        onModelChange={() => {}}
      />
    );
    
    expect(screen.getByText(/Clear/)).toBeTruthy();
  });

  it('calls onStop when stop button clicked', () => {
    const onStop = vi.fn();
    render(
      <AgentStatusBar
        isGenerating={true}
        currentAction="Thinking..."
        iteration={2}
        model="google/gemini-2.5-pro-exp-03-25"
        onStop={onStop}
        onClear={() => {}}
        onModelChange={() => {}}
      />
    );
    
    fireEvent.click(screen.getByText(/Stop/));
    expect(onStop).toHaveBeenCalled();
  });
});
