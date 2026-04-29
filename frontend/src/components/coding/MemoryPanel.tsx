import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, Trash2, RefreshCw, Search, X, Tag, Clock } from 'lucide-react';
import { cn } from '../../lib/utils';
import { BASE_URL } from '../../lib/config';
import { fetchWithRetry, getSecret } from '../../lib/api-client';

interface MemoryEntry {
  id: string;
  text: string;
  metadata: {
    type: string;
    tier: string;
    tags?: string[];
    createdAt?: string;
    source?: string;
  };
  vector?: number[];
}

interface Props {
  visible: boolean;
  onClose: () => void;
}

const TYPE_COLORS: Record<string, string> = {
  permanent_rule: 'bg-emerald-500/15 text-emerald-400',
  architectural_decision: 'bg-violet-500/15 text-violet-400',
  technical_fact: 'bg-blue-500/15 text-blue-400',
  solution_pattern: 'bg-amber-500/15 text-amber-400',
  deprecated: 'bg-white/[0.06] text-white/30',
  file_read: 'bg-white/[0.06] text-white/30',
};

export const MemoryPanel: React.FC<Props> = ({ visible, onClose }) => {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [error, setError] = useState<string | null>(null);

  const fetchMemories = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const secret = await getSecret();
      const data = await fetchWithRetry(
        `${BASE_URL}/api/memory/entries?limit=200&tier=crystallized`,
        { headers: { 'X-Solvent-Secret': secret } }
      ) as { entries: MemoryEntry[] };
      setMemories(data.entries ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load memories');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) fetchMemories();
  }, [visible, fetchMemories]);

  const handleDelete = async (id: string) => {
    try {
      const secret = await getSecret();
      await fetchWithRetry(`${BASE_URL}/api/memory/entries/${id}`, {
        method: 'DELETE',
        headers: { 'X-Solvent-Secret': secret },
      });
      setMemories(prev => prev.filter(m => m.id !== id));
    } catch {
      // Silently fail — entry stays in list
    }
  };

  // Filter and group
  const filtered = memories.filter(m => {
    if (filterType !== 'all' && m.metadata.type !== filterType) return false;
    if (search) {
      const q = search.toLowerCase();
      return m.text.toLowerCase().includes(q) ||
             (m.metadata.tags?.some(t => t.toLowerCase().includes(q)) ?? false);
    }
    return true;
  });

  const grouped = filtered.reduce((acc, m) => {
    const type = m.metadata.type || 'other';
    if (!acc[type]) acc[type] = [];
    acc[type].push(m);
    return acc;
  }, {} as Record<string, MemoryEntry[]>);

  const types = Object.keys(grouped).sort((a, b) => (grouped[b]?.length ?? 0) - (grouped[a]?.length ?? 0));

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ x: '100%', opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: '100%', opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="w-[340px] shrink-0 bg-jb-panel border-l border-white/[0.06] flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] shrink-0">
            <Brain size={14} className="text-violet-400" />
            <span className="text-[12px] font-semibold text-white/70">Agent Memory</span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={fetchMemories}
              className="p-1 rounded hover:bg-white/[0.06] text-white/30 hover:text-white/60 transition-colors"
              title="Refresh"
            >
              <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover:bg-white/[0.06] text-white/30 hover:text-white/60 transition-colors"
            >
              <X size={12} />
            </button>
          </div>

          {/* Search + filter */}
          <div className="px-3 py-2 flex items-center gap-2 border-b border-white/[0.06] shrink-0">
            <div className="relative flex-1">
              <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-white/20" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search memories..."
                className="w-full pl-6 pr-2 py-1 bg-white/[0.04] border border-white/[0.06] rounded text-[11px] text-white/60 outline-none placeholder:text-white/20"
              />
            </div>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="px-2 py-1 bg-white/[0.04] border border-white/[0.06] rounded text-[10px] text-white/50 outline-none cursor-pointer"
            >
              <option value="all">All types</option>
              {types.map(t => (
                <option key={t} value={t}>{t} ({grouped[t]?.length})</option>
              ))}
            </select>
          </div>

          {/* Stats */}
          <div className="px-3 py-1.5 text-[10px] text-white/25 border-b border-white/[0.06] shrink-0 flex items-center gap-3">
            <span>{filtered.length} crystallized memories</span>
            <span>•</span>
            <span>{types.length} types</span>
          </div>

          {/* Memory list */}
          <div className="flex-1 overflow-y-auto">
            {error && (
              <div className="px-3 py-2 text-[11px] text-rose-400/80">{error}</div>
            )}

            {loading && memories.length === 0 && (
              <div className="px-3 py-4 text-[11px] text-white/30 text-center">Loading memories...</div>
            )}

            {!loading && filtered.length === 0 && (
              <div className="px-3 py-4 text-[11px] text-white/20 text-center">
                {memories.length === 0
                  ? 'No crystallized memories yet. The Overseer creates these as it learns about your project.'
                  : 'No memories match your filters.'}
              </div>
            )}

            {types.map(type => (
              <div key={type}>
                <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white/20 bg-white/[0.02] sticky top-0">
                  {type} ({grouped[type]?.length})
                </div>
                {(grouped[type] ?? []).map(memory => (
                  <div
                    key={memory.id}
                    className="group px-3 py-2 border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] text-white/50 leading-relaxed line-clamp-3">
                          {memory.text.slice(0, 200)}
                          {memory.text.length > 200 ? '...' : ''}
                        </p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={cn('text-[9px] px-1.5 py-0.5 rounded font-medium', TYPE_COLORS[memory.metadata.type] || 'bg-white/[0.06] text-white/30')}>
                            {memory.metadata.type}
                          </span>
                          {memory.metadata.tags && memory.metadata.tags.length > 0 && (
                            <span className="flex items-center gap-0.5 text-[9px] text-white/20">
                              <Tag size={8} />
                              {memory.metadata.tags.slice(0, 3).join(', ')}
                            </span>
                          )}
                          {memory.metadata.createdAt && (
                            <span className="flex items-center gap-0.5 text-[9px] text-white/15">
                              <Clock size={8} />
                              {new Date(memory.metadata.createdAt).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDelete(memory.id)}
                        className="shrink-0 p-1 rounded text-white/10 hover:text-rose-400 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100 transition-all"
                        title="Delete this memory"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
