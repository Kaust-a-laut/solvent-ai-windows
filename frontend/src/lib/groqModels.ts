// Shared Groq model definitions.
// Single source of truth — imported by ChatHeader, CompareArea, and DebateArea.

export const GROQ_CHAT_MODELS = [
  // Production
  { label: 'Llama 3.3 70B',          value: 'llama-3.3-70b-versatile' },
  { label: 'Llama 3.1 8B',           value: 'llama-3.1-8b-instant' },
  { label: 'GPT OSS 120B',           value: 'openai/gpt-oss-120b' },
  { label: 'GPT OSS 20B',            value: 'openai/gpt-oss-20b' },
  // Agentic systems (auto-routing with built-in tools)
  { label: 'Groq Compound',          value: 'groq/compound' },
  { label: 'Compound Mini',          value: 'groq/compound-mini' },
  // Preview
  { label: 'Llama 4 Scout 17B',      value: 'meta-llama/llama-4-scout-17b-16e-instruct' },
  { label: 'Qwen3 32B',              value: 'qwen/qwen3-32b' },
] as const;

// For CompareArea / DebateArea ALL_MODELS format
export const GROQ_ALL_MODELS = GROQ_CHAT_MODELS.map(m => ({
  provider: 'groq' as const,
  model: m.value,
  label: m.label,
  group: 'Groq' as const,
}));
