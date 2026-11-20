import { logger } from '../utils/logger';

export const MODELS = {
  GEMINI: {
    // GA ids gemini-3.1-pro / gemini-3-flash are not served yet (verified
    // 2026-06-10 via tests/audit-models.ts) — previews are the live ids.
    PRO_3_1_PREVIEW: 'gemini-3.1-pro-preview',
    FLASH_3_PREVIEW: 'gemini-3-flash-preview',
    FLASH_LITE_3_1: 'gemini-3.1-flash-lite',
    FLASH_LITE_3_1_PREVIEW: 'gemini-3.1-flash-lite-preview',
    // 2.5 family — deprecating June/July 2026; kept transitionally.
    PRO_2_5: 'gemini-2.5-pro',
    FLASH_2_5: 'gemini-2.5-flash',
    FLASH_LITE_2_5: 'gemini-2.5-flash-lite',
  },
  GROQ: {
    LLAMA_3_3_70B: 'llama-3.3-70b-versatile',
    LLAMA_3_1_8B: 'llama-3.1-8b-instant',
    GPT_OSS_120B: 'openai/gpt-oss-120b',
    GPT_OSS_20B: 'openai/gpt-oss-20b',
    COMPOUND: 'groq/compound',
    COMPOUND_MINI: 'groq/compound-mini',
  },
  GROQ_MODELS: [
    // Production
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    // Agentic systems
    'groq/compound',
    'groq/compound-mini',
    // Preview
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'qwen/qwen3-32b',
  ],
  OLLAMA: {
    QWEN_CODER: 'qwen2.5-coder:7b',
    LLAMA_3: 'llama3',
    DEEPSEEK_CODER: 'deepseek-coder-v2'
  },
  OLLAMA_CLOUD: [
    'glm-5.1:cloud',
    'glm-5:cloud',
    'kimi-k2.6:cloud',
    'kimi-k2.5:cloud',
    'deepseek-v4-pro:cloud',
    'deepseek-v4-flash:cloud',
    'qwen3.5:cloud',
    'qwen3-next:80b-cloud',
    'qwen3-coder-next:cloud',
    'nemotron-3-super:cloud',
    'nemotron-3-nano:cloud',
    'minimax-m2.7:cloud',
    'minimax-m2.5:cloud',
    'cogito-2.1:671b-cloud',
    'gemma4:cloud',
    'devstral-2:cloud',
    'gemini-3-flash-preview:cloud',
  ],
  OPENROUTER: {
    CLAUDE_SONNET_4_5: 'anthropic/claude-sonnet-4.5',
    CLAUDE_SONNET_4: 'anthropic/claude-sonnet-4',
    GPT_4O: 'openai/gpt-4o',
    QWEN3_CODER: 'qwen/qwen3-coder',
  },
  DASHSCOPE: {
    QWEN3_7_MAX: 'qwen3.7-max',
    QWEN3_7_MAX_PREVIEW: 'qwen3.7-max-preview',
    QWEN3_7_PLUS: 'qwen3.7-plus',
    QWEN3_6_MAX_PREVIEW: 'qwen3.6-max-preview',
    QWEN3_6_PLUS: 'qwen3.6-plus',
    QWEN3_6_FLASH: 'qwen3.6-flash',
    QWEN3_CODER_PLUS: 'qwen3-coder-plus',
    QWEN3_CODER_FLASH: 'qwen3-coder-flash',
    QWEN3_5_PLUS: 'qwen3.5-plus',
    QWEN3_5_FLASH: 'qwen3.5-flash',
    QWEN3_MAX: 'qwen3-max',
    QWEN_PLUS: 'qwen-plus',
    QWEN_TURBO: 'qwen-turbo',
    QWEN_FLASH: 'qwen-flash',
  },
  DASHSCOPE_MODELS: [
    // Qwen 3.7 (current flagship line)
    'qwen3.7-max',
    'qwen3.7-max-preview',
    'qwen3.7-plus',
    // Qwen 3.6
    'qwen3.6-max-preview',
    'qwen3.6-plus',
    'qwen3.6-flash',
    'qwen3.6-35b-a3b',
    // Coder
    'qwen3-coder-plus',
    'qwen3-coder-flash',
    'qwen3-coder-next',
    // Qwen 3.5
    'qwen3.5-plus',
    'qwen3.5-flash',
    'qwen3.5-397b-a17b',
    'qwen3.5-122b-a10b',
    'qwen3.5-35b-a3b',
    'qwen3.5-27b',
    // Qwen3 Max
    'qwen3-max',
    'qwen3-max-preview',
    // General purpose
    'qwen-plus',
    'qwen-turbo',
    'qwen-flash',
    // Open-weight
    'qwen3-235b-a22b',
    'qwen3-32b',
    'qwen3-14b',
    'qwen3-8b',
    'qwen3-30b-a3b',
    // Reasoning
    'qwq-plus',
    'qvq-max',
    // Vision
    'qwen-vl-max',
    'qwen-vl-plus',
    'qwen3-vl-plus',
    'qwen3-vl-flash',
    // DeepSeek via DashScope
    'deepseek-v3.2',
  ],
  FIREWORKS_DEFAULT: 'accounts/fireworks/models/kimi-k2p6',
  CEREBRAS_DEFAULT: 'gpt-oss-120b',
  DEEPSEEK_DEFAULT: 'deepseek-v4-flash',
  /**
   * Ordered fallback chain used by AIService.handleFallbacks when the user's
   * selected provider errors out. Biased toward providers that are actually
   * reliable in practice — Gemini is intentionally absent (rate-limited),
   * Fireworks/Cerebras/DashScope/DeepSeek rank above OpenRouter+Ollama.
   */
  FALLBACK_CHAIN: [
    { provider: 'groq',       model: 'llama-3.3-70b-versatile' },
    { provider: 'fireworks',  model: 'accounts/fireworks/models/kimi-k2p6' },
    { provider: 'cerebras',   model: 'gpt-oss-120b' },
    { provider: 'dashscope',  model: 'qwen3-coder-plus' },
    { provider: 'deepseek',   model: 'deepseek-v4-flash' },
    { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' },
    { provider: 'ollama',     model: 'qwen2.5-coder:7b' },
  ] as const,
  OPENROUTER_FREE: [
    // OpenAI open-weight (GPT-OSS)
    'openai/gpt-oss-120b:free',
    'openai/gpt-oss-20b:free',
    // Meta Llama
    'meta-llama/llama-3.3-70b-instruct:free',
    'meta-llama/llama-3.2-3b-instruct:free',
    // Qwen
    'qwen/qwen3-coder:free',
    'qwen/qwen3-next-80b-a3b-instruct:free',
    // Nvidia Nemotron
    'nvidia/nemotron-3-super-120b-a12b:free',
    'nvidia/nemotron-3-nano-30b-a3b:free',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'nvidia/nemotron-nano-9b-v2:free',
    // Google Gemma (gemma-3 :free variants retired — verified 2026-06-10)
    'google/gemma-4-26b-a4b-it:free',
    'google/gemma-4-31b-it:free',
    // Moonshot Kimi
    'moonshotai/kimi-k2.6:free',
    // NousResearch
    'nousresearch/hermes-3-llama-3.1-405b:free',
  ]
};

export interface WaterfallModelOption {
  model: string;
  provider: string;
  label: string;
  score: string;  // headline benchmark for display
}

export interface WaterfallPhaseConfig {
  OPTION_A: WaterfallModelOption;
  OPTION_B: WaterfallModelOption;
  LOCAL: string;
}

export interface CustomModelOverride {
  model: string;
  provider: string;
}

export type WaterfallPhaseSelection = 'A' | 'B' | CustomModelOverride;

export type WaterfallModelSelection = Record<'planner' | 'executor' | 'reviewer', WaterfallPhaseSelection>;

export interface WaterfallPreset {
  name: string;
  description: string;
  selection: WaterfallModelSelection;
}

export const WATERFALL_PRESETS: Record<string, WaterfallPreset> = {
  // --- Honest reviewer presets — based on PIPELINE_TEST_RESULTS.md ---
  'silk-road': {
    name: 'Silk Road',
    description: 'GLM-4.7 plans, Qwen 3.6 executes, GLM-5.1 reviews. All open-weight SOTA. Score: 82.',
    selection: {
      planner:  { model: 'glm-5.1:cloud', provider: 'ollama' },
      executor: { model: 'qwen3.6-plus', provider: 'dashscope' },
      reviewer: { model: 'glm-5.1:cloud', provider: 'ollama' },
    },
  },
  'best-quality': {
    name: 'Best Quality',
    description: 'GPT-OSS plans, Qwen3 Coder+ executes, Llama reviews. Score: 92.',
    selection: {
      planner:  { model: 'openai/gpt-oss-120b', provider: 'groq' },
      executor: { model: 'qwen3-coder-plus', provider: 'dashscope' },
      reviewer: { model: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter' },
    },
  },
  'kimi-duo': {
    name: 'Kimi Duo',
    description: 'Kimi K2.5 plans, Kimi K2 executes, Qwen 3.6 reviews. Score: 89.',
    selection: {
      planner:  { model: 'kimi-k2.5:cloud', provider: 'ollama' },
      executor: { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
      reviewer: { model: 'qwen3.6-plus', provider: 'dashscope' },
    },
  },
  'groq-speed': {
    name: 'Groq Speed',
    description: 'GPT-OSS plans + executes on Groq, Llama reviews. Ultra-fast all-LPU. Score: 91.',
    selection: {
      planner:  { model: 'openai/gpt-oss-120b', provider: 'groq' },
      executor: { model: 'openai/gpt-oss-120b', provider: 'groq' },
      reviewer: { model: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter' },
    },
  },
  'deepseek-kimi': {
    name: 'DeepSeek-Kimi',
    description: 'DeepSeek V3.2 plans (9 decisions), Kimi K2 executes, GLM 5.1 reviews. Score: 85.',
    selection: {
      planner:  { model: 'deepseek-v4-pro:cloud', provider: 'ollama' },
      executor: { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
      reviewer: { model: 'glm-5.1:cloud', provider: 'ollama' },
    },
  },
  'deepseek-coder': {
    name: 'DeepSeek Coder',
    description: 'Canonical patterns specialist — 87-90 on rate limiters, webhooks, OAuth, CRUD. DeepSeek V3.2 plans thoroughly (10 decisions), Qwen3 Coder+ executes, GLM 5.1 reviews strictly. Weak on exotic composition.',
    selection: {
      planner:  { model: 'deepseek-v4-pro:cloud', provider: 'ollama' },
      executor: { model: 'qwen3-coder-plus', provider: 'dashscope' },
      reviewer: { model: 'glm-5.1:cloud', provider: 'ollama' },
    },
  },
  'qwen-trinity': {
    name: 'Qwen Trinity',
    description: 'Fast & flexible — ~3-4 min, highest score on concurrency (85). Qwen 3.6 Plus plans, Qwen3 Coder+ executes, Nemotron reviews. Domain variance: weaker on streaming.',
    selection: {
      planner:  { model: 'qwen3.6-plus', provider: 'dashscope' },
      executor: { model: 'qwen3-coder-plus', provider: 'dashscope' },
      reviewer: { model: 'nemotron-3-super:cloud', provider: 'ollama' },
    },
  },
  'kimi-coder': {
    name: 'Kimi Coder',
    description: 'Universal default — most consistent (82 on both novel prompts, 90 on rate limiter, zero variance). Kimi K2.5 plans adaptively, Qwen3 Coder+ executes, Nemotron reviews. Safest pick.',
    selection: {
      planner:  { model: 'kimi-k2.5:cloud', provider: 'ollama' },
      executor: { model: 'qwen3-coder-plus', provider: 'dashscope' },
      reviewer: { model: 'nemotron-3-super:cloud', provider: 'ollama' },
    },
  },
  'reliable': {
    name: 'Reliable',
    description: 'Zero failures, generous reviewer — good for demos. Score: 97+.',
    selection: { planner: 'B', executor: 'B', reviewer: 'B' },
  },
  // --- High raw scores (generous reviewers) ---
  'gemini-review': {
    name: 'Gemini Review',
    description: 'GPT-OSS plans, Qwen3 Coder executes, Gemini reviews. Score: 98 (generous).',
    selection: {
      planner:  { model: 'openai/gpt-oss-120b', provider: 'groq' },
      executor: { model: 'qwen3-coder-plus', provider: 'dashscope' },
      reviewer: { model: 'gemini-3.1-pro-preview', provider: 'gemini' },
    },
  },
  'gpt-oss-gemma': {
    name: 'GPT-OSS + Gemma',
    description: 'GPT-OSS plans, Qwen3 Coder executes, Gemma reviews. Score: 100 (generous).',
    selection: {
      planner:  { model: 'openai/gpt-oss-120b:free', provider: 'openrouter' },
      executor: { model: 'qwen3-coder-plus', provider: 'dashscope' },
      reviewer: { model: 'google/gemma-4-26b-a4b-it:free', provider: 'openrouter' },
    },
  },
  'glm-speed': {
    name: 'GLM Speed',
    description: 'GLM-4.7 plans, Kimi K2 executes at Groq speed, GLM-5.1 reviews honestly. Score: 87.',
    selection: {
      planner:  { model: 'glm-5.1:cloud', provider: 'ollama' },
      executor: { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
      reviewer: { model: 'glm-5.1:cloud', provider: 'ollama' },
    },
  },
  'glm-kimi': {
    name: 'GLM-Kimi',
    description: 'GLM-4.7 plans, Kimi K2 executes, Qwen 3.6 reviews. Score: 93.',
    selection: {
      planner:  { model: 'glm-5.1:cloud', provider: 'ollama' },
      executor: { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
      reviewer: { model: 'qwen3.6-plus', provider: 'dashscope' },
    },
  },
  'glm-nemotron': {
    name: 'GLM-Nemotron',
    description: 'Reliable mid-tier — consistent 75-89 across all prompt types, balanced speed/quality, ~2-6 min. GLM-4.7 plans, Kimi K2 executes, Nemotron 3 Super reviews.',
    selection: {
      planner:  { model: 'glm-5.1:cloud', provider: 'ollama' },
      executor: { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
      reviewer: { model: 'nemotron-3-super:cloud', provider: 'ollama' },
    },
  },
  'ollama-ultima': {
    name: 'Ollama Ultima',
    description: 'Qwen 3.5 plans, Qwen3 Coder 480B executes. Maximum intelligence.',
    selection: {
      planner:  { model: 'qwen3.5:cloud', provider: 'ollama' },
      executor: { model: 'qwen3-coder-next:cloud', provider: 'ollama' },
      reviewer: { model: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter' },
    },
  },
  'deepseek-ultra': {
    name: 'DeepSeek Ultra',
    description: 'DeepSeek V4 Pro plans, Qwen3 Coder Next executes.',
    selection: {
      planner:  { model: 'deepseek-v4-pro:cloud', provider: 'ollama' },
      executor: { model: 'qwen3-coder-next:cloud', provider: 'ollama' },
      reviewer: { model: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter' },
    },
  },
  // --- Solo presets — single model all stages, avoids cross-provider rate limits ---
  'solo-gemini-pro': {
    name: 'Solo: Gemini 3.1 Pro',
    description: 'All stages on Gemini 3.1 Pro Preview.',
    selection: {
      planner:  { model: 'gemini-3.1-pro-preview', provider: 'gemini' },
      executor: { model: 'gemini-3.1-pro-preview', provider: 'gemini' },
      reviewer: { model: 'gemini-3.1-pro-preview', provider: 'gemini' },
    },
  },
  'solo-gemini-flash': {
    name: 'Solo: Gemini 3 Flash',
    description: 'All stages on Gemini 3 Flash.',
    selection: {
      planner:  { model: 'gemini-3-flash-preview', provider: 'gemini' },
      executor: { model: 'gemini-3-flash-preview', provider: 'gemini' },
      reviewer: { model: 'gemini-3-flash-preview', provider: 'gemini' },
    },
  },
  'solo-gpt-oss': {
    name: 'Solo: GPT-OSS 120B',
    description: 'All stages on GPT-OSS 120B via Groq.',
    selection: {
      planner:  { model: 'openai/gpt-oss-120b', provider: 'groq' },
      executor: { model: 'openai/gpt-oss-120b', provider: 'groq' },
      reviewer: { model: 'openai/gpt-oss-120b', provider: 'groq' },
    },
  },
  'solo-qwen36': {
    name: 'Solo: Qwen 3.6 Plus',
    description: 'All stages on Qwen 3.6 Plus via DashScope.',
    selection: {
      planner:  { model: 'qwen3.6-plus', provider: 'dashscope' },
      executor: { model: 'qwen3.6-plus', provider: 'dashscope' },
      reviewer: { model: 'qwen3.6-plus', provider: 'dashscope' },
    },
  },
  'solo-glm-5.1': {
    name: 'Solo: GLM-5.1',
    description: 'All stages on GLM-5.1 via Ollama Cloud.',
    selection: {
      planner:  { model: 'glm-5.1:cloud', provider: 'ollama' },
      executor: { model: 'glm-5.1:cloud', provider: 'ollama' },
      reviewer: { model: 'glm-5.1:cloud', provider: 'ollama' },
    },
  },
  'solo-kimi-k2.5': {
    name: 'Solo: Kimi K2.5',
    description: 'All stages on Kimi K2.5 via Ollama Cloud.',
    selection: {
      planner:  { model: 'kimi-k2.5:cloud', provider: 'ollama' },
      executor: { model: 'kimi-k2.5:cloud', provider: 'ollama' },
      reviewer: { model: 'kimi-k2.5:cloud', provider: 'ollama' },
    },
  },
  'solo-kimi-k2.6': {
    name: 'Solo: Kimi K2.6',
    description: 'All stages on Kimi K2.6 via Fireworks.',
    selection: {
      planner:  { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
      executor: { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
      reviewer: { model: 'accounts/fireworks/models/kimi-k2p6', provider: 'fireworks' },
    },
  },
};

export const WATERFALL_DEFAULT_SELECTION: WaterfallModelSelection = {
  planner: 'B', executor: 'B', reviewer: 'B'
};

export const WATERFALL_CONFIG: Record<string, WaterfallPhaseConfig> = {
  // Planner: requirements analysis + execution plan (needs strongest reasoning)
  PHASE_1_PLANNER: {
    OPTION_A: { model: 'qwen3.5:cloud',            provider: 'ollama',    label: 'Qwen 3.5 Cloud',   score: 'NEW'           },
    OPTION_B: { model: 'qwen3.5-plus',              provider: 'dashscope', label: 'Qwen 3.5 Plus',    score: 'reliable JSON'  },
    LOCAL: 'deepseek-r1:latest'
  },
  // Executor: plan → production-ready code (needs best code generation)
  PHASE_2_EXECUTOR: {
    OPTION_A: { model: 'qwen3-coder-next:cloud', provider: 'ollama',    label: 'Qwen3 Coder Next', score: 'NEW'           },
    OPTION_B: { model: 'qwen3-coder-plus',        provider: 'dashscope', label: 'Qwen3 Coder+',    score: 'SWE-bench 71%' },
    LOCAL: 'deepseek-r1:latest'
  },
  // Reviewer: code audit + quality scoring (needs deep analysis + structured output)
  PHASE_3_REVIEWER: {
    OPTION_A: { model: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter', label: 'Llama 3.3 70B', score: 'MMLU 86%' },
    OPTION_B: { model: 'qwen3.5-plus',              provider: 'dashscope', label: 'Qwen 3.5 Plus',    score: 'reliable JSON'  },
    LOCAL: 'deepseek-r1:latest'
  }
};

export const CONTEXT_LIMITS: Record<string, number> = {
  // Gemini: Massive Context
  'gemini-3.1-pro-preview': 1000000,
  'gemini-3-flash-preview': 1000000,
  'gemini-3.1-flash-lite': 1000000,
  'gemini-3.1-flash-lite-preview': 1000000,
  'gemini-2.5-pro': 2000000,
  'gemini-2.5-flash': 1000000,
  'gemini-2.5-flash-lite': 1000000,

  // Groq: High Context
  'llama-3.3-70b-versatile': 128000,
  'llama-3.1-8b-instant': 128000,
  'openai/gpt-oss-120b': 131072,
  'openai/gpt-oss-20b': 131072,
  'groq/compound': 128000,
  'groq/compound-mini': 128000,

  // Local/Ollama: Constrained (conservative defaults)
  'qwen2.5-coder:7b': 32768,
  'llama3': 8192,
  'deepseek-coder-v2': 16384,

  // Ollama Cloud
  'qwen3.5:cloud': 131072,
  'qwen3-next:80b-cloud': 131072,
  'qwen3-coder-next:cloud': 131072,
  'kimi-k2.6:cloud': 131072,
  'kimi-k2.5:cloud': 131072,
  'deepseek-v4-flash:cloud': 1000000,
  'deepseek-v4-pro:cloud': 1000000,
  'glm-5:cloud': 131072,
  'glm-5.1:cloud': 198000,
  'z-ai/glm-4.5-air': 131072,
  'nemotron-3-super:cloud': 131072,
  'nemotron-3-nano:cloud': 131072,
  'minimax-m2.5:cloud': 131072,
  'minimax-m2.7:cloud': 131072,
  'cogito-2.1:671b-cloud': 131072,
  'gemma4:cloud': 131072,
  'devstral-2:cloud': 131072,
  'gemini-3-flash-preview:cloud': 1000000,

  // DashScope (Qwen)
  'qwen3.7-max': 131072,
  'qwen3.7-max-preview': 131072,
  'qwen3.7-plus': 131072,
  'qwen3.6-max-preview': 131072,
  'qwen3.6-plus': 131072,
  'qwen3.6-flash': 131072,
  'qwen3.6-35b-a3b': 131072,
  'qwen3-coder-plus': 131072,
  'qwen3-coder-flash': 131072,
  'qwen3-coder-next': 131072,
  'qwen3.5-plus': 131072,
  'qwen3.5-flash': 131072,
  'qwen3.5-397b-a17b': 131072,
  'qwen3.5-122b-a10b': 131072,
  'qwen3.5-35b-a3b': 131072,
  'qwen3.5-27b': 131072,
  'qwen3-max': 131072,
  'qwen3-max-preview': 131072,
  'qwen-plus': 131072,
  'qwen-turbo': 131072,
  'qwen-flash': 131072,
  'qwen3-235b-a22b': 131072,
  'qwen3-32b': 131072,
  'qwen3-14b': 131072,
  'qwen3-8b': 131072,
  'qwen3-30b-a3b': 131072,
  'qwq-plus': 131072,
  'qvq-max': 131072,
  'qwen-vl-max': 131072,
  'qwen-vl-plus': 131072,
  'qwen3-vl-plus': 131072,
  'qwen3-vl-flash': 131072,
  'deepseek-v3.2': 131072,

  // Fireworks AI — only the ids the account actually serves
  // (verified 2026-06-10 via tests/audit-models.ts; flux-1-schnell is
  // image-gen and has no chat context limit)
  'accounts/fireworks/models/kimi-k2p6': 262144,
  'accounts/fireworks/models/kimi-k2p5': 262144,
  'accounts/fireworks/models/glm-5p1': 202800,
  'accounts/fireworks/models/deepseek-v4-pro': 1000000,
  'accounts/fireworks/models/gpt-oss-120b': 131072,

  // Cerebras
  'gpt-oss-120b': 131072,
  'zai-glm-4.7': 131072,

  // DeepSeek (direct API)
  'deepseek-v4-flash': 1000000,
  'deepseek-v4-pro': 1000000,
  'deepseek-chat': 1000000,
  'deepseek-reasoner': 1000000,

  // Default fallback
  'default': 8192
};

export const getModelContextLimit = (modelName: string): number => {
  if (!modelName) return CONTEXT_LIMITS['default'] ?? 8192;
  const limit = CONTEXT_LIMITS[modelName];
  if (limit !== undefined) return limit;
  if (modelName.includes('gemini')) return 1000000;
  if (modelName.includes('llama-3')) return 128000;
  if (modelName.includes('gpt-4')) return 128000;
  if (modelName.includes('claude-3')) return 200000;
  if (modelName.includes('qwen')) return 131072;
  
  return CONTEXT_LIMITS['default'] ?? 8192;
};

/**
 * Per-request total token limits (input + output) for models with tight quotas.
 * Groq free tier enforces these as "TPM" but they apply per-request.
 * Only models with known tight limits are listed — unlisted models have no cap.
 */
export const REQUEST_TOKEN_LIMITS: Record<string, number> = {
  'qwen/qwen3-32b':                        6000,
  'meta-llama/llama-4-scout-17b-16e-instruct': 8000,
};

/**
 * Cap maxTokens to stay within a model's per-request total token limit.
 * Returns the original maxTokens if the model has no known limit.
 */
export function capMaxTokens(model: string, inputTokenEstimate: number, requestedMaxTokens: number): number {
  const limit = REQUEST_TOKEN_LIMITS[model];
  if (!limit) return requestedMaxTokens;
  const available = Math.max(256, limit - inputTokenEstimate - 50); // 50-token safety margin
  if (available < requestedMaxTokens) {
    logger.info(`[TokenCap] ${model}: capping maxTokens from ${requestedMaxTokens} to ${available} (limit=${limit}, input~${inputTokenEstimate})`);
  }
  return Math.min(requestedMaxTokens, available);
};