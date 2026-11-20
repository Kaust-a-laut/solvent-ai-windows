// Shared OpenRouter free model definitions.
// Single source of truth — imported by ChatHeader, CompareArea, and DebateArea.

export const OPENROUTER_FREE_CHAT_MODELS = [
  // OpenAI open-weight
  { label: 'GPT-OSS 120B (Free)',         value: 'openai/gpt-oss-120b:free' },
  { label: 'GPT-OSS 20B (Free)',          value: 'openai/gpt-oss-20b:free' },
  // Meta
  { label: 'Llama 3.3 70B (Free)',        value: 'meta-llama/llama-3.3-70b-instruct:free' },
  { label: 'Llama 3.2 3B (Free)',         value: 'meta-llama/llama-3.2-3b-instruct:free' },
  // Qwen
  { label: 'Qwen3 Coder (Free)',          value: 'qwen/qwen3-coder:free' },
  { label: 'Qwen3 Next 80B (Free)',       value: 'qwen/qwen3-next-80b-a3b-instruct:free' },
  // Nvidia Nemotron
  { label: 'Nemotron 3 Super 120B (Free)', value: 'nvidia/nemotron-3-super-120b-a12b:free' },
  { label: 'Nemotron 3 Nano 30B (Free)',   value: 'nvidia/nemotron-3-nano-30b-a3b:free' },
  { label: 'Nemotron Nano 9B v2 (Free)',   value: 'nvidia/nemotron-nano-9b-v2:free' },
  // Google Gemma
  { label: 'Gemma 4 26B (Free)',          value: 'google/gemma-4-26b-a4b-it:free' },
  { label: 'Gemma 4 31B (Free)',          value: 'google/gemma-4-31b-it:free' },
  // Z.ai
  // MiniMax
  // NousResearch
  { label: 'Hermes 3 405B (Free)',        value: 'nousresearch/hermes-3-llama-3.1-405b:free' },
] as const;

// For CompareArea / DebateArea ALL_MODELS format
export const OPENROUTER_FREE_ALL_MODELS = OPENROUTER_FREE_CHAT_MODELS.map(m => ({
  provider: 'openrouter' as const,
  model: m.value,
  label: m.label,
  group: 'OpenRouter Free' as const,
}));
