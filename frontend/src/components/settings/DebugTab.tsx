import React, { useEffect, useState } from 'react';
import { API_BASE_URL } from '../../lib/config';

interface TraceItem {
  id: string;
  score?: number;
  reason?: string;
}

interface DebugTrace {
  timestamp: string | number;
  sessionId?: string;
  active?: TraceItem[];
  suppressed?: TraceItem[];
  budget?: { used: number; limit: number };
}

export const DebugTab = () => {
  const [traces, setTraces] = useState<DebugTrace[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTraces = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/debug/traces`);
        if (res.ok) {
          const data = await res.json();
          setTraces(data);
        }
      } catch (e) {
        console.error('Failed to fetch traces', e);
      } finally {
        setLoading(false);
      }
    };
    fetchTraces();
    const int = setInterval(fetchTraces, 10000);
    return () => clearInterval(int);
  }, []);

  if (loading) {
    return <div className="flex h-full items-center justify-center text-slate-400 text-xs">Loading traces...</div>;
  }

  if (traces.length === 0) {
    return <div className="flex h-full items-center justify-center text-slate-400 text-xs">No traces recorded yet.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-bold text-white">System Traces</h4>
        <p className="text-xs text-slate-400">Recent RAG retrievals and orchestration decisions</p>
      </div>

      <div className="space-y-4">
        {traces.map((trace, i) => (
          <div key={i} className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-white/5 pb-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-jb-accent">{new Date(trace.timestamp).toLocaleString()}</span>
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{trace.sessionId || 'Unknown Session'}</span>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Active Context</span>
                <div className="bg-black/20 rounded-lg p-2 text-xs text-slate-300 font-mono">
                  {trace.active?.length || 0} items retrieved
                  {trace.active?.map((item, idx) => (
                    <div key={idx} className="mt-1 truncate text-[10px] text-slate-400">
                      [{item.score?.toFixed(2) || 'N/A'}] {item.id}
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Suppressed Context</span>
                <div className="bg-black/20 rounded-lg p-2 text-xs text-slate-300 font-mono">
                  {trace.suppressed?.length || 0} items excluded
                  {trace.suppressed?.map((item, idx) => (
                    <div key={idx} className="mt-1 truncate text-[10px] text-rose-400/80">
                      {item.reason}: {item.id}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {trace.budget && (
              <div className="flex items-center gap-4 text-[10px] font-mono text-slate-400 pt-2">
                <span>Used Tokens: <span className="text-white">{trace.budget.used}</span></span>
                <span>Limit: <span className="text-white">{trace.budget.limit}</span></span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};