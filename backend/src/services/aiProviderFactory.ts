import { pluginManager } from './pluginManager';
import { IProviderPlugin } from '../types/plugins';

/**
 * Provider configuration for OpenAI-compatible providers.
 * Used for documentation and centralized configuration.
 */
export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKeyEnvVar: string;
  defaultModel: string;
}

/**
 * Configuration map for OpenAI-compatible providers.
 * Centralized provider configuration to reduce duplication.
 */
export const OPENAI_COMPATIBLE_PROVIDERS: Record<string, ProviderConfig> = {
  groq: {
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnvVar: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile'
  },
  deepseek: {
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v4-flash'
  },
  openrouter: {
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free'
  },
  dashscope: {
    name: 'dashscope',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKeyEnvVar: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen3-coder-plus'
  },
  cerebras: {
    name: 'cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnvVar: 'CEREBRAS_API_KEY',
    defaultModel: 'gpt-oss-120b'
  },
  fireworks: {
    name: 'fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnvVar: 'FIREWORKS_API_KEY',
    defaultModel: 'accounts/fireworks/models/kimi-k2p6'
  },
};

export class AIProviderFactory {
  static async getProvider(name: string, options?: { allowFallback?: boolean }): Promise<IProviderPlugin> {
    if (options?.allowFallback === false) {
      return pluginManager.getExactProvider(name);
    }
    return pluginManager.resolveProvider(name);
  }

  /**
   * Strict lookup without silent cross-provider fallback — prevents pairing
   * provider-specific model IDs / API keys with an unrelated fallback provider.
   */
  static async getExactProvider(name: string): Promise<IProviderPlugin> {
    return pluginManager.getExactProvider(name);
  }

  static async getAllProviders() {
    return pluginManager.getAllProviders();
  }
}
