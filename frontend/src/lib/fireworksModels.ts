// Fireworks AI models
// OpenAI-compatible API — fast inference for open models

export const FIREWORKS_CHAT_MODELS = [
  // Frontier
  { label: 'Kimi K2.6',              value: 'accounts/fireworks/models/kimi-k2p6' },
  { label: 'Kimi K2.5',              value: 'accounts/fireworks/models/kimi-k2p5' },
  { label: 'GLM-5.1',                value: 'accounts/fireworks/models/glm-5p1' },
  { label: 'GLM-5',                  value: 'accounts/fireworks/models/glm-5' },
  { label: 'DeepSeek V3.2',          value: 'accounts/fireworks/models/deepseek-v3p2' },
  { label: 'DeepSeek V3.1',          value: 'accounts/fireworks/models/deepseek-v3p1' },
  { label: 'DeepSeek V4 Pro',        value: 'accounts/deepseek-ai/models/deepseek-v4-pro' },
  { label: 'GPT-OSS 120B',           value: 'accounts/fireworks/models/gpt-oss-120b' },
  { label: 'GPT-OSS 20B',            value: 'accounts/fireworks/models/gpt-oss-20b' },
  { label: 'MiniMax M2.7',           value: 'accounts/fireworks/models/minimax-m2p7' },
  { label: 'MiniMax M2.5',           value: 'accounts/fireworks/models/minimax-m2p5' },
  // Qwen
  { label: 'Qwen 3.6 Plus',          value: 'accounts/fireworks/models/qwen3p6-plus' },
  { label: 'Qwen3 235B',             value: 'accounts/fireworks/models/qwen3-235b-a22b' },
  { label: 'Qwen3 Coder 480B',       value: 'accounts/fireworks/models/qwen3-coder-480b-a35b-instruct' },
  // Llama
  { label: 'Llama 3.3 70B',          value: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
] as const;

export const FIREWORKS_ALL_MODELS = FIREWORKS_CHAT_MODELS.map(m => ({
  provider: 'fireworks' as const,
  model: m.value,
  label: m.label,
  group: 'Fireworks' as const,
}));
