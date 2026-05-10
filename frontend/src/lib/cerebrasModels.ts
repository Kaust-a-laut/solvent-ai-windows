// Cerebras wafer-scale inference models
// Production + Preview tiers
//
// NOTE: `llama3.1-8b` and `qwen-3-235b-a22b-instruct-2507` are scheduled for
// deprecation on 2026-05-27. They remain in the list until shutdown for
// transitional access.

export const CEREBRAS_CHAT_MODELS = [
  // Production
  { label: 'GPT-OSS 120B',    value: 'gpt-oss-120b' },
  // Preview
  { label: 'Z.ai GLM 4.7',    value: 'zai-glm-4.7' },
  // Deprecating 2026-05-27
  { label: 'Llama 3.1 8B',    value: 'llama3.1-8b' },
  { label: 'Qwen3 235B',      value: 'qwen-3-235b-a22b-instruct-2507' },
] as const;

export const CEREBRAS_ALL_MODELS = CEREBRAS_CHAT_MODELS.map(m => ({
  provider: 'cerebras' as const,
  model: m.value,
  label: m.label,
  group: 'Cerebras' as const,
}));
