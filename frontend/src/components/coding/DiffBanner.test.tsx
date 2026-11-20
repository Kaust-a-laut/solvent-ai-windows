import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DiffBanner } from './DiffBanner';
import type { StagedDiff } from '../../store/codingSlice';

const makeDiff = (overrides: Partial<StagedDiff> = {}): StagedDiff => ({
  filePath: 'src/auth.ts',
  original: 'const a = 1;\n',
  modified: 'const a = 2;\n',
  description: 'Fix null check',
  callId: 'call-1',
  status: 'pending',
  ...overrides,
});

describe('DiffBanner', () => {
  it('renders nothing when there are no diffs', () => {
    const { container } = render(
      <DiffBanner diffs={[]} onApplyAll={vi.fn()} onRejectAll={vi.fn()} onToggleStatus={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the staged file path and pending count', () => {
    render(
      <DiffBanner diffs={[makeDiff()]} onApplyAll={vi.fn()} onRejectAll={vi.fn()} onToggleStatus={vi.fn()} />
    );
    expect(screen.getByText('src/auth.ts')).toBeTruthy();
    expect(screen.getByText(/1 pending/)).toBeTruthy();
  });

  it('calls onApplyAll when Apply All clicked', () => {
    const onApplyAll = vi.fn();
    render(
      <DiffBanner diffs={[makeDiff()]} onApplyAll={onApplyAll} onRejectAll={vi.fn()} onToggleStatus={vi.fn()} />
    );
    fireEvent.click(screen.getByText('Apply All'));
    expect(onApplyAll).toHaveBeenCalledOnce();
  });

  it('calls onRejectAll when Reject All clicked', () => {
    const onRejectAll = vi.fn();
    render(
      <DiffBanner diffs={[makeDiff()]} onApplyAll={vi.fn()} onRejectAll={onRejectAll} onToggleStatus={vi.fn()} />
    );
    fireEvent.click(screen.getByText('Reject All'));
    expect(onRejectAll).toHaveBeenCalledOnce();
  });

  it('calls onToggleStatus when a per-file action is used', () => {
    const onToggleStatus = vi.fn();
    const { container } = render(
      <DiffBanner diffs={[makeDiff()]} onApplyAll={vi.fn()} onRejectAll={vi.fn()} onToggleStatus={onToggleStatus} />
    );
    // Per-file approve/reject buttons sit after the status badge in the row
    const rowButtons = container.querySelectorAll('button');
    // First two buttons are header Apply All / Reject All; the row chevron is
    // next, followed by the per-file approve button.
    fireEvent.click(rowButtons[3]!);
    expect(onToggleStatus).toHaveBeenCalledWith('call-1', 'approved');
  });
});
