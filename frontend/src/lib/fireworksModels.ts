// Fireworks AI models
// OpenAI-compatible API — fast inference for open models
// Only ids the account actually serves (verified 2026-06-10 via
// backend/tests/audit-models.ts — Fireworks retired the rest).

export const FIREWORKS_CHAT_MODELS = [
  { label: 'Kimi K2.6',       value: 'accounts/fireworks/models/kimi-k2p6' },
  { label: 'Kimi K2.5',       value: 'accounts/fireworks/models/kimi-k2p5' },
  { label: 'GLM-5.1',         value: 'accounts/fireworks/models/glm-5p1' },
  { label: 'DeepSeek V4 Pro', value: 'accounts/fireworks/models/deepseek-v4-pro' },
  { label: 'GPT-OSS 120B',    value: 'accounts/fireworks/models/gpt-oss-120b' },
] as const;

export const FIREWORKS_ALL_MODELS = FIREWORKS_CHAT_MODELS.map(m => ({
  provider: 'fireworks' as const,
  model: m.value,
  label: m.label,
  group: 'Fireworks' as const,
}));
