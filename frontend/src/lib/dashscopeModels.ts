// Shared DashScope (Qwen) model definitions.
// Single source of truth — imported by allModels.ts for ChatHeader, CompareArea, and DebateArea.

export const DASHSCOPE_CHAT_MODELS = [
  // Qwen 3.6 — latest generation
  { label: 'Qwen 3.6 Max Preview',   value: 'qwen3.6-max-preview' },
  { label: 'Qwen 3.6 Plus',          value: 'qwen3.6-plus' },
  { label: 'Qwen 3.6 Flash',         value: 'qwen3.6-flash' },
  { label: 'Qwen 3.6 35B A3B',       value: 'qwen3.6-35b-a3b' },
  // Coder models — agentic coding + tool use
  { label: 'Qwen3 Coder Plus',       value: 'qwen3-coder-plus' },
  { label: 'Qwen3 Coder Flash',      value: 'qwen3-coder-flash' },
  { label: 'Qwen3 Coder Next 80B',   value: 'qwen3-coder-next' },
  // Qwen 3.5 flagship
  { label: 'Qwen 3.5 Plus',          value: 'qwen3.5-plus' },
  { label: 'Qwen 3.5 Flash',         value: 'qwen3.5-flash' },
  { label: 'Qwen 3.5 397B A17B',     value: 'qwen3.5-397b-a17b' },
  { label: 'Qwen 3.5 122B A10B',     value: 'qwen3.5-122b-a10b' },
  { label: 'Qwen 3.5 35B A3B',       value: 'qwen3.5-35b-a3b' },
  { label: 'Qwen 3.5 27B',           value: 'qwen3.5-27b' },
  // Qwen3 Max
  { label: 'Qwen3 Max',              value: 'qwen3-max' },
  { label: 'Qwen3 Max Preview',      value: 'qwen3-max-preview' },
  // General purpose
  { label: 'Qwen Plus',              value: 'qwen-plus' },
  { label: 'Qwen Turbo',             value: 'qwen-turbo' },
  { label: 'Qwen Flash',             value: 'qwen-flash' },
  // Large open-weight MoE
  { label: 'Qwen3 235B A22B',        value: 'qwen3-235b-a22b' },
  { label: 'Qwen3 32B',              value: 'qwen3-32b' },
  { label: 'Qwen3 14B',              value: 'qwen3-14b' },
  { label: 'Qwen3 8B',               value: 'qwen3-8b' },
  { label: 'Qwen3 4B',               value: 'qwen3-4b' },
  { label: 'Qwen3 30B A3B',          value: 'qwen3-30b-a3b' },
  // Reasoning
  { label: 'QwQ Plus',               value: 'qwq-plus' },
  { label: 'QVQ Max',                value: 'qvq-max' },
  // Vision
  { label: 'Qwen VL Max',            value: 'qwen-vl-max' },
  { label: 'Qwen VL Plus',           value: 'qwen-vl-plus' },
  { label: 'Qwen3 VL Plus',          value: 'qwen3-vl-plus' },
  { label: 'Qwen3 VL Flash',         value: 'qwen3-vl-flash' },
  // DeepSeek via DashScope
  { label: 'DeepSeek V3.2',          value: 'deepseek-v3.2' },
] as const;

// For CompareArea / DebateArea ALL_MODELS format
export const DASHSCOPE_ALL_MODELS = DASHSCOPE_CHAT_MODELS.map(m => ({
  provider: 'dashscope' as const,
  model: m.value,
  label: m.label,
  group: 'DashScope (Qwen)' as const,
}));
