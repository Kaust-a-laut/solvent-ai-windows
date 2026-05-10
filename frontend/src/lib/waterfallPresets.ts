// Frontend-side waterfall preset definitions.
// Mirrors backend WATERFALL_PRESETS in backend/src/constants/models.ts.
// Keep in sync manually when backend presets change.

export interface PresetStageSelection {
  model: string;
  provider: string;
}

export type PresetSelection = Record<
  'planner' | 'executor' | 'reviewer',
  'A' | 'B' | PresetStageSelection
>;

export interface WaterfallPresetMeta {
  key: string;
  name: string;
  description: string;
  tagline: string;
  grade: string | null;       // Letter grade (A+ through D-). null = untested.
  speed: string;
  category: 'recommended' | 'top' | 'solo' | 'demo';
  selection: PresetSelection;
  stageLabels: Record<'planner' | 'executor' | 'reviewer', string>;
}

export const WATERFALL_PRESET_LIST: WaterfallPresetMeta[] = [
  // ── Recommended — benchmarked, highest consistency ────────────────────────
  {
    key: 'kimi-coder',
    name: 'Kimi Coder',
    description: 'Universal default — most consistent across all prompts (82 novel, 90 canonical, zero variance). Kimi K2.5 adaptive planner, Qwen3 Coder+ executes, Nemotron reviews. Safest pick.',
    tagline: 'Most consistent across all prompts',
    grade: 'A-',
    speed: '~5m+',
    category: 'recommended',
    selection: {
      planner:  { model: 'kimi-k2.5:cloud', provider: 'ollama' },
      executor: { model: 'qwen3-coder-plus', provider: 'dashscope' },
      reviewer: { model: 'nemotron-3-super:cloud', provider: 'ollama' },
    },
    stageLabels: { planner: 'Kimi K2.5', executor: 'Qwen3 Coder+', reviewer: 'Nemotron 3 Super' },
  },
  {
    key: 'qwen-trinity',
    name: 'Qwen Trinity',
    description: 'Fast & flexible — strongest on concurrency primitives (85), weakest on streaming. Qwen 3.6 Plus plans, Qwen3 Coder+ executes, Nemotron reviews.',
    tagline: 'Fastest quality preset',
    grade: 'B+',
    speed: '~2-3m',
    category: 'recommended',
    selection: {
      planner:  { model: 'qwen3.6-plus', provider: 'dashscope' },
      executor: { model: 'qwen3-coder-plus', provider: 'dashscope' },
      reviewer: { model: 'nemotron-3-super:cloud', provider: 'ollama' },
    },
    stageLabels: { planner: 'Qwen 3.6 Plus', executor: 'Qwen3 Coder+', reviewer: 'Nemotron 3 Super' },
  },
  {
    key: 'glm-nemotron',
    name: 'GLM-Nemotron',
    description: 'Reliable mid-tier — consistent 75-89 across all prompt types, balanced speed/quality. GLM-4.7 plans, Kimi K2 executes, Nemotron reviews.',
    tagline: 'Reliable across all prompt types',
    grade: 'B+',
    speed: '~2-3m',
    category: 'recommended',
    selection: {
      planner:  { model: 'glm-5.1:cloud', provider: 'ollama' },
      executor: { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
      reviewer: { model: 'nemotron-3-super:cloud', provider: 'ollama' },
    },
    stageLabels: { planner: 'GLM-5.1', executor: 'Kimi K2.6', reviewer: 'Nemotron 3 Super' },
  },
  {
    key: 'deepseek-coder',
    name: 'DeepSeek Coder',
    description: 'Canonical patterns specialist — 87-90 on rate limiters, webhooks, OAuth, CRUD. DeepSeek V3.2 plans thoroughly (10 decisions), Qwen3 Coder+ executes, GLM 5.1 reviews strictly. Avoid for exotic composition.',
    tagline: 'Best for standard patterns',
    grade: 'A-',
    speed: '~5m+',
    category: 'recommended',
    selection: {
      planner:  { model: 'deepseek-v4-pro:cloud', provider: 'ollama' },
      executor: { model: 'qwen3-coder-plus', provider: 'dashscope' },
      reviewer: { model: 'glm-5.1:cloud', provider: 'ollama' },
    },
    stageLabels: { planner: 'DeepSeek V4 Pro', executor: 'Qwen3 Coder+', reviewer: 'GLM-5.1' },
  },

  // ── Top — tested, honest reviewer ────────────────────────────────────────
  {
    key: 'silk-road',
    name: 'Silk Road',
    description: 'GLM-4.7 plans, Qwen 3.6 executes, GLM-5.1 reviews — all open-weight SOTA',
    tagline: 'All open-weight SOTA',
    grade: 'B',
    speed: '~5m+',
    category: 'top',
    selection: {
      planner:  { model: 'glm-5.1:cloud', provider: 'ollama' },
      executor: { model: 'qwen3.6-plus', provider: 'dashscope' },
      reviewer: { model: 'glm-5.1:cloud', provider: 'ollama' },
    },
    stageLabels: { planner: 'GLM-5.1', executor: 'Qwen 3.6 Plus', reviewer: 'GLM-5.1' },
  },
  {
    key: 'glm-speed',
    name: 'GLM Speed',
    description: 'GLM-4.7 plans, Kimi K2 executes at Groq speed, GLM-5.1 reviews honestly',
    tagline: 'GLM planning with Groq speed',
    grade: 'B+',
    speed: '~2-3m',
    category: 'top',
    selection: {
      planner:  { model: 'glm-5.1:cloud', provider: 'ollama' },
      executor: { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
      reviewer: { model: 'glm-5.1:cloud', provider: 'ollama' },
    },
    stageLabels: { planner: 'GLM-5.1', executor: 'Kimi K2.6', reviewer: 'GLM-5.1' },
  },
  {
    key: 'glm-kimi',
    name: 'GLM-Kimi',
    description: 'GLM-4.7 plans, Kimi K2 executes, Qwen 3.6 reviews',
    tagline: 'GLM-Kimi-Qwen trio',
    grade: 'A',
    speed: '~2-3m',
    category: 'top',
    selection: {
      planner:  { model: 'glm-5.1:cloud', provider: 'ollama' },
      executor: { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
      reviewer: { model: 'qwen3.6-plus', provider: 'dashscope' },
    },
    stageLabels: { planner: 'GLM-5.1', executor: 'Kimi K2.6', reviewer: 'Qwen 3.6 Plus' },
  },
  {
    key: 'groq-speed',
    name: 'Groq Speed',
    description: 'GPT-OSS plans, Kimi K2 executes, Llama reviews. All Groq.',
    tagline: 'Ultra-fast all-Groq',
    grade: 'A-',
    speed: '~30s',
    category: 'top',
    selection: {
      planner:  { model: 'openai/gpt-oss-120b', provider: 'groq' },
      executor: { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
      reviewer: { model: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter' },
    },
    stageLabels: { planner: 'GPT-OSS 120B', executor: 'Kimi K2.6', reviewer: 'Llama 3.3 70B' },
  },
  {
    key: 'kimi-duo',
    name: 'Kimi Duo',
    description: 'Kimi K2.5 plans, Kimi K2 executes, Qwen 3.6 reviews',
    tagline: 'Dual Kimi with Qwen review',
    grade: 'B+',
    speed: '~2-3m',
    category: 'top',
    selection: {
      planner:  { model: 'kimi-k2.5:cloud', provider: 'ollama' },
      executor: { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
      reviewer: { model: 'qwen3.6-plus', provider: 'dashscope' },
    },
    stageLabels: { planner: 'Kimi K2.5', executor: 'Kimi K2.6', reviewer: 'Qwen 3.6 Plus' },
  },
  {
    key: 'deepseek-kimi',
    name: 'DeepSeek-Kimi',
    description: 'DeepSeek V3.2 plans (9 decisions), Kimi K2 executes, GLM 5.1 reviews — max thoroughness',
    tagline: 'Max thoroughness',
    grade: 'B',
    speed: '~5m+',
    category: 'top',
    selection: {
      planner:  { model: 'deepseek-v4-pro:cloud', provider: 'ollama' },
      executor: { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
      reviewer: { model: 'glm-5.1:cloud', provider: 'ollama' },
    },
    stageLabels: { planner: 'DeepSeek V4 Pro', executor: 'Kimi K2.6', reviewer: 'GLM-5.1' },
  },
  {
    key: 'ollama-ultima',
    name: 'Ollama Ultima',
    description: 'Largest models available, prioritizes depth over speed',
    tagline: 'Largest models, max depth',
    grade: 'C+',
    speed: '~5m+',
    category: 'top',
    selection: {
      planner:  { model: 'qwen3.5:cloud', provider: 'ollama' },
      executor: { model: 'qwen3-coder-next:cloud', provider: 'ollama' },
      reviewer: { model: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter' },
    },
    stageLabels: { planner: 'Qwen 3.5', executor: 'Qwen3 Coder Next', reviewer: 'Llama 3.3 70B' },
  },

  // ── Solo tier — single model all stages, avoids cross-provider rate limits ─
  {
    key: 'solo-gemini-pro',
    name: 'Solo: Gemini 3 Pro',
    description: 'All stages on Gemini 3 Pro — single provider, no rate-limit conflicts',
    tagline: 'Gemini 3 Pro',
    grade: null,
    speed: '~1-2m',
    category: 'solo',
    selection: {
      planner:  { model: 'gemini-3.1-pro-preview', provider: 'gemini' },
      executor: { model: 'gemini-3.1-pro-preview', provider: 'gemini' },
      reviewer: { model: 'gemini-3.1-pro-preview', provider: 'gemini' },
    },
    stageLabels: { planner: 'Gemini 3 Pro', executor: 'Gemini 3 Pro', reviewer: 'Gemini 3 Pro' },
  },
  {
    key: 'solo-gemini-flash',
    name: 'Solo: Gemini 3 Flash',
    description: 'All stages on Gemini 3 Flash — fast, single provider',
    tagline: 'Gemini 3 Flash',
    grade: null,
    speed: '~30s',
    category: 'solo',
    selection: {
      planner:  { model: 'gemini-3-flash-preview', provider: 'gemini' },
      executor: { model: 'gemini-3-flash-preview', provider: 'gemini' },
      reviewer: { model: 'gemini-3-flash-preview', provider: 'gemini' },
    },
    stageLabels: { planner: 'Gemini 3 Flash', executor: 'Gemini 3 Flash', reviewer: 'Gemini 3 Flash' },
  },
  {
    key: 'solo-gpt-oss',
    name: 'Solo: GPT-OSS 120B',
    description: 'All stages on GPT-OSS 120B via Groq — ultra-fast single model',
    tagline: 'GPT-OSS via Groq',
    grade: null,
    speed: '~30s',
    category: 'solo',
    selection: {
      planner:  { model: 'openai/gpt-oss-120b', provider: 'groq' },
      executor: { model: 'openai/gpt-oss-120b', provider: 'groq' },
      reviewer: { model: 'openai/gpt-oss-120b', provider: 'groq' },
    },
    stageLabels: { planner: 'GPT-OSS 120B', executor: 'GPT-OSS 120B', reviewer: 'GPT-OSS 120B' },
  },
  {
    key: 'solo-qwen36',
    name: 'Solo: Qwen 3.6 Plus',
    description: 'All stages on Qwen 3.6 Plus via DashScope — your own key, no rate limits',
    tagline: 'Qwen 3.6 Plus',
    grade: null,
    speed: '~1-2m',
    category: 'solo',
    selection: {
      planner:  { model: 'qwen3.6-plus', provider: 'dashscope' },
      executor: { model: 'qwen3.6-plus', provider: 'dashscope' },
      reviewer: { model: 'qwen3.6-plus', provider: 'dashscope' },
    },
    stageLabels: { planner: 'Qwen 3.6 Plus', executor: 'Qwen 3.6 Plus', reviewer: 'Qwen 3.6 Plus' },
  },
  {
    key: 'solo-glm-5.1',
    name: 'Solo: GLM-5.1',
    description: 'All stages on GLM-5.1 via Ollama Cloud — strong all-rounder',
    tagline: 'GLM-5.1',
    grade: null,
    speed: '~2-3m',
    category: 'solo',
    selection: {
      planner:  { model: 'glm-5.1:cloud', provider: 'ollama' },
      executor: { model: 'glm-5.1:cloud', provider: 'ollama' },
      reviewer: { model: 'glm-5.1:cloud', provider: 'ollama' },
    },
    stageLabels: { planner: 'GLM-5.1', executor: 'GLM-5.1', reviewer: 'GLM-5.1' },
  },
  {
    key: 'solo-kimi-k2.5',
    name: 'Solo: Kimi K2.5',
    description: 'All stages on Kimi K2.5 via Ollama Cloud — deep reasoning',
    tagline: 'Kimi K2.5',
    grade: null,
    speed: '~2-3m',
    category: 'solo',
    selection: {
      planner:  { model: 'kimi-k2.5:cloud', provider: 'ollama' },
      executor: { model: 'kimi-k2.5:cloud', provider: 'ollama' },
      reviewer: { model: 'kimi-k2.5:cloud', provider: 'ollama' },
    },
    stageLabels: { planner: 'Kimi K2.5', executor: 'Kimi K2.5', reviewer: 'Kimi K2.5' },
  },
  {
    key: 'solo-kimi-k2.6',
    name: 'Solo: Kimi K2.6',
    description: 'All stages on Kimi K2.6 via Fireworks — fast execution-focused model',
    tagline: 'Kimi K2.6 via Fireworks',
    grade: null,
    speed: '~1m',
    category: 'solo',
    selection: {
      planner:  { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
      executor: { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
      reviewer: { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
    },
    stageLabels: { planner: 'Kimi K2.6', executor: 'Kimi K2.6', reviewer: 'Kimi K2.6' },
  },

  // ── Demo tier — generous reviewers, useful for demos ─────────────────────
  {
    key: 'reliable',
    name: 'Reliable',
    description: 'Tuned for zero failures and consistent output',
    tagline: 'Zero failures, consistent output',
    grade: 'A+',
    speed: '~30s',
    category: 'demo',
    selection: { planner: 'B', executor: 'B', reviewer: 'B' },
    stageLabels: { planner: 'Qwen 3.5 Plus', executor: 'Qwen3 Coder+', reviewer: 'Qwen 3.5 Plus' },
  },
];

export const WATERFALL_PRESETS_BY_KEY = Object.fromEntries(
  WATERFALL_PRESET_LIST.map(p => [p.key, p])
) as Record<string, WaterfallPresetMeta>;
