import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';

export const PipChatWidget: React.FC = () => {
  const { messages, isProcessing, sendMessage } = useAppStore(
    useShallow((s) => ({
      messages: s.messages,
      isProcessing: s.isProcessing,
      sendMessage: s.sendMessage,
    }))
  );

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const tail = messages.slice(-20);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [tail.length]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isProcessing) return;
    setInput('');
    await sendMessage(text);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto fluid-scrollbar px-2.5 py-2 space-y-1.5 min-h-0">
        {tail.length === 0 ? (
          <div className="h-full flex items-center justify-center opacity-15">
            <span className="text-[9px] font-medium uppercase tracking-wider">Chat with the overseer</span>
          </div>
        ) : (
          tail.map((m, i) => (
            <div key={m.id || i} className={cn(
              'px-2 py-1 rounded-lg text-[10px] leading-relaxed max-w-[90%]',
              m.role === 'user'
                ? 'ml-auto bg-jb-accent/10 text-slate-300 border border-jb-accent/15'
                : 'bg-white/[0.03] text-slate-400 border border-white/[0.04]',
            )}>
              <span className={cn(
                'text-[8px] font-semibold uppercase tracking-wider block mb-0.5',
                m.role === 'user' ? 'text-jb-accent/60' : 'text-emerald-400/60',
              )}>
                {m.role === 'user' ? 'You' : 'AI'}
              </span>
              <p className="line-clamp-4">{m.content}</p>
            </div>
          ))
        )}
        {isProcessing && (
          <div className="flex items-center gap-1.5 px-2 py-1">
            <Loader2 size={8} className="animate-spin text-emerald-400" />
            <span className="text-[9px] text-slate-500">Thinking...</span>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 px-2.5 pb-2 pt-1.5 border-t border-white/[0.04]">
        <div className="flex items-center gap-1.5 bg-black/30 border border-white/[0.06] focus-within:border-white/[0.12] rounded-lg px-2 py-1 transition-colors">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Ask overseer..."
            className="flex-1 bg-transparent outline-none text-[10px] text-slate-300 placeholder:text-white/15 font-sans min-w-0"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isProcessing}
            className="shrink-0 p-1 rounded text-jb-accent hover:text-white disabled:opacity-30 transition-colors"
          >
            <Send size={10} fill="currentColor" />
          </button>
        </div>
      </div>
    </div>
  );
};
