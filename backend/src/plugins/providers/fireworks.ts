import { IProviderPlugin, ProviderHealth } from '../../types/plugins';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { BaseOpenAIService } from '../../services/baseOpenAIService';
import { OPENAI_COMPATIBLE_PROVIDERS } from '../../services/aiProviderFactory';

export class FireworksProviderPlugin extends BaseOpenAIService implements IProviderPlugin {
  readonly name = 'Fireworks AI';
  protected baseUrl = OPENAI_COMPATIBLE_PROVIDERS.fireworks!.baseUrl;
  protected apiKey: string = '';

  id = 'fireworks';
  description = 'Fireworks AI — fast inference for open models via OpenAI-compatible API';
  version = '1.0.0';
  defaultModel = 'accounts/fireworks/models/kimi-k2p6';
  capabilities = {
    supportsVision: false,
    supportsStreaming: true,
    supportsEmbeddings: false,
    contextWindow: 131072,
    maxOutputTokens: 16384,
    supportsFunctionCalling: true,
    costPer1k: { input: 0.0002, output: 0.0006 },
  };

  private isInitialized = false;

  async initialize(options: Record<string, unknown>): Promise<void> {
    this.apiKey = (options.apiKey as string) || config.FIREWORKS_API_KEY || '';
    this.isInitialized = true;
    logger.info(`[Fireworks] Provider initialized (API key present: ${!!this.apiKey})`);
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
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return response.ok;
    } catch (error) {
      logger.error('[Fireworks] Health check failed:', error);
      return false;
    }
  }

  async getHealth(): Promise<ProviderHealth> {
    const startTime = Date.now();
    const isHealthy = await this.healthCheck();
    return { isHealthy, lastChecked: Date.now(), latency: Date.now() - startTime, errorRate: 0 };
  }
}

export default FireworksProviderPlugin;
