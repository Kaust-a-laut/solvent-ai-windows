import { IProviderPlugin, ProviderHealth } from '../../types/plugins';
import { ChatMessage, CompletionOptions } from '../../types/ai';
import { config } from '../../config';
import { BaseOpenAIService } from '../../services/baseOpenAIService';
import { OPENAI_COMPATIBLE_PROVIDERS } from '../../services/aiProviderFactory';

export class DashScopeProviderPlugin extends BaseOpenAIService implements IProviderPlugin {
  readonly name = 'dashscope';
  protected baseUrl = OPENAI_COMPATIBLE_PROVIDERS.dashscope!.baseUrl;
  protected apiKey: string = '';

  id = 'dashscope';
  description = 'Alibaba Cloud DashScope — Qwen3-Coder, Qwen3.5, Qwen-Max and more';
  version = '1.0.0';
  defaultModel = 'qwen3.6-plus';
  capabilities = {
    supportsVision: false,
    supportsStreaming: true,
    supportsEmbeddings: false,
    contextWindow: 131072,
    maxOutputTokens: 8192,
    supportsFunctionCalling: true,
    costPer1k: { input: 0.0004, output: 0.0012 }
  };

  private isInitialized = false;

  async initialize(options: Record<string, unknown>): Promise<void> {
    this.apiKey = (options.apiKey as string) || config.DASHSCOPE_API_KEY || '';
    this.isInitialized = true;
  }

  isReady(): boolean {
    return this.isInitialized;
  }

  hasConfiguredKey(): boolean {
    return this.isInitialized && !!this.apiKey;
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (!this.apiKey) return false;
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getHealth(): Promise<ProviderHealth> {
    const startTime = Date.now();
    const isHealthy = await this.healthCheck();
    return {
      isHealthy,
      lastChecked: Date.now(),
      latency: Date.now() - startTime,
      errorRate: 0
    };
  }

  // Override complete method to use BaseOpenAIService's generateChatCompletion
  // which includes the recursive tool-calling loop
  complete = async (messages: ChatMessage[], options: CompletionOptions): Promise<string> => {
    return this.generateChatCompletion(messages, options);
  };
}

export default DashScopeProviderPlugin;
