import { useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAppStore } from '../store/useAppStore';
import { TIER_CONFIG } from './performanceTier';

export function useVirtualMessages() {
  const messages = useAppStore(state => state.messages);
  const isProcessing = useAppStore(state => state.isProcessingByMode[state.currentMode] ?? false);
  const activeTier = useAppStore(state => state.activeTier);
  const scrollRef = useRef<HTMLDivElement>(null);
  const overscan = TIER_CONFIG[activeTier].messageBufferSize;

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan,
  });

  useEffect(() => {
    if (messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end', behavior: 'smooth' });
    }
    // virtualizer is a fresh object every render (see above); depending on it
    // would re-run this on every paint instead of only on new messages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, isProcessing]);

  return { scrollRef, virtualizer, messages };
}
