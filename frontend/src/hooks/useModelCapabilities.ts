import { useAppStore } from '../store/useAppStore';
import { AGENT_MODEL_OPTIONS, type ModelOption } from '../components/ModelSelector';

export type ModelTier = 'full-agentic' | 'code-only';

export interface AgentModelTraits {
  toolUse: 'strong' | 'basic';
  multimodal: boolean;
  contextWindow: number;
}

export interface AgentModel extends Omit<ModelOption, 'sublabel' | 'color' | 'bgColor' | 'icon'> {
  tier: ModelTier;
  traits: AgentModelTraits;
}

export function useModelCapabilities() {
  const selectedModel = useAppStore((s) => s.selectedCloudModel);
  const selectedProvider = useAppStore((s) => s.selectedCloudProvider);

  const activeModel = AGENT_MODEL_OPTIONS.find(
    (m) => m.model === selectedModel && m.provider === selectedProvider
  );

  const tier = getModelTier(activeModel);
  const traits = getModelTraits(activeModel);

  return {
    canUseRuntimeTools: tier === 'full-agentic',
    canUseScreenshots: traits.multimodal === true,
    canUseClickToEdit: tier === 'full-agentic',
    tier,
    traits,
    activeModel: activeModel ?? null,
  };
}

export function getModelTier(model: ModelOption | undefined): ModelTier {
  if (!model) return 'code-only';
  // GLM-4.7 and GLM-5 excluded — tool-use reliability is not production-grade for agentic work
  const fullAgentic = [
    'accounts/fireworks/models/kimi-k2p6',
    'accounts/fireworks/models/kimi-k2p5',
    'google/gemini-2.5-flash',
    'google/gemini-2.5-pro',
    'qwen3-coder-plus',
    'anthropic/claude-sonnet-4',
    'openai/gpt-4o',
    'qwen3.6-plus',
    'groq/compound',
    'groq/compound-mini',
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'deepseek-chat',
    'qwen3-coder-flash',
  ];
  return fullAgentic.includes(model.model) ? 'full-agentic' : 'code-only';
}

function getModelTraits(model: ModelOption | undefined): AgentModelTraits {
  if (!model) return { toolUse: 'basic', multimodal: false, contextWindow: 8192 };

  const multimodalModels = [
    'anthropic/claude-sonnet-4',
    'openai/gpt-4o',
    'accounts/fireworks/models/kimi-k2p6',
    'accounts/fireworks/models/kimi-k2p5',
    'qwen3.6-plus',
    'google/gemini-2.5-flash',
    'google/gemini-2.5-pro',
  ];

  return {
    toolUse: getModelTier(model) === 'full-agentic' ? 'strong' : 'basic',
    multimodal: multimodalModels.includes(model.model),
    contextWindow: getContextWindow(model.model),
  };
}

function getContextWindow(modelId: string): number {
  const limits: Record<string, number> = {
    'anthropic/claude-sonnet-4': 200000,
    'openai/gpt-4o': 128000,
    'accounts/fireworks/models/kimi-k2p6': 262144,
    'accounts/fireworks/models/kimi-k2p5': 262144,
    'google/gemini-2.5-flash': 1048576,
    'google/gemini-2.5-pro': 2000000,
    'qwen3-coder-plus': 131072,
    'accounts/fireworks/models/glm-5p1': 202800,
    'qwen3.6-plus': 131072,
    'groq/compound': 128000,
    'groq/compound-mini': 128000,
    'deepseek-v4-flash': 1000000,
    'deepseek-v4-pro': 1000000,
    'deepseek-chat': 1000000,
    'qwen3-coder-flash': 131072,
    'qwen/qwen3-32b': 131072,
    'gpt-oss-120b': 131072,
    'qwen3-next-80b-a3b-instruct': 131072,
    'llama-3.3-70b-versatile': 128000,
    'openai/gpt-oss-120b': 131072,
    'openai/gpt-oss-20b': 131072,
  };
  return limits[modelId] ?? 8192;
}
