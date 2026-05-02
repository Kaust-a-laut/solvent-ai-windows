import { Router } from 'express';
import { z } from 'zod';
import { settingsService } from '../services/settingsService';
import { handleRouteError } from '../utils/routeErrors';

const router = Router();

const providerConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  defaultModel: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).optional(),
}).strict();

const settingsUpdateSchema = z.object({
  providers: z.record(providerConfigSchema).optional(),
  defaultProvider: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  imageProvider: z.string().min(1).optional(),
  globalProvider: z.enum(['cloud', 'local', 'auto']).optional(),
}).strict();

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

// Update settings
router.post('/', async (req, res) => {
  try {
    const parsed = settingsUpdateSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const settings = await settingsService.updateSettings(parsed.data);
    res.json(settings);
  } catch (error) {
    handleRouteError({ res, error, context: 'settings-update' });
  }
});

// Get provider configuration. Returns the redacted shape (hasApiKey instead of
// apiKey) — the frontend stores keys client-side, so the backend never needs
// to echo them back. Auth-required already, but redaction is defense-in-depth.
router.get('/providers/:providerId', async (req, res) => {
  try {
    const { providerId } = req.params;
    const config = await settingsService.getPublicProviderConfig(providerId);
    if (!config) {
      return res.status(404).json({ error: 'Provider not found' });
    }
    res.json(config);
  } catch (error) {
    handleRouteError({ res, error, context: 'settings-provider-get' });
  }
});

// Update provider configuration
router.post('/providers/:providerId', async (req, res) => {
  try {
    const { providerId } = req.params;
    const parsed = providerConfigSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const config = await settingsService.updateProviderConfig(providerId, parsed.data);
    res.json(config);
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
    const { apiKey } = req.body;
    
    if (!apiKey) {
      return res.status(400).json({ error: 'API key is required' });
    }
    
    const isValid = await settingsService.validateProviderApiKey(providerId, apiKey);
    res.json({ valid: isValid });
  } catch (error) {
    handleRouteError({ res, error, context: 'settings-validate-key' });
  }
});

export default router;
