import { Router } from 'express';
import { z } from 'zod';
import { settingsService, Settings, ProviderConfig, PublicSettings, PublicProviderConfig } from '../services/settingsService';
import { handleRouteError } from '../utils/routeErrors';

const router = Router();

const PROVIDER_ID_RE = /^[a-z0-9_-]{1,64}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isValidProviderId(id: string): boolean {
  return PROVIDER_ID_RE.test(id) && !FORBIDDEN_KEYS.has(id);
}

const safeHttpUrlSchema = z.string().url().refine((raw) => {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}, { message: 'baseUrl must use http:// or https://' });

const providerConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: safeHttpUrlSchema.optional(),
  defaultModel: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).optional(),
}).strict();

const settingsUpdateSchema = z.object({
  providers: z.record(z.string().refine(isValidProviderId, 'Invalid provider ID'), providerConfigSchema).optional(),
  defaultProvider: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  imageProvider: z.string().min(1).optional(),
  globalProvider: z.enum(['cloud', 'local', 'auto']).optional(),
}).strict();

const validateKeySchema = z.object({
  apiKey: z.string().trim().min(1, 'API key is required').max(512),
}).strict();

function redactProvider(cfg: ProviderConfig): PublicProviderConfig {
  return {
    enabled: cfg.enabled,
    priority: cfg.priority,
    defaultModel: cfg.defaultModel,
    hasApiKey: typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0,
    hasBaseUrl: typeof cfg.baseUrl === 'string' && cfg.baseUrl.length > 0,
  };
}

function redactSettings(settings: Settings): PublicSettings {
  const providers: Record<string, PublicProviderConfig> = {};
  for (const [id, cfg] of Object.entries(settings.providers || {})) {
    providers[id] = redactProvider(cfg);
  }
  return {
    providers,
    defaultProvider: settings.defaultProvider,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    imageProvider: settings.imageProvider,
    globalProvider: settings.globalProvider,
  };
}

function validationError(res: import('express').Response, error: z.ZodError) {
  return res.status(400).json({
    error: 'Invalid request body',
    details: error.errors.map(issue => ({ path: issue.path, message: issue.message })),
  });
}

// Get all settings (public — apiKey/baseUrl values redacted to hasApiKey/hasBaseUrl
// booleans; this endpoint is auth-exempt in server.ts so we never return secrets).
router.get('/', async (_req, res) => {
  try {
    const settings = await settingsService.getPublicSettings();
    res.json(settings);
  } catch (error) {
    handleRouteError({ res, error, context: 'settings-get' });
  }
});

// Update settings — always returns redacted PublicSettings so plaintext secrets are never echoed
router.post('/', async (req, res) => {
  try {
    const parsed = settingsUpdateSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const updated = await settingsService.updateSettings(parsed.data);
    res.json(redactSettings(updated));
  } catch (error) {
    handleRouteError({ res, error, context: 'settings-update' });
  }
});

// Get provider configuration (redacted)
router.get('/providers/:providerId', async (req, res) => {
  try {
    const { providerId } = req.params;
    if (!isValidProviderId(providerId)) {
      return res.status(400).json({ error: 'Invalid provider ID' });
    }
    const config = await settingsService.getPublicProviderConfig(providerId);
    if (!config) {
      return res.status(404).json({ error: 'Provider not found' });
    }
    res.json(config);
  } catch (error) {
    handleRouteError({ res, error, context: 'settings-provider-get' });
  }
});

// Update provider configuration (returns redacted PublicProviderConfig)
router.post('/providers/:providerId', async (req, res) => {
  try {
    const { providerId } = req.params;
    if (!isValidProviderId(providerId)) {
      return res.status(400).json({ error: 'Invalid provider ID' });
    }
    const parsed = providerConfigSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const updated = await settingsService.updateProviderConfig(providerId, parsed.data);
    res.json(redactProvider(updated));
  } catch (error) {
    handleRouteError({ res, error, context: 'settings-provider-update' });
  }
});

// Get all available providers
router.get('/providers', async (_req, res) => {
  try {
    const providers = await settingsService.getAvailableProviders();
    res.json(providers.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      version: p.version,
      defaultModel: p.defaultModel,
      capabilities: p.capabilities,
      isReady: p.isReady()
    })));
  } catch (error) {
    handleRouteError({ res, error, context: 'settings-providers-list' });
  }
});

// Get provider capabilities
router.get('/providers/:providerId/capabilities', async (req, res) => {
  try {
    const { providerId } = req.params;
    if (!isValidProviderId(providerId)) {
      return res.status(400).json({ error: 'Invalid provider ID' });
    }
    const capabilities = await settingsService.getProviderCapabilities(providerId);
    res.json(capabilities);
  } catch (error) {
    handleRouteError({ res, error, context: 'settings-provider-capabilities' });
  }
});

// Validate provider API key
router.post('/providers/:providerId/validate-key', async (req, res) => {
  try {
    const { providerId } = req.params;
    if (!isValidProviderId(providerId)) {
      return res.status(400).json({ error: 'Invalid provider ID' });
    }
    const parsed = validateKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'API key is required' });
    }

    const isValid = await settingsService.validateProviderApiKey(providerId, parsed.data.apiKey);
    res.json({ valid: isValid });
  } catch (error) {
    handleRouteError({ res, error, context: 'settings-validate-key' });
  }
});

export default router;
