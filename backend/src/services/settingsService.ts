import { IProviderPlugin } from '../types/plugins';
import { pluginManager } from './pluginManager';
import { logger } from '../utils/logger';

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  enabled: boolean;
  priority?: number;
}

export interface Settings {
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
  temperature: number;
  maxTokens: number;
  imageProvider: string;
  globalProvider: 'cloud' | 'local' | 'auto';
}

export type SettingsUpdate = Partial<Omit<Settings, 'providers'>> & {
  providers?: Record<string, Partial<ProviderConfig>>;
};

export interface PublicProviderConfig {
  enabled: boolean;
  priority?: number;
  defaultModel?: string;
  hasApiKey: boolean;
  hasBaseUrl: boolean;
}

export interface PublicSettings {
  providers: Record<string, PublicProviderConfig>;
  defaultProvider: string;
  temperature: number;
  maxTokens: number;
  imageProvider: string;
  globalProvider: 'cloud' | 'local' | 'auto';
}

export class SettingsService {
  private static readonly SETTINGS_FILE = './settings.json';
  private settings: Settings | null = null;

  async initialize(): Promise<void> {
    await this.loadSettings();
  }

  async loadSettings(): Promise<Settings> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      const settingsPath = path.resolve(__dirname, '../../', SettingsService.SETTINGS_FILE);
      const data = await fs.readFile(settingsPath, 'utf8');
      this.settings = JSON.parse(data);
    } catch (error) {
      // If settings file doesn't exist, create default settings
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.settings = this.getDefaultSettings();
        await this.saveSettings();
      } else {
        logger.error('[SettingsService] Error loading settings:', error);
        this.settings = this.getDefaultSettings();
      }
    }
    
    return this.settings!;
  }

  async saveSettings(): Promise<void> {
    if (!this.settings) {
      throw new Error('Settings not initialized');
    }
    
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      const settingsPath = path.resolve(__dirname, '../../', SettingsService.SETTINGS_FILE);
      await fs.writeFile(settingsPath, JSON.stringify(this.settings, null, 2), 'utf8');
    } catch (error) {
      logger.error('[SettingsService] Error saving settings:', error);
      throw error;
    }
  }

  getDefaultSettings(): Settings {
    return {
      providers: {
        gemini: { enabled: true, priority: 1 },
        groq: { enabled: true, priority: 2 },
        ollama: { enabled: true, priority: 3 },
        openrouter: { enabled: true, priority: 4 },
        huggingface: { enabled: true, priority: 5 },
        puter: { enabled: true, priority: 6 }
      },
      defaultProvider: 'gemini',
      temperature: 0.7,
      maxTokens: 4096,
      imageProvider: 'gemini',
      globalProvider: 'auto'
    };
  }

  async getSettings(): Promise<Settings> {
    if (!this.settings) {
      await this.loadSettings();
    }
    return { ...this.settings! };
  }

  private toPublicProviderConfig(providerConfig: ProviderConfig): PublicProviderConfig {
    return {
      enabled: providerConfig.enabled,
      priority: providerConfig.priority,
      defaultModel: providerConfig.defaultModel,
      hasApiKey: typeof providerConfig.apiKey === 'string' && providerConfig.apiKey.length > 0,
      hasBaseUrl: typeof providerConfig.baseUrl === 'string' && providerConfig.baseUrl.length > 0,
    };
  }

  async getPublicSettings(): Promise<PublicSettings> {
    const settings = await this.getSettings();
    const publicProviders: Record<string, PublicProviderConfig> = {};
    for (const [id, providerConfig] of Object.entries(settings.providers)) {
      publicProviders[id] = this.toPublicProviderConfig(providerConfig);
    }
    return {
      providers: publicProviders,
      defaultProvider: settings.defaultProvider,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      imageProvider: settings.imageProvider,
      globalProvider: settings.globalProvider,
    };
  }

  async getPublicProviderConfig(providerId: string): Promise<PublicProviderConfig | null> {
    const config = await this.getProviderConfig(providerId);
    if (!config) return null;
    return this.toPublicProviderConfig(config);
  }

  async updateSettings(newSettings: SettingsUpdate): Promise<Settings> {
    if (!this.settings) {
      await this.loadSettings();
    }
    
    // Merge the new settings with existing ones
    const { providers, ...rest } = newSettings;
    this.settings = {
      ...this.settings!,
      ...rest,
      providers: providers
        ? {
            ...this.settings!.providers,
            ...Object.fromEntries(
            Object.entries(providers).map(([id, config]) => [
              id,
              { ...(this.settings!.providers[id] || { enabled: true }), ...config }
            ])
            )
          }
        : this.settings!.providers
    };
    
    await this.saveSettings();
    return { ...this.settings! };
  }

  async getProviderConfig(providerId: string): Promise<ProviderConfig | null> {
    if (!this.settings) {
      await this.loadSettings();
    }
    
    return this.settings!.providers[providerId] || null;
  }

  async updateProviderConfig(providerId: string, config: Partial<ProviderConfig>): Promise<ProviderConfig> {
    if (!this.settings) {
      await this.loadSettings();
    }
    
    const existingConfig = this.settings!.providers[providerId] || { enabled: true };
    this.settings!.providers[providerId] = { ...existingConfig, ...config };
    
    await this.saveSettings();
    return this.settings!.providers[providerId];
  }

  async getAvailableProviders(): Promise<IProviderPlugin[]> {
    return pluginManager.getAllProviders();
  }

  async getProviderCapabilities(providerId: string) {
    const provider = await pluginManager.getProvider(providerId);
    if (!provider) {
      throw new Error(`Provider ${providerId} not found`);
    }
    
    return {
      id: provider.id,
      name: provider.name,
      description: provider.description,
      version: provider.version,
      defaultModel: provider.defaultModel,
      capabilities: provider.capabilities,
      isReady: provider.isReady()
    };
  }

  async validateProviderApiKey(providerId: string, apiKey: string): Promise<boolean> {
    const provider = pluginManager.getProvider(providerId);
    if (!provider) {
      throw new Error(`Provider ${providerId} not found`);
    }

    // Snapshot the previously-configured key so we can restore the singleton
    // after the test call. Without this, a successful validate-key call leaks
    // the caller's apiKey into the live provider used by every subsequent
    // request, and a failed call leaves the provider broken.
    const originalConfig = await this.getProviderConfig(providerId);
    const originalApiKey = originalConfig?.apiKey;

    try {
      if (provider.initialize) {
        await provider.initialize({ apiKey });
      }

      if (!provider.isReady()) return false;

      // For non-chat providers (serper, huggingface image), init check is enough
      if (!provider.complete) {
        return true;
      }

      // Ollama cloud: key is stored and used when :cloud models are called — skip completion test
      if (providerId === 'ollama') {
        return true;
      }

      // Make a real API call to verify the key works (1 token max)
      const testMessages = [{ role: 'user' as const, content: 'hi' }];
      await provider.complete(testMessages, {
        model: provider.defaultModel || '',
        maxTokens: 1,
        apiKey,
      });
      return true;
    } catch (error: unknown) {
      // Pass message string only — AxiosError has circular refs that crash logger.scrub()
      const err = error as { message?: string };
      logger.error(`[SettingsService] API key validation failed for ${providerId}: ${err?.message || String(error)}`);
      return false;
    } finally {
      if (provider.initialize) {
        try {
          await provider.initialize(originalApiKey ? { apiKey: originalApiKey } : {});
        } catch (restoreError) {
          logger.error(`[SettingsService] Failed to restore provider ${providerId} after key validation`, restoreError);
        }
      }
    }
  }
}

export const settingsService = new SettingsService();
