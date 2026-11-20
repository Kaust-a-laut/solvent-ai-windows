// Centralized model definitions used across CompareArea, DebateArea, and ChatHeader.
// Single source of truth — prevents drift between components.

import { GROQ_ALL_MODELS, GROQ_CHAT_MODELS } from './groqModels';
import { OPENROUTER_FREE_ALL_MODELS, OPENROUTER_FREE_CHAT_MODELS } from './openrouterModels';
import { DASHSCOPE_ALL_MODELS, DASHSCOPE_CHAT_MODELS } from './dashscopeModels';
import { CEREBRAS_ALL_MODELS, CEREBRAS_CHAT_MODELS } from './cerebrasModels';
import { FIREWORKS_ALL_MODELS, FIREWORKS_CHAT_MODELS } from './fireworksModels';

// ── Ollama Cloud models ──────────────────────────────────────────────────────

export const OLLAMA_CLOUD_CHAT_MODELS = [
  // Frontier
  { label: 'Kimi K2.6',            value: 'kimi-k2.6:cloud' },
  { label: 'Kimi K2.5',            value: 'kimi-k2.5:cloud' },
  { label: 'GLM-5.1',              value: 'glm-5.1:cloud' },
  { label: 'GLM-5',                value: 'glm-5:cloud' },
  // DeepSeek V4
  { label: 'DeepSeek V4 Pro',      value: 'deepseek-v4-pro:cloud' },
  { label: 'DeepSeek V4 Flash',    value: 'deepseek-v4-flash:cloud' },
  // Qwen
  { label: 'Qwen 3.5',             value: 'qwen3.5:cloud' },
  { label: 'Qwen3 Next (80B)',     value: 'qwen3-next:80b-cloud' },
  { label: 'Qwen3 Coder Next',     value: 'qwen3-coder-next:cloud' },
  // Nvidia Nemotron
  { label: 'Nemotron 3 Super',     value: 'nemotron-3-super:cloud' },
  { label: 'Nemotron 3 Nano',      value: 'nemotron-3-nano:cloud' },
  // MiniMax
  { label: 'MiniMax M2.7',         value: 'minimax-m2.7:cloud' },
  { label: 'MiniMax M2.5',         value: 'minimax-m2.5:cloud' },
  // Other
  { label: 'Gemma 4',              value: 'gemma4:cloud' },
  { label: 'Devstral 2 (123B)',    value: 'devstral-2:cloud' },
  { label: 'Cogito 2.1 (671B)',    value: 'cogito-2.1:671b-cloud' },
  { label: 'Gemini 3 Flash (Cloud)', value: 'gemini-3-flash-preview:cloud' },
] as const;

// ── Gemini models (shared across ChatHeader + Compare/Debate) ────────────────

export const GEMINI_CHAT_MODELS = [
  // Stable (latest generation)
  { label: 'Gemini 3.1 Flash Lite', value: 'gemini-3.1-flash-lite' },
  // Preview variants
  { label: 'Gemini 3.1 Pro Preview',        value: 'gemini-3.1-pro-preview' },
  { label: 'Gemini 3 Flash Preview',        value: 'gemini-3-flash-preview' },
  { label: 'Gemini 3.1 Flash Lite Preview', value: 'gemini-3.1-flash-lite-preview' },
  // 2.5 family — deprecating June/July 2026
  { label: 'Gemini 2.5 Pro',        value: 'gemini-2.5-pro' },
  { label: 'Gemini 2.5 Flash',      value: 'gemini-2.5-flash' },
  { label: 'Gemini 2.5 Flash Lite', value: 'gemini-2.5-flash-lite' },
] as const;

// ── ALL_MODELS — flat list with provider/model/label/group ───────────────────
// Used by CompareArea, DebateArea, and ModelPickerDropdown

export const ALL_MODELS = [
  ...GEMINI_CHAT_MODELS.map(m => ({
    provider: 'gemini' as const,
    model: m.value,
    label: m.label,
    group: 'Gemini' as const,
  })),
  ...GROQ_ALL_MODELS,
  { provider: 'deepseek',   model: 'deepseek-v4-pro',                label: 'DeepSeek V4 Pro',       group: 'DeepSeek' },
  { provider: 'deepseek',   model: 'deepseek-v4-flash',              label: 'DeepSeek V4 Flash',     group: 'DeepSeek' },
  { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5',    label: 'Claude Sonnet 4.5',     group: 'OpenRouter' },
  { provider: 'openrouter', model: 'anthropic/claude-sonnet-4',      label: 'Claude Sonnet 4',       group: 'OpenRouter' },
  ...OPENROUTER_FREE_ALL_MODELS,
  ...DASHSCOPE_ALL_MODELS,
  ...CEREBRAS_ALL_MODELS,
  ...FIREWORKS_ALL_MODELS,
  ...OLLAMA_CLOUD_CHAT_MODELS.map(m => ({
    provider: 'ollama' as const,
    model: m.value,
    label: m.label,
    group: 'Ollama Cloud' as const,
  })),
  { provider: 'ollama',     model: 'qwen2.5-coder:7b',               label: 'Qwen 2.5 Coder 7B',    group: 'Local' },
  { provider: 'ollama',     model: 'qwen2.5-coder:14b',              label: 'Qwen 2.5 Coder 14B',   group: 'Local' },
  { provider: 'ollama',     model: 'deepseek-r1:8b',                 label: 'DeepSeek R1 8B',        group: 'Local' },
  { provider: 'ollama',     model: 'llama3.1:8b',                    label: 'Llama 3.1 8B',          group: 'Local' },
  { provider: 'ollama',     model: 'mistral:7b',                     label: 'Mistral 7B',            group: 'Local' },
];

// ── PROVIDER_GROUPS — grouped format for ChatHeader dropdown ─────────────────

export const PROVIDER_GROUPS = [
  {
    id: 'groq',
    label: 'Groq',
    models: [...GROQ_CHAT_MODELS],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    models: [...GEMINI_CHAT_MODELS],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    models: [
      { label: 'Claude Sonnet 4',   value: 'anthropic/claude-sonnet-4' },
      { label: 'Claude Sonnet 4.5', value: 'anthropic/claude-sonnet-4.5' },
      { label: 'Gemini 2.5 Flash',  value: 'google/gemini-2.5-flash' },
      { label: 'Gemini 2.5 Pro',    value: 'google/gemini-2.5-pro' },
      { label: 'DeepSeek V3',       value: 'deepseek/deepseek-chat-v3-0324' },
      { label: 'Llama 4 Scout',     value: 'meta-llama/llama-4-scout-17b-16e-instruct' },
      ...OPENROUTER_FREE_CHAT_MODELS,
    ],
  },
  {
    id: 'dashscope',
    label: 'DashScope (Qwen)',
    models: [...DASHSCOPE_CHAT_MODELS],
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    models: [...CEREBRAS_CHAT_MODELS],
  },
  {
    id: 'fireworks',
    label: 'Fireworks',
    models: [...FIREWORKS_CHAT_MODELS],
  },
  {
    id: 'ollama',
    label: 'Ollama Cloud',
    models: [...OLLAMA_CLOUD_CHAT_MODELS],
  },
] as const;

// ── Live-aware variants ───────────────────────────────────────────────────────
// The static lists above are the curated catalog (labels, grouping, order).
// These hooks intersect them with the live registry from /api/v1/models:
// retired ids drop out, and ids the provider added that we have no label for
// yet are appended with their raw id as the label. Until the fetch lands (or
// when a provider is unverifiable) the curated entries pass through untouched.

import { useMemo } from 'react';
import { useLiveModels, type LiveModelMap } from './liveModels';

const GROUP_LABELS: Record<string, string> = {
  groq: 'Groq', gemini: 'Gemini', openrouter: 'OpenRouter',
  dashscope: 'DashScope', cerebras: 'Cerebras', fireworks: 'Fireworks',
  deepseek: 'DeepSeek', ollama: 'Ollama Cloud',
};

export interface LiveModelEntry {
  provider: string;
  model: string;
  label: string;
  group: string;
}

function filterAllModels(live: LiveModelMap | null): LiveModelEntry[] {
  const base: LiveModelEntry[] = ALL_MODELS.map(m => ({ ...m }));
  if (!live) return base;
  const out = base.filter(m => {
    const list = live[m.provider];
    return !list || list.includes(m.model);
  });
  // Append live ids with no curated entry (backend already caps extras to
  // small catalogs, so this can't flood the list).
  for (const [provider, ids] of Object.entries(live)) {
    for (const id of ids) {
      if (!out.some(m => m.provider === provider && m.model === id)) {
        out.push({ provider, model: id, label: id, group: GROUP_LABELS[provider] ?? provider });
      }
    }
  }
  return out;
}

export function useLiveAllModels(): LiveModelEntry[] {
  const live = useLiveModels();
  return useMemo(() => filterAllModels(live), [live]);
}

export function useLiveProviderGroups(): Array<{ id: string; label: string; models: Array<{ label: string; value: string }> }> {
  const live = useLiveModels();
  return useMemo(() => {
    const groups: Array<{ id: string; label: string; models: Array<{ label: string; value: string }> }> =
      PROVIDER_GROUPS.map(g => ({
        id: g.id,
        label: g.label,
        models: g.models.map(m => ({ label: m.label as string, value: m.value as string })),
      }));
    if (!live) return groups;
    for (const group of groups) {
      const list = live[group.id];
      if (!list) continue; // unverifiable provider — keep curated
      group.models = group.models.filter(m => list.includes(m.value));
      for (const id of list) {
        if (!group.models.some(m => m.value === id)) {
          group.models.push({ label: id, value: id });
        }
      }
    }
    return groups;
  }, [live]);
}

// ── Helpers — encode/decode provider:model composite keys ────────────────────

export const toKey = (provider: string, model: string) => `${provider}:${model}`;

export const fromKey = (key: string) => {
  const i = key.indexOf(':');
  return { provider: key.slice(0, i), model: key.slice(i + 1) };
};

// ── Safe URL hostname parser ─────────────────────────────────────────────────

export const safeHostname = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};
