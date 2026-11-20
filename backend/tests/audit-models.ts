/**
 * Audit hardcoded model IDs against each provider's LIVE model list.
 *
 * Usage: npx tsx tests/audit-models.ts
 *
 * Imports the canonical catalog from src/constants/models.ts and reports,
 * per provider, every hardcoded ID the provider no longer serves — plus
 * close-match suggestions from the live list so replacements are easy.
 */
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

import { MODELS, CONTEXT_LIMITS, WATERFALL_PRESETS, WATERFALL_CONFIG } from '../src/constants/models';

type LiveLists = Record<string, Set<string> | null>;

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function getLiveLists(): Promise<LiveLists> {
  const lists: LiveLists = {};

  const tasks: Array<[string, () => Promise<Set<string>>]> = [
    ['groq', async () => {
      const key = process.env.GROQ_API_KEY;
      if (!key) throw new Error('no key');
      const d = await fetchJson('https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${key}` }) as { data: Array<{ id: string }> };
      return new Set(d.data.map(m => m.id));
    }],
    ['dashscope', async () => {
      const key = process.env.DASHSCOPE_API_KEY;
      if (!key) throw new Error('no key');
      const d = await fetchJson('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models', { Authorization: `Bearer ${key}` }).catch(() =>
        fetchJson('https://dashscope.aliyuncs.com/compatible-mode/v1/models', { Authorization: `Bearer ${key}` })
      ) as { data: Array<{ id: string }> };
      return new Set(d.data.map(m => m.id));
    }],
    ['fireworks', async () => {
      const key = process.env.FIREWORKS_API_KEY;
      if (!key) throw new Error('no key');
      const d = await fetchJson('https://api.fireworks.ai/inference/v1/models', { Authorization: `Bearer ${key}` }) as { data: Array<{ id: string }> };
      return new Set(d.data.map(m => m.id));
    }],
    ['cerebras', async () => {
      const key = process.env.CEREBRAS_API_KEY;
      if (!key) throw new Error('no key');
      const d = await fetchJson('https://api.cerebras.ai/v1/models', { Authorization: `Bearer ${key}` }) as { data: Array<{ id: string }> };
      return new Set(d.data.map(m => m.id));
    }],
    ['deepseek', async () => {
      const key = process.env.DEEPSEEK_API_KEY;
      if (!key) throw new Error('no key');
      const d = await fetchJson('https://api.deepseek.com/models', { Authorization: `Bearer ${key}` }) as { data: Array<{ id: string }> };
      return new Set(d.data.map(m => m.id));
    }],
    ['openrouter', async () => {
      const d = await fetchJson('https://openrouter.ai/api/v1/models') as { data: Array<{ id: string }> };
      // OpenRouter lists base ids; ':free' variants exist when pricing is 0 —
      // include both base and explicit :free spelling for matching.
      const ids = new Set<string>();
      for (const m of d.data) {
        ids.add(m.id);
        if (m.id.endsWith(':free')) ids.add(m.id.replace(/:free$/, ''));
      }
      return ids;
    }],
    ['gemini', async () => {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error('no key');
      const d = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`) as { models: Array<{ name: string }> };
      return new Set(d.models.map(m => m.name.replace(/^models\//, '')));
    }],
  ];

  await Promise.all(tasks.map(async ([name, fn]) => {
    try {
      lists[name] = await fn();
    } catch (e) {
      lists[name] = null;
      console.log(`!! ${name}: list fetch failed (${e instanceof Error ? e.message : e}) — skipping`);
    }
  }));

  return lists;
}

// Collect every hardcoded (provider, model) pair from the canonical catalog.
function collectHardcoded(): Map<string, Set<string>> {
  const byProvider = new Map<string, Set<string>>();
  const add = (provider: string, model: string) => {
    if (!byProvider.has(provider)) byProvider.set(provider, new Set());
    byProvider.get(provider)!.add(model);
  };

  Object.values(MODELS.GEMINI).forEach(m => add('gemini', m));
  Object.values(MODELS.GROQ).forEach(m => add('groq', m));
  MODELS.GROQ_MODELS.forEach(m => add('groq', m));
  Object.values(MODELS.DASHSCOPE).forEach(m => add('dashscope', m));
  MODELS.DASHSCOPE_MODELS.forEach(m => add('dashscope', m));
  Object.values(MODELS.OPENROUTER).forEach(m => add('openrouter', m));
  MODELS.OPENROUTER_FREE.forEach(m => add('openrouter', m));
  add('fireworks', MODELS.FIREWORKS_DEFAULT);
  add('cerebras', MODELS.CEREBRAS_DEFAULT);
  add('deepseek', MODELS.DEEPSEEK_DEFAULT);
  MODELS.FALLBACK_CHAIN.forEach(f => add(f.provider, f.model));

  for (const preset of Object.values(WATERFALL_PRESETS)) {
    for (const sel of Object.values(preset.selection)) {
      if (typeof sel === 'object') add(sel.provider, sel.model);
    }
  }
  for (const phase of Object.values(WATERFALL_CONFIG)) {
    add(phase.OPTION_A.provider, phase.OPTION_A.model);
    add(phase.OPTION_B.provider, phase.OPTION_B.model);
  }

  // CONTEXT_LIMITS keys, mapped to provider by shape
  for (const id of Object.keys(CONTEXT_LIMITS)) {
    if (id === 'default') continue;
    if (id.startsWith('accounts/')) add('fireworks', id);
    else if (id.includes(':cloud')) add('ollama-cloud', id); // before gemini- (gemini-3-flash-preview:cloud is an Ollama id)
    else if (id.startsWith('gemini-')) add('gemini', id);
    else if (id.includes('/')) add('openrouter-or-groq', id);
  }

  return byProvider;
}

function closeMatches(id: string, live: Set<string>): string[] {
  const stem = id.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2 && !['free', 'instruct', 'models', 'accounts', 'fireworks', 'meta', 'llama'].includes(w));
  const scored: Array<[string, number]> = [];
  for (const cand of live) {
    const lc = cand.toLowerCase();
    let score = 0;
    for (const w of stem) if (lc.includes(w)) score++;
    if (score > 0) scored.push([cand, score]);
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c);
}

async function main() {
  console.log('Fetching live model lists...\n');
  const live = await getLiveLists();
  const hardcoded = collectHardcoded();

  for (const [provider, ids] of hardcoded) {
    const liveSet = live[provider];
    if (liveSet === undefined) {
      console.log(`\n== ${provider}: no live list source (${ids.size} hardcoded ids unchecked)`);
      continue;
    }
    if (liveSet === null) {
      console.log(`\n== ${provider}: scan failed (${ids.size} hardcoded ids unchecked)`);
      continue;
    }
    const missing = [...ids].filter(id => !liveSet.has(id));
    console.log(`\n== ${provider}: ${ids.size} hardcoded, ${liveSet.size} live, ${missing.length} MISSING`);
    for (const id of missing) {
      const sugg = closeMatches(id, liveSet);
      console.log(`   ✗ ${id}${sugg.length ? `   → closest live: ${sugg.join(' | ')}` : ''}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
