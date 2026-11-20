import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../../lib/utils';
import { useAppStore } from '../../store/useAppStore';
import { WATERFALL_PRESET_LIST, type WaterfallPresetMeta } from '../../lib/waterfallPresets';
import { STAGE_CONFIGS, type StageKey } from './WaterfallStageCard';
import { Layers, ChevronDown, Trophy, SlidersHorizontal, AlertTriangle, ChevronRight } from 'lucide-react';

// Stage breadcrumbs: neutral dark-grey capsules with a thin border. Reads as
// a "technical path" rather than three competing color tags. Stage identity is
// already conveyed by position + the colored Pipeline Flow on the right.
// Arrows are intentionally the same color as the pill text at 30% opacity so
// they read as connective tissue, not punctuation.
const StageModelPills: React.FC<{ stageLabels: WaterfallPresetMeta['stageLabels'] }> = ({ stageLabels }) => (
  <div className="flex items-center gap-1 flex-wrap">
    {STAGE_ORDER.map((stage, i) => (
      <React.Fragment key={stage}>
        <span className="px-1.5 py-[2px] rounded-md border border-white/[0.08] bg-white/[0.025] text-[9px] font-mono font-medium text-slate-300/90 tracking-tight whitespace-nowrap">
          {stageLabels[stage]}
        </span>
        {i < STAGE_ORDER.length - 1 && (
          <ChevronRight size={8} className="text-slate-300/30 shrink-0" />
        )}
      </React.Fragment>
    ))}
  </div>
);

const STAGE_ORDER: StageKey[] = ['planner', 'executor', 'reviewer'];

// ─── Model availability types ──────────────────────────────────────────────

interface UnavailableModel {
  model: string;
  provider: string;
  available: boolean;
  usedInPresets: string[];
}

interface UpgradeSuggestion {
  current: { model: string; provider: string };
  successor: { model: string; provider: string };
  note: string;
  usedInPresets: string[];
}

/** Check if a preset has any unavailable models, return list of affected stage labels */
function getPresetWarnings(
  preset: WaterfallPresetMeta,
  unavailable: UnavailableModel[],
): string[] {
  if (unavailable.length === 0) return [];
  const warnings: string[] = [];
  for (const stage of STAGE_ORDER) {
    const sel = preset.selection[stage];
    if (typeof sel === 'object') {
      const isDown = unavailable.some(u => u.provider === sel.provider && u.model === sel.model);
      if (isDown) warnings.push(preset.stageLabels[stage]);
    }
  }
  return warnings;
}

// ─── Score badge ────────────────────────────────────────────────────────────
// Glyph-only grade tag: crisp white letter on a near-transparent background,
// with a soft colored glow behind it. Reads as data, not a sticker.

interface GradeBadge {
  label: string;
  /** Box-shadow string applied as the colored glow + thin ring. */
  glow: string;
}

const gradeBadge = (grade: string | null, category: string): GradeBadge => {
  if (category === 'demo') return {
    label: 'DEMO',
    glow: '0 0 12px rgba(251, 191, 36, 0.35), inset 0 0 0 1px rgba(251, 191, 36, 0.25)',
  };
  if (grade === null) return {
    label: 'NEW',
    glow: '0 0 8px rgba(255, 255, 255, 0.12), inset 0 0 0 1px rgba(255, 255, 255, 0.15)',
  };
  if (grade.startsWith('A')) return {
    label: grade,
    glow: '0 0 14px rgba(16, 185, 129, 0.45), inset 0 0 0 1px rgba(16, 185, 129, 0.3)',
  };
  if (grade.startsWith('B')) return {
    label: grade,
    glow: '0 0 12px rgba(56, 189, 248, 0.4), inset 0 0 0 1px rgba(56, 189, 248, 0.28)',
  };
  if (grade.startsWith('C')) return {
    label: grade,
    glow: '0 0 12px rgba(251, 191, 36, 0.4), inset 0 0 0 1px rgba(251, 191, 36, 0.28)',
  };
  return {
    label: grade,
    glow: '0 0 12px rgba(244, 63, 94, 0.4), inset 0 0 0 1px rgba(244, 63, 94, 0.28)',
  };
};

// ─── Provider Swap Panel ────────────────────────────────────────────────────

const ProviderSwapPanel = ({ preset }: { preset: WaterfallPresetMeta }) => {
  const { setWaterfallCustomStage } = useAppStore();

  const stagesWithAlts = STAGE_ORDER.filter((stage) => {
    const sel = preset.selection[stage];
    if (typeof sel !== 'object') return false;
    return getProviderAlternatives(sel.provider, sel.model) !== null;
  });

  if (stagesWithAlts.length === 0) return null;

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="overflow-hidden"
    >
      <div className="pt-2 pb-1 px-1 space-y-1.5">
        {stagesWithAlts.map((stage) => {
          const cfg = STAGE_CONFIGS[stage];
          const Icon = cfg.icon;
          const sel = preset.selection[stage] as { model: string; provider: string };
          const alts = getProviderAlternatives(sel.provider, sel.model)!;

          return (
            <div key={stage} className="flex items-center gap-2">
              <div className={cn('w-4 h-4 rounded flex items-center justify-center shrink-0', cfg.bgColor)}>
                <Icon size={8} className={cfg.textColor} />
              </div>
              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider w-16 shrink-0">
                {cfg.displayName}
              </span>
              <div className="flex items-center gap-1">
                {alts.group.variants.map((v) => (
                  <button
                    key={v.provider}
                    onClick={(e) => {
                      e.stopPropagation();
                      setWaterfallCustomStage(stage, { model: v.model, provider: v.provider });
                    }}
                    className={cn(
                      'px-1.5 py-0.5 rounded text-[8px] font-bold transition-all border',
                      v.provider === alts.current.provider
                        ? 'bg-jb-purple/15 border-jb-purple/30 text-jb-purple'
                        : 'bg-white/[0.03] border-white/[0.06] text-slate-400 hover:text-slate-400 hover:border-white/15',
                    )}
                  >
                    {v.providerLabel}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
};

// ─── Recommended Row ────────────────────────────────────────────────────────

const RecommendedRow = ({
  preset,
  isSelected,
  isExpanded,
  isDefault,
  onSelect,
  onToggleExpand,
  warnings,
}: {
  preset: WaterfallPresetMeta;
  isSelected: boolean;
  isExpanded: boolean;
  isDefault: boolean;
  onSelect: () => void;
  onToggleExpand: () => void;
  warnings: string[];
}) => {
  const badge = gradeBadge(preset.grade, preset.category);
  const isFast = preset.speed !== '~5m+';

  return (
    <div>
      <div
        className={cn(
          'preset-scan relative rounded-lg border transition-all duration-200 cursor-pointer select-none pl-4 pr-3 py-2.5 overflow-hidden',
          isSelected
            ? 'border-white/[0.08] bg-gradient-to-r from-jb-purple/[0.09] via-white/[0.01] to-transparent'
            : 'border-white/[0.08] bg-white/[0.025] hover:bg-white/[0.05] hover:border-white/[0.16]',
        )}
        onClick={onSelect}
      >
        {/* Left accent bar marks the active selection */}
        {isSelected && (
          <div className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-jb-purple shadow-[0_0_10px_rgba(157,91,210,0.7)]" />
        )}

        <div className="flex items-stretch gap-3">
          {/* LEFT: identity + path */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {isDefault && (
                <div className="w-[5px] h-[5px] rounded-full bg-jb-purple shadow-[0_0_6px_rgba(157,91,210,0.7)] shrink-0" />
              )}
              <span className={cn(
                'text-[12px] font-black tracking-tight shrink-0',
                isSelected ? 'text-white' : 'text-slate-100',
              )}>
                {preset.name}
              </span>
              <span className="text-[11px] italic text-slate-400/70 truncate min-w-0">
                {preset.tagline}
              </span>
            </div>
            <div className="mt-1.5">
              <StageModelPills stageLabels={preset.stageLabels} />
            </div>
          </div>

          {/* RIGHT: specs column with vertical divider */}
          <div className="flex items-center gap-2.5 pl-3 border-l border-white/[0.08] shrink-0">
            <div className="flex flex-col items-end gap-0.5 w-12">
              <span className={cn(
                'text-[10px] font-mono font-bold tabular-nums leading-none',
                isFast ? 'text-emerald-300' : 'text-slate-300',
              )}>
                {preset.speed}
              </span>
              <span className="text-[8px] font-mono uppercase tracking-widest text-slate-500 leading-none">
                {isFast ? 'fast' : 'thorough'}
              </span>
            </div>
            <div
              className="px-1.5 py-0.5 rounded-md text-[10px] font-black tabular-nums tracking-wider text-white bg-transparent"
              style={{ boxShadow: badge.glow }}
            >
              {badge.label}
            </div>
            {warnings.length > 0 && (
              <AlertTriangle size={10} className="text-amber-400" />
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
              className="text-slate-400 hover:text-white transition-colors"
            >
              <ChevronDown size={11} className={cn('transition-transform', isExpanded && 'rotate-180')} />
            </button>
          </div>
        </div>
      </div>
      <AnimatePresence>
        {isExpanded && (
          <ProviderSwapPanel preset={preset} />
        )}
      </AnimatePresence>
    </div>
  );
};

// ─── Top Tier Card ──────────────────────────────────────────────────────────

const TopTierCard = ({
  preset,
  isSelected,
  onSelect,
}: {
  preset: WaterfallPresetMeta;
  isSelected: boolean;
  onSelect: () => void;
}) => {
  const badge = gradeBadge(preset.grade, preset.category);

  return (
    <div
      className={cn(
        'preset-scan relative rounded-md border transition-all duration-200 cursor-pointer select-none pl-2.5 pr-2 py-1.5 overflow-hidden',
        isSelected
          ? 'border-white/[0.08] bg-gradient-to-r from-jb-purple/[0.09] via-white/[0.01] to-transparent'
          : 'border-white/[0.08] bg-white/[0.025] hover:bg-white/[0.05] hover:border-white/[0.16]',
      )}
      onClick={onSelect}
    >
      {isSelected && (
        <div className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r-full bg-jb-purple shadow-[0_0_8px_rgba(157,91,210,0.7)]" />
      )}
      <div className="flex items-center justify-between gap-2">
        <span className={cn(
          'text-[9px] font-black tracking-tight truncate',
          isSelected ? 'text-white' : 'text-slate-200',
        )}>
          {preset.name}
        </span>
        <div
          className="px-1 py-0.5 rounded text-[9px] font-black tabular-nums tracking-wider shrink-0 text-white bg-transparent"
          style={{ boxShadow: badge.glow }}
        >
          {badge.label}
        </div>
      </div>
    </div>
  );
};

// ─── Solo Pill ──────────────────────────────────────────────────────────────

const SoloPill = ({
  preset,
  isSelected,
  onSelect,
}: {
  preset: WaterfallPresetMeta;
  isSelected: boolean;
  onSelect: () => void;
}) => {
  const displayName = preset.name.replace(/^Solo:\s*/, '');

  return (
    <button
      onClick={onSelect}
      className={cn(
        'preset-scan relative rounded-[5px] border transition-all duration-200 pl-2 pr-1.5 py-1 text-center overflow-hidden',
        isSelected
          ? 'border-white/[0.08] bg-gradient-to-r from-jb-purple/[0.09] via-white/[0.01] to-transparent text-white'
          : 'border-white/[0.08] bg-white/[0.025] text-slate-300 hover:bg-white/[0.05] hover:border-white/[0.16]',
      )}
    >
      {isSelected && (
        <div className="absolute left-0 top-0.5 bottom-0.5 w-[2px] rounded-r-full bg-jb-purple shadow-[0_0_6px_rgba(157,91,210,0.7)]" />
      )}
      <span className={cn('text-[8px]', isSelected ? 'font-black' : 'font-semibold')}>{displayName}</span>
    </button>
  );
};

// ─── Custom Stage Row ───────────────────────────────────────────────────────

export const CUSTOM_MODELS: { label: string; value: string; provider: string; group: string }[] = [
  // Groq
  { label: 'GPT-OSS 120B',     value: 'openai/gpt-oss-120b',     provider: 'groq', group: 'Groq' },
  { label: 'Qwen3 32B',        value: 'qwen/qwen3-32b',          provider: 'groq', group: 'Groq' },
  { label: 'Llama 3.3 70B',    value: 'llama-3.3-70b-versatile', provider: 'groq', group: 'Groq' },
  { label: 'Groq Compound',    value: 'groq/compound',           provider: 'groq', group: 'Groq' },
  { label: 'Compound Mini',    value: 'groq/compound-mini',      provider: 'groq', group: 'Groq' },
  { label: 'Llama 4 Scout',    value: 'meta-llama/llama-4-scout-17b-16e-instruct', provider: 'groq', group: 'Groq' },
  // OpenRouter free
  { label: 'Llama 3.3 70B',    value: 'meta-llama/llama-3.3-70b-instruct:free',     provider: 'openrouter', group: 'OpenRouter' },
  { label: 'GPT-OSS 120B',     value: 'openai/gpt-oss-120b:free',                   provider: 'openrouter', group: 'OpenRouter' },
  { label: 'GPT-OSS 20B',      value: 'openai/gpt-oss-20b:free',                    provider: 'openrouter', group: 'OpenRouter' },
  { label: 'Qwen3 Coder',      value: 'qwen/qwen3-coder:free',                      provider: 'openrouter', group: 'OpenRouter' },
  { label: 'Qwen3 Next 80B',   value: 'qwen/qwen3-next-80b-a3b-instruct:free',      provider: 'openrouter', group: 'OpenRouter' },
  { label: 'Hermes 3 405B',    value: 'nousresearch/hermes-3-llama-3.1-405b:free',  provider: 'openrouter', group: 'OpenRouter' },
  { label: 'Nemotron 3 Super', value: 'nvidia/nemotron-3-super-120b-a12b:free',     provider: 'openrouter', group: 'OpenRouter' },
  { label: 'GLM 4.5 Air',      value: 'z-ai/glm-4.5-air',                      provider: 'openrouter', group: 'OpenRouter' },
  // DashScope
  { label: 'Qwen 3.6 Plus',    value: 'qwen3.6-plus',     provider: 'dashscope', group: 'DashScope' },
  { label: 'Qwen3 Coder+',     value: 'qwen3-coder-plus', provider: 'dashscope', group: 'DashScope' },
  { label: 'Qwen3 Max',        value: 'qwen3-max',        provider: 'dashscope', group: 'DashScope' },
  // Cerebras
  { label: 'GPT-OSS 120B',     value: 'gpt-oss-120b',  provider: 'cerebras', group: 'Cerebras' },
  { label: 'Z.ai GLM 4.7',     value: 'zai-glm-4.7',   provider: 'cerebras', group: 'Cerebras' },
  // DeepSeek (direct)
  { label: 'DeepSeek V4 Flash', value: 'deepseek-v4-flash', provider: 'deepseek', group: 'DeepSeek' },
  { label: 'DeepSeek V4 Pro',   value: 'deepseek-v4-pro',   provider: 'deepseek', group: 'DeepSeek' },
  // Fireworks
  { label: 'Kimi K2.6',         value: 'accounts/fireworks/models/kimi-k2p6',                       provider: 'fireworks', group: 'Fireworks' },
  { label: 'Kimi K2.5',         value: 'accounts/fireworks/models/kimi-k2p5',                       provider: 'fireworks', group: 'Fireworks' },
  { label: 'GLM-5.1',           value: 'accounts/fireworks/models/glm-5p1',                         provider: 'fireworks', group: 'Fireworks' },
  { label: 'GLM-5',             value: 'accounts/fireworks/models/glm-5p1',                           provider: 'fireworks', group: 'Fireworks' },
  { label: 'DeepSeek V4 Pro',   value: 'accounts/fireworks/models/deepseek-v4-pro',               provider: 'fireworks', group: 'Fireworks' },
  { label: 'GPT-OSS 120B',      value: 'accounts/fireworks/models/gpt-oss-120b',                    provider: 'fireworks', group: 'Fireworks' },
  // Ollama Cloud
  { label: 'GLM-5.1',          value: 'glm-5.1:cloud',              provider: 'ollama', group: 'Ollama Cloud' },
  { label: 'GLM-5',            value: 'glm-5:cloud',                provider: 'ollama', group: 'Ollama Cloud' },
  { label: 'Kimi K2.6',        value: 'kimi-k2.6:cloud',            provider: 'ollama', group: 'Ollama Cloud' },
  { label: 'Kimi K2.5',        value: 'kimi-k2.5:cloud',            provider: 'ollama', group: 'Ollama Cloud' },
  { label: 'DeepSeek V4 Pro',  value: 'deepseek-v4-pro:cloud',      provider: 'ollama', group: 'Ollama Cloud' },
  { label: 'DeepSeek V4 Flash', value: 'deepseek-v4-flash:cloud',   provider: 'ollama', group: 'Ollama Cloud' },
  { label: 'MiniMax M2.7',     value: 'minimax-m2.7:cloud',         provider: 'ollama', group: 'Ollama Cloud' },
  { label: 'MiniMax M2.5',     value: 'minimax-m2.5:cloud',         provider: 'ollama', group: 'Ollama Cloud' },
  { label: 'Nemotron 3 Super', value: 'nemotron-3-super:cloud',     provider: 'ollama', group: 'Ollama Cloud' },
  { label: 'Nemotron 3 Nano',  value: 'nemotron-3-nano:cloud',      provider: 'ollama', group: 'Ollama Cloud' },
  { label: 'Qwen 3.5',         value: 'qwen3.5:cloud',              provider: 'ollama', group: 'Ollama Cloud' },
  { label: 'Qwen3 Next 80B',   value: 'qwen3-next:80b-cloud',       provider: 'ollama', group: 'Ollama Cloud' },
  { label: 'Qwen3 Coder Next', value: 'qwen3-coder-next:cloud',     provider: 'ollama', group: 'Ollama Cloud' },
  { label: 'Gemma 4',          value: 'gemma4:cloud',               provider: 'ollama', group: 'Ollama Cloud' },
  { label: 'Gemini 3 Flash',   value: 'gemini-3-flash-preview:cloud', provider: 'ollama', group: 'Ollama Cloud' },
];

const groups = [...new Set(CUSTOM_MODELS.map(m => m.group))];

// Local provider-name display map. Kept inline (rather than imported from
// waterfallConstants) to avoid a circular import with this file.
const PROVIDER_DISPLAY: Record<string, string> = {
  groq: 'Groq', fireworks: 'Fireworks', openrouter: 'OpenRouter',
  dashscope: 'DashScope', cerebras: 'Cerebras', ollama: 'Ollama',
  gemini: 'Gemini', deepseek: 'DeepSeek',
};

// ─── Cross-provider model mapping ──────────────────────────────────────────
// Models available on multiple providers under different model IDs.
// Enables one-click provider switching in the custom stage rows.

interface ProviderVariant {
  provider: string;
  model: string;
  providerLabel: string;
}

interface CrossProviderGroup {
  name: string;
  variants: ProviderVariant[];
}

const CROSS_PROVIDER_MODELS: CrossProviderGroup[] = [
  {
    name: 'GPT-OSS 120B',
    variants: [
      { provider: 'groq', model: 'openai/gpt-oss-120b', providerLabel: 'Groq' },
      { provider: 'fireworks', model: 'accounts/fireworks/models/gpt-oss-120b', providerLabel: 'Fireworks' },
      { provider: 'cerebras', model: 'gpt-oss-120b', providerLabel: 'Cerebras' },
      { provider: 'openrouter', model: 'openai/gpt-oss-120b:free', providerLabel: 'OpenRouter' },
    ],
  },
  {
    name: 'Kimi K2.6',
    variants: [
      { provider: 'ollama', model: 'kimi-k2.6:cloud', providerLabel: 'Ollama' },
      { provider: 'fireworks', model: 'accounts/fireworks/models/kimi-k2p6', providerLabel: 'Fireworks' },
    ],
  },
  {
    name: 'Kimi K2.5',
    variants: [
      { provider: 'ollama', model: 'kimi-k2.5:cloud', providerLabel: 'Ollama' },
      { provider: 'fireworks', model: 'accounts/fireworks/models/kimi-k2p5', providerLabel: 'Fireworks' },
    ],
  },
  {
    name: 'GLM-5',
    variants: [
      { provider: 'ollama', model: 'glm-5:cloud', providerLabel: 'Ollama' },
      { provider: 'fireworks', model: 'accounts/fireworks/models/glm-5p1', providerLabel: 'Fireworks' },
    ],
  },
  {
    name: 'GLM-5.1',
    variants: [
      { provider: 'ollama', model: 'glm-5.1:cloud', providerLabel: 'Ollama' },
      { provider: 'fireworks', model: 'accounts/fireworks/models/glm-5p1', providerLabel: 'Fireworks' },
    ],
  },
  {
    name: 'Qwen 3.6 Plus',
    variants: [
      { provider: 'dashscope', model: 'qwen3.6-plus', providerLabel: 'DashScope' },
    ],
  },
  {
    name: 'DeepSeek V4 Pro',
    variants: [
      { provider: 'ollama', model: 'deepseek-v4-pro:cloud', providerLabel: 'Ollama' },
      { provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4-pro', providerLabel: 'Fireworks' },
      { provider: 'deepseek', model: 'deepseek-v4-pro', providerLabel: 'DeepSeek' },
    ],
  },
  {
    name: 'Llama 3.3 70B',
    variants: [
      { provider: 'groq', model: 'llama-3.3-70b-versatile', providerLabel: 'Groq' },
      { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', providerLabel: 'OpenRouter' },
    ],
  },
  {
    name: 'Qwen3 Coder',
    variants: [
      { provider: 'dashscope', model: 'qwen3-coder-plus', providerLabel: 'DashScope' },
      { provider: 'ollama', model: 'qwen3-coder-next:cloud', providerLabel: 'Ollama' },
      { provider: 'openrouter', model: 'qwen/qwen3-coder:free', providerLabel: 'OpenRouter' },
    ],
  },
  {
    name: 'MiniMax M2.7',
    variants: [
      { provider: 'ollama', model: 'minimax-m2.7:cloud', providerLabel: 'Ollama' },
    ],
  },
];

const crossProviderLookup = new Map<string, CrossProviderGroup>();
for (const group of CROSS_PROVIDER_MODELS) {
  for (const v of group.variants) {
    crossProviderLookup.set(`${v.provider}:${v.model}`, group);
  }
}

function getProviderAlternatives(provider: string, model: string): { group: CrossProviderGroup; current: ProviderVariant } | null {
  const group = crossProviderLookup.get(`${provider}:${model}`);
  if (!group || group.variants.length < 2) return null;
  const current = group.variants.find(v => v.provider === provider && v.model === model);
  if (!current) return null;
  return { group, current };
}

// ─── Custom Stage Row ───────────────────────────────────────────────────────

const CustomStageRow = ({
  stage,
  currentSelection,
  onChange,
}: {
  stage: StageKey;
  currentSelection: string | { model: string; provider: string };
  onChange: (model: string, provider: string) => void;
}) => {
  const cfg = STAGE_CONFIGS[stage];
  const Icon = cfg.icon;

  const currentKey = typeof currentSelection === 'object'
    ? `${currentSelection.provider}:${currentSelection.model}`
    : '';

  const alternatives = typeof currentSelection === 'object'
    ? getProviderAlternatives(currentSelection.provider, currentSelection.model)
    : null;

  // Stage tints — faint ambient glow that signals which "zone" you're editing.
  const stageTint: Record<StageKey, string> = {
    planner: 'border-jb-purple/25 bg-jb-purple/[0.04] shadow-[inset_0_0_24px_rgba(157,91,210,0.06)]',
    executor: 'border-jb-orange/25 bg-jb-orange/[0.04] shadow-[inset_0_0_24px_rgba(251,146,60,0.06)]',
    reviewer: 'border-emerald-500/25 bg-emerald-500/[0.04] shadow-[inset_0_0_24px_rgba(16,185,129,0.06)]',
  };

  return (
    <div className={cn('relative rounded-xl border p-3 space-y-2.5', stageTint[stage])}>
      {/* Stage identity header */}
      <div className="flex items-center gap-2.5">
        <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center border', cfg.bgColor, `border-${cfg.color}/30`)}>
          <Icon size={13} className={cfg.textColor} />
        </div>
        <div className="flex flex-col leading-tight">
          <span className={cn('text-[10px] font-black uppercase tracking-[0.25em] leading-none', cfg.textColor)}>
            {cfg.displayName}
          </span>
          <span className="text-[9px] font-mono uppercase tracking-wider text-slate-500 mt-0.5 leading-none">
            Source
          </span>
        </div>
      </div>

      {/* Model select + provider chips grouped as one Source Row */}
      <div className="rounded-lg border border-white/[0.1] bg-black/30 overflow-hidden">
        <select
          value={currentKey}
          onChange={(e) => {
            const [provider = '', ...modelParts] = e.target.value.split(':');
            const model = modelParts.join(':');
            onChange(model, provider);
          }}
          className={cn(
            'w-full bg-transparent px-3 py-2 text-[12px] font-bold text-white outline-none appearance-none cursor-pointer',
            'border-b border-white/[0.06] focus:border-white/[0.16] transition-colors',
          )}
        >
          {groups.map((group) => (
            <optgroup key={group} label={group} className="bg-[#0a0a0f]">
              {CUSTOM_MODELS.filter(m => m.group === group).map((m) => (
                <option key={`${m.provider}:${m.value}`} value={`${m.provider}:${m.value}`}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        {/* Provider chips strip — visually attached to the dropdown above. */}
        {alternatives ? (
          <div className="flex items-center gap-1.5 px-3 py-2 bg-white/[0.015]">
            <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500 shrink-0 mr-1">
              via
            </span>
            {alternatives.group.variants.map((v) => {
              const isActive = v.provider === alternatives.current.provider;
              return (
                <button
                  key={v.provider}
                  onClick={() => onChange(v.model, v.provider)}
                  className={cn(
                    'px-2 py-0.5 rounded-md text-[10px] font-bold transition-all border',
                    isActive
                      ? cn(cfg.bgColor, cfg.textColor, `border-${cfg.color}/40`)
                      : 'bg-white/[0.03] border-white/[0.08] text-slate-400 hover:text-white hover:border-white/[0.2]',
                  )}
                >
                  {v.providerLabel}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="px-3 py-1.5 bg-white/[0.015]">
            <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
              via {typeof currentSelection === 'object' ? (PROVIDER_DISPLAY[currentSelection.provider] ?? currentSelection.provider) : '—'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Main Component ─────────────────────────────────────────────────────────

export const WaterfallPresetPicker = ({
  unavailableModels,
  upgradeSuggestions: _upgradeSuggestions,
  dismissedKeys: _dismissedKeys,
  onDismissUpgrade: _onDismissUpgrade,
  onSwapModel: _onSwapModel,
}: {
  unavailableModels: UnavailableModel[];
  upgradeSuggestions: UpgradeSuggestion[];
  dismissedKeys: Set<string>;
  onDismissUpgrade: (key: string) => void;
  onSwapModel: (stage: StageKey, model: string, provider: string) => void;
}) => {
  const {
    waterfallPresetKey,
    waterfallModelSelection,
    setWaterfallPreset,
    setWaterfallCustomStage,
  } = useAppStore();

  const [expandedPreset, setExpandedPreset] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(waterfallPresetKey === 'custom');

  const recommended = WATERFALL_PRESET_LIST.filter(p => p.category === 'recommended');
  const topTier = WATERFALL_PRESET_LIST.filter(p => p.category === 'top');
  const solo = WATERFALL_PRESET_LIST.filter(p => p.category === 'solo');

  const handleSelect = (key: string) => {
    setWaterfallPreset(key);
    setShowCustom(false);
    if (expandedPreset !== key) setExpandedPreset(null);
  };

  const handleCustomToggle = () => {
    setShowCustom(!showCustom);
    if (!showCustom) setExpandedPreset(null);
  };

  return (
    <div className="surface-1 bg-white/[0.035] rounded-[2rem] overflow-hidden backdrop-blur-xl">
      <div className="p-6 space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Layers size={14} className="text-slate-300" />
            <span className="text-[12px] font-black text-slate-300 uppercase tracking-widest">
              Pipeline Preset
            </span>
          </div>
          <button
            onClick={handleCustomToggle}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 text-[12px] font-bold uppercase tracking-wider',
              showCustom
                ? 'cta-primary'
                : 'cta-secondary',
            )}
          >
            <SlidersHorizontal size={11} />
            Custom
          </button>
        </div>

        {!showCustom && (
          <>
            {/* ── RECOMMENDED ── */}
            <div className="space-y-2">
              <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                RECOMMENDED · benchmarked across 4 prompts
              </span>
              <div className="space-y-1.5">
                {recommended.map((preset) => (
                  <RecommendedRow
                    key={preset.key}
                    preset={preset}
                    isSelected={waterfallPresetKey === preset.key}
                    isExpanded={expandedPreset === preset.key}
                    isDefault={preset.key === 'kimi-coder'}
                    onSelect={() => handleSelect(preset.key)}
                    onToggleExpand={() => setExpandedPreset(expandedPreset === preset.key ? null : preset.key)}
                    warnings={getPresetWarnings(preset, unavailableModels)}
                  />
                ))}
              </div>
            </div>

            {/* ── TOP TIER ── grouped fieldset so it reads as a distinct cluster */}
            <div className="rounded-xl bg-black/30 border border-white/[0.06] p-3 space-y-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                  TOP TIER
                </span>
                <div className="flex-1 h-px bg-white/[0.06]" />
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {topTier.map((preset) => (
                  <TopTierCard
                    key={preset.key}
                    preset={preset}
                    isSelected={waterfallPresetKey === preset.key}
                    onSelect={() => {
                      handleSelect(preset.key);
                      setExpandedPreset(expandedPreset === preset.key ? null : preset.key);
                    }}
                  />
                ))}
              </div>
              <AnimatePresence>
                {topTier.some(p => p.key === expandedPreset) && (() => {
                  const expanded = topTier.find(p => p.key === expandedPreset);
                  return expanded ? <ProviderSwapPanel preset={expanded} /> : null;
                })()}
              </AnimatePresence>
            </div>

            {/* ── SOLO ── grouped fieldset (matches Top Tier visually) */}
            <div className="rounded-xl bg-black/30 border border-white/[0.06] p-3 space-y-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                  SOLO · single model, all stages
                </span>
                <div className="flex-1 h-px bg-white/[0.06]" />
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {solo.map((preset) => (
                  <SoloPill
                    key={preset.key}
                    preset={preset}
                    isSelected={waterfallPresetKey === preset.key}
                    onSelect={() => handleSelect(preset.key)}
                  />
                ))}
              </div>
            </div>
          </>
        )}

        {/* Custom panel */}
        <AnimatePresence>
          {showCustom && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="pt-3 border-t border-white/[0.08]">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[10px] text-slate-300 font-mono uppercase tracking-widest">
                    Engine Room
                  </span>
                  <div className="flex-1 h-px bg-white/[0.08]" />
                  <span className="text-[10px] text-slate-500 font-mono">
                    Select a model per stage
                  </span>
                </div>
                {/* Connected nodes — the vertical line lives in the gap between
                    Source Rows, visually wiring planner → executor → reviewer
                    along the same Waterfall logic as the right-hand flow chart. */}
                <div className="relative">
                  <div className="absolute left-[26px] top-12 bottom-12 w-px bg-gradient-to-b from-jb-purple/40 via-jb-orange/40 to-emerald-500/40" />
                  <div className="space-y-2.5 relative">
                    {STAGE_ORDER.map((stage) => (
                      <CustomStageRow
                        key={stage}
                        stage={stage}
                        currentSelection={waterfallModelSelection[stage]}
                        onChange={(model, provider) => setWaterfallCustomStage(stage, { model, provider })}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Footer hint */}
        <div className="pt-2 border-t border-white/[0.08]">
          <div className="flex items-center gap-2">
            <Trophy size={11} className="text-slate-300" />
            <span className="text-[12px] text-slate-300 font-mono">
              Scores from automated pipeline benchmarks · results may vary
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
