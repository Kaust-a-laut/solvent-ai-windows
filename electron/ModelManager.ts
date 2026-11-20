import Store from 'electron-store';
import { BrowserWindow } from 'electron';

const store = new Store();

let secretGetter: () => string | null = () => process.env.BACKEND_INTERNAL_SECRET ?? null;
let cachedDevSecret: string | null = null;

async function resolveBackendSecret(): Promise<string> {
  const fromProvider = secretGetter();
  if (fromProvider) return fromProvider;
  if (cachedDevSecret) return cachedDevSecret;

  // Dev fallback: fetch secret from localhost backend (same mechanism as renderer)
  try {
    const res = await fetch('http://127.0.0.1:3001/dev-secret', {
      headers: { Origin: 'http://localhost:5173' }
    });
    if (res.ok) {
      const data = await res.json() as { secret?: string };
      if (data.secret) {
        cachedDevSecret = data.secret;
        return cachedDevSecret;
      }
    }
  } catch {
    // Backend may still be booting — let caller see the 401/connection error
  }
  return '';
}

function broadcastModelStatus(payload: { status: string; model: string }) {
  BrowserWindow.getAllWindows().forEach(w => {
    if (!w.isDestroyed()) {
      w.webContents.send('model-status', payload);
    }
  });
}

// Helper to calculate cost (rough estimation)
const calculateCost = (model: string, tokens: number) => {
  // Mock pricing logic
  if (model.includes('free') || model.includes('ollama')) return 0;
  if (model.includes('gpt-4') || model.includes('opus')) return (tokens / 1000) * 0.03;
  return (tokens / 1000) * 0.001; // Default cheap
};

const API = {
  call: async (modelStr: string, messages: any[]) => {
    // Parse provider/model from string "provider/model" — split on the FIRST
    // slash only so multi-slash IDs like "openrouter/anthropic/claude-3-opus"
    // keep the full downstream model slug ("anthropic/claude-3-opus").
    let provider = 'gemini';
    let modelName = modelStr;

    const firstSlash = modelStr.indexOf('/');
    if (firstSlash !== -1) {
      provider = modelStr.slice(0, firstSlash);
      modelName = modelStr.slice(firstSlash + 1);
    } else if (modelStr.startsWith('gpt') || modelStr.startsWith('o1')) {
      provider = 'openrouter'; // Assume openrouter for openai models if not specified
    }

    // Adjust provider for backend compatibility
    if (provider === 'local') provider = 'ollama';

    const payload = {
      provider,
      model: modelName,
      messages,
      smartRouter: false // We are doing the routing here
    };

    const secret = await resolveBackendSecret();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (secret) {
      headers['x-solvent-secret'] = secret;
    }

    // Use built-in fetch (Node 18+)
    const response = await fetch('http://127.0.0.1:3001/api/v1/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const error: any = new Error(`API Error: ${response.statusText}`);
        error.status = response.status;
        // Try to parse body for more info
        try {
            const errBody = await response.json();
            if (errBody.error) error.message = errBody.error;
        } catch {
            // Body not parseable — continue with default error message
        }
        throw error;
    }

    const data = await response.json();
    
    // Track usage (Mocking token count if not provided)
    const usage = (data.usage?.totalTokens || 100);
    ModelManager.trackUsage(modelStr, usage);

    return data;
  }
};

export const ModelManager = {
  setSecretProvider: (getter: () => string | null) => {
    secretGetter = getter;
    cachedDevSecret = null;
  },

  // 1. Persistent Storage for Preferences
  getPreference: (tier: 'planner' | 'executor') => {
    return store.get(`model_prefs.${tier}`, {
      primary: tier === 'planner' ? 'openrouter/anthropic/claude-3-opus' : 'openrouter/google/gemini-2.0-flash-exp:free',
      fallback: 'ollama/llama3',
      autoShift: true
    }) as any;
  },

  setPreference: (tier: 'planner' | 'executor', prefs: any) => {
    store.set(`model_prefs.${tier}`, prefs);
  },

  // 2. The Execution Engine with Built-in Fallback
  execute: async (tier: 'planner' | 'executor', messages: any[]) => {
    const pref = ModelManager.getPreference(tier);
    
    try {
      // Primary Attempt
      console.log(`[ModelManager] Executing ${tier} with primary: ${pref.primary}`);
      const result = await API.call(pref.primary, messages);
      // Broadcast success (primary)
      broadcastModelStatus({ status: 'primary', model: pref.primary });
      return result;
    } catch (err: any) {
      if (pref.autoShift && ModelManager.isRecoverable(err)) {
        console.warn(`[ModelManager] Primary ${pref.primary} failed. Shifting to ${pref.fallback}`);
        // Broadcast failover
        broadcastModelStatus({ status: 'fallback', model: pref.fallback });
        return await API.call(pref.fallback, messages);
      }
      throw err;
    }
  },

  isRecoverable: (err: any) => {
    // 429 = Rate Limit, 503/504 = Service Down; Node undici fetch puts ECONNREFUSED on err.cause.code
    const code = err?.code ?? err?.cause?.code;
    return [429, 503, 504].includes(err?.status) || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT';
  },

  // 3. Usage Tracking
  trackUsage: (model: string, tokens: number) => {
      const current = store.get('usage', { tokens: 0, cost: 0, requests: 0 }) as any;
      const cost = calculateCost(model, tokens);
      
      store.set('usage', {
          tokens: current.tokens + tokens,
          cost: current.cost + cost,
          requests: current.requests + 1
      });
  },

  getUsage: () => {
      return store.get('usage', { tokens: 0, cost: 0, requests: 0 });
  },
  
  // Reset usage (e.g. for "Top Up" simulation or daily reset)
  resetUsage: () => {
      store.set('usage', { tokens: 0, cost: 0, requests: 0 });
  }
};
