const isBrowser = typeof window !== 'undefined';
const isElectron = isBrowser && /Electron/i.test(navigator.userAgent);

// In Electron with file://, window.location.hostname is empty. Default to localhost.
const host = (isBrowser && window.location.hostname && window.location.hostname !== '')
  ? window.location.hostname
  : 'localhost';

// Keep BASE_URL relative in browser contexts so fetches hit /api/... on the
// current origin and get proxied by Vite. In the Native Bridge dogfooding loop
// the copy's .env.local sets VITE_BACKEND_URL, which Vite's server.proxy reads
// at dev-server start — so the proxy target changes without the browser ever
// making a cross-origin request. Overriding BASE_URL here would bypass that
// proxy and trigger CORS.
export const BASE_URL = isElectron ? `http://${host}:3001` : '';
export const API_BASE_URL = `${BASE_URL}/api/v1`;

/**
 * Centralized Application Configuration
 * Resolves "Hardcoded Values" and "Configuration Management" observations.
 */
export const APP_CONFIG = {
  models: {
    cloud: {
      primary: 'llama-3.3-70b-versatile',
      fallback: 'gemini-1.5-flash',
      reasoning: 'llama-3.3-70b-versatile',
      vision: 'gemini-1.5-flash'
    },
    local: {
      primary: 'qwen2.5:3b',
      reasoning: 'deepseek-r1:8b',
      vision: 'llama3.2-vision'
    }
  },
  providers: {
    primary: 'groq' as const,
    fallback: 'gemini' as const,
    local: 'ollama' as const
  },
  modeConfigs: {
    chat: { provider: 'auto', model: 'llama-3.3-70b-versatile' },
    vision: { provider: 'gemini', model: 'gemini-1.5-flash' },
    coding: { provider: 'auto', model: 'llama-3.3-70b-versatile' },
    deep_thought: { provider: 'auto', model: 'llama-3.3-70b-versatile' },
    browser: { provider: 'gemini', model: 'gemini-1.5-flash' },
    waterfall: { provider: 'auto', model: 'llama-3.3-70b-versatile' },
    model_playground: { provider: 'auto', model: 'llama-3.3-70b-versatile' },
  },
  defaults: {
    temperature: 0.7,
    maxTokens: 4096,
    imageProvider: 'pollinations' as const
  }
};