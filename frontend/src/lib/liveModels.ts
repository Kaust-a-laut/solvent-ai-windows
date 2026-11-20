import { useSyncExternalStore } from 'react';
import { API_BASE_URL } from './config';

/**
 * Live model catalog, fetched once per app load from /api/v1/models (public
 * endpoint, backed by the backend's model registry which refreshes daily).
 *
 * Semantics mirror the backend registry: a provider missing from the response
 * is *unverifiable*, so curated entries for it are kept. A provider that IS
 * present positively defines its catalog — curated entries absent from it are
 * retired and get filtered out of pickers.
 */

export type LiveModelMap = Record<string, string[]>;

let liveModels: LiveModelMap | null = null;
let fetchStarted = false;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

async function fetchLiveModels(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE_URL}/models`);
    if (!res.ok) return;
    const data = await res.json() as LiveModelMap;
    if (data && typeof data === 'object') {
      liveModels = data;
      notify();
    }
  } catch {
    // Backend unreachable — pickers keep their curated lists.
  }
}

function ensureFetch() {
  if (!fetchStarted) {
    fetchStarted = true;
    void fetchLiveModels();
  }
}

export function getLiveModels(): LiveModelMap | null {
  ensureFetch();
  return liveModels;
}

/** False only when the provider's catalog is known AND the model is absent. */
export function isModelLive(provider: string, model: string): boolean {
  const list = liveModels?.[provider];
  if (!list) return true;
  return list.includes(model);
}

export function subscribeLiveModels(listener: () => void): () => void {
  ensureFetch();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React subscription to the live catalog (null until the fetch lands). */
export function useLiveModels(): LiveModelMap | null {
  return useSyncExternalStore(subscribeLiveModels, getLiveModels, () => null);
}
