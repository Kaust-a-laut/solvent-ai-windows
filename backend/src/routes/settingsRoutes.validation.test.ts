import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import settingsRoutes from './settingsRoutes';
import { settingsService } from '../services/settingsService';

vi.mock('../services/settingsService', () => ({
  settingsService: {
    getSettings: vi.fn(),
    getPublicSettings: vi.fn(),
    updateSettings: vi.fn(),
    getProviderConfig: vi.fn(),
    getPublicProviderConfig: vi.fn(),
    updateProviderConfig: vi.fn(),
    getAvailableProviders: vi.fn(),
    getProviderCapabilities: vi.fn(),
    validateProviderApiKey: vi.fn(),
  },
}));

const app = express();
app.use(express.json());
app.use('/api/settings', settingsRoutes);

describe('settings route validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unknown global settings keys', async () => {
    const response = await request(app)
      .post('/api/settings')
      .send({ defaultProvider: 'gemini', unexpected: true });

    expect(response.status).toBe(400);
    expect(settingsService.updateSettings).not.toHaveBeenCalled();
  });

  it('accepts valid global settings updates', async () => {
    vi.mocked(settingsService.updateSettings).mockResolvedValue({
      providers: {},
      defaultProvider: 'gemini',
      temperature: 0.4,
      maxTokens: 2048,
      imageProvider: 'gemini',
      globalProvider: 'auto',
    });

    const response = await request(app)
      .post('/api/settings')
      .send({ temperature: 0.4, maxTokens: 2048 });

    expect(response.status).toBe(200);
    expect(settingsService.updateSettings).toHaveBeenCalledWith({ temperature: 0.4, maxTokens: 2048 });
  });

  it('rejects invalid provider config fields without echoing api keys', async () => {
    const response = await request(app)
      .post('/api/settings/providers/gemini')
      .send({ apiKey: 'very-secret-key', enabled: 'yes' });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain('very-secret-key');
    expect(settingsService.updateProviderConfig).not.toHaveBeenCalled();
  });

  it('redacts apiKey/baseUrl on the auth-exempt GET response', async () => {
    vi.mocked(settingsService.getPublicSettings).mockResolvedValue({
      providers: {
        gemini: { enabled: true, priority: 1, defaultModel: 'gemini-1.5-flash', hasApiKey: true, hasBaseUrl: false },
        groq: { enabled: false, priority: 2, hasApiKey: false, hasBaseUrl: false },
      },
      defaultProvider: 'gemini',
      temperature: 0.7,
      maxTokens: 4096,
      imageProvider: 'gemini',
      globalProvider: 'auto',
    });

    const response = await request(app).get('/api/settings');

    expect(response.status).toBe(200);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('apiKey');
    expect(body).not.toContain('baseUrl');
    expect(response.body.providers.gemini.hasApiKey).toBe(true);
    expect(response.body.providers.groq.hasApiKey).toBe(false);
  });
});
