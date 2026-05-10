// Thinking model classifications.
// Used by ChatService (routing) and ChatInput (brain icon behavior).

// Models that ALWAYS produce reasoning traces — no toggle needed
export const THINK_ONLY_MODELS = new Set([
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
]);

// Models that CAN think but also work without — toggle-able
export const DUAL_MODE_MODELS = new Set([
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash:cloud',
  'deepseek-v4-pro:cloud',
  'cogito-2.1:671b-cloud',
  'kimi-k2.6:cloud',
  'kimi-k2.5:cloud',
  'glm-5.1:cloud',
  'deepseek-r1:8b',
  'deepseek-r1:latest',
]);

// Union — any model with thinking capability
export const NATIVE_THINKING_MODELS = new Set([
  ...THINK_ONLY_MODELS,
  ...DUAL_MODE_MODELS,
]);
