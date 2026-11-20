import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AgentTextBlock } from '../AgentTextBlock';

describe('AgentTextBlock', () => {
  it('renders raw text with blinking cursor when streaming', () => {
    render(<AgentTextBlock text="Hello **world**" isStreaming />);
    const el = screen.getByText(/Hello \*\*world\*\*/);
    expect(el).toBeTruthy();
    expect(el).toHaveClass('whitespace-pre-wrap');
    const cursor = el.querySelector('span');
    expect(cursor).toBeTruthy();
  });

  it('renders markdown when not streaming', () => {
    render(<AgentTextBlock text="**bold** and `code`" isStreaming={false} />);
    const bold = screen.getByRole('strong');
    expect(bold).toHaveTextContent('bold');
    const code = screen.getByRole('code') || document.querySelector('code');
    expect(code).toBeTruthy();
    const text = screen.getByText(/bold/);
    expect(text.querySelector('span.animate-blink')).toBeNull();
  });

  it('renders empty state gracefully', () => {
    const { container } = render(<AgentTextBlock text="" isStreaming />);
    // Streaming with no text still shows the typing indicator dots
    expect(container.querySelector('.animate-bounce')).toBeTruthy();
  });

  it('renders empty state when not streaming', () => {
    const { container } = render(<AgentTextBlock text="" isStreaming={false} />);
    expect(container).toBeTruthy();
  });
});
