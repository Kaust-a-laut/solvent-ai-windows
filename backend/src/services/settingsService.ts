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
  private saveChain: Promise<void> = Promise.resolve();
  private validationLocks = new Map<string, Promise<void>>();

  private getSettingsPath(pathMod: typeof import('path')): string {
    if (process.env.SOLVENT_DATA_DIR) {
      return pathMod.resolve(process.env.SOLVENT_DATA_DIR, 'settings.json');
    }
    return pathMod.resolve(__dirname, '../../', SettingsService.SETTINGS_FILE);
  }

  async initialize(): Promise<void> {
    await this.loadSettings();
  }

  async loadSettings(): Promise<Settings> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      const settingsPath = this.getSettingsPath(path);
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

    return this.cloneSettings(this.settings!);
  }

  private cloneSettings(s: Settings): Settings {
    return {
      ...s,
      providers: Object.fromEntries(
        Object.entries(s.providers).map(([k, v]) => [k, { ...v }])
      ),
    };
  }

  async saveSettings(): Promise<void> {
    if (!this.settings) {
      throw new Error('Settings not initialized');
    }

    const snapshot = JSON.stringify(this.settings, null, 2);
    const writeOp = async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const { randomUUID } = await import('node:crypto');

      const settingsPath = this.getSettingsPath(path);
      const tempPath = `${settingsPath}.tmp.${Date.now()}.${randomUUID()}`;
      try {
        await fs.writeFile(tempPath, snapshot, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(tempPath, settingsPath);
      } catch (error) {
        await fs.unlink(tempPath).catch(() => {});
        logger.error('[SettingsService] Error saving settings:', error);
        throw error;
      }
    };

    const next = this.saveChain.then(writeOp, writeOp);
    this.saveChain = next.catch(() => {});
    return next;
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
    return this.cloneSettings(this.settings!);
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

    // Merge the new settings with existing ones, blocking prototype keys
    const { providers, ...rest } = newSettings;
    const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
    this.settings = {
      ...this.settings!,
      ...rest,
      providers: providers
        ? {
            ...this.settings!.providers,
            ...Object.fromEntries(
              Object.entries(providers)
                .filter(([id]) => !forbidden.has(id))
                .map(([id, config]) => {
                  const prev: ProviderConfig = Object.prototype.hasOwnProperty.call(this.settings!.providers, id) && this.settings!.providers[id]
                    ? this.settings!.providers[id]!
                    : { enabled: true };
                  const merged: ProviderConfig = {
                    ...prev,
                    ...config,
                    enabled: config.enabled ?? prev.enabled,
                  };
                  return [id, merged] as const;
                })
            )
          }
        : this.settings!.providers
    };

    await this.saveSettings();
    return this.cloneSettings(this.settings!);
  }

  async getProviderConfig(providerId: string): Promise<ProviderConfig | null> {
    if (!this.settings) {
      await this.loadSettings();
    }

    if (!Object.prototype.hasOwnProperty.call(this.settings!.providers, providerId)) {
      return null;
    }
    const cfg = this.settings!.providers[providerId];
    return cfg ? { ...cfg } : null;
  }

  async updateProviderConfig(providerId: string, config: Partial<ProviderConfig>): Promise<ProviderConfig> {
    if (providerId === '__proto__' || providerId === 'constructor' || providerId === 'prototype') {
      throw new Error(`Invalid provider ID: ${providerId}`);
    }
    if (!this.settings) {
      await this.loadSettings();
    }

    const existingConfig = Object.prototype.hasOwnProperty.call(this.settings!.providers, providerId)
      ? this.settings!.providers[providerId]!
      : { enabled: true };
    const merged = { ...existingConfig, ...config };
    this.settings!.providers[providerId] = merged;

    await this.saveSettings();
    return { ...merged };
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

    // Ollama cloud: key is stored and used when :cloud models are called — skip completion test
    if (providerId === 'ollama') {
      return apiKey.trim().length > 0;
    }

    // Prefer non-mutating per-call apiKey validation whenever the provider
    // implements complete(). This avoids racing or leaking the test key onto
    // the shared live provider singleton used by concurrent requests.
    if (provider.complete) {
      try {
        const testMessages = [{ role: 'user' as const, content: 'hi' }];
        await provider.complete(testMessages, {
          model: provider.defaultModel || '',
          maxTokens: 1,
          apiKey,
        });
        return true;
      } catch (error: unknown) {
        const err = error as { message?: string };
        logger.error(`[SettingsService] API key validation failed for ${providerId}: ${err?.message || String(error)}`);
        return false;
      }
    }

    // Non-chat providers (no complete()): serialize initialization checks per provider
    // and restore the full prior config (including baseUrl/defaultModel) in finally.
    const prevLock = this.validationLocks.get(providerId) ?? Promise.resolve();
    let releaseLock!: () => void;
    const myLock = new Promise<void>(resolve => { releaseLock = resolve; });
    this.validationLocks.set(providerId, prevLock.then(() => myLock));
    await prevLock;

    const originalConfig = await this.getProviderConfig(providerId);
    try {
      if (provider.initialize) {
        await provider.initialize({ ...originalConfig, apiKey });
      }
      return provider.isReady();
    } catch (error: unknown) {
      const err = error as { message?: string };
      logger.error(`[SettingsService] API key validation failed for ${providerId}: ${err?.message || String(error)}`);
      return false;
    } finally {
      if (provider.initialize) {
        try {
          await provider.initialize(originalConfig ? { ...originalConfig } : {});
        } catch (restoreError) {
          logger.error(`[SettingsService] Failed to restore provider ${providerId} after key validation`, restoreError);
        }
      }
      releaseLock();
    }
  }
}

export const settingsService = new SettingsService();
