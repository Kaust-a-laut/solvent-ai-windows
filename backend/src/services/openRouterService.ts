import { BaseOpenAIService } from './baseOpenAIService';
import { config } from '../config';

export class OpenRouterService extends BaseOpenAIService {
  readonly name = 'openrouter';
  protected baseUrl = 'https://openrouter.ai/api/v1';
  protected apiKey = config.OPENROUTER_API_KEY || '';
  public defaultModel = 'meta-llama/llama-3.3-70b-instruct:free';

  protected getExtraHeaders() {
    return {
      'HTTP-Referer': 'https://github.com/solvent-ai',
      'X-Title': 'Solvent AI Desktop',
    };
  }
}
