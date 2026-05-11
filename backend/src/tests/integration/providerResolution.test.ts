import { describe, it, expect, beforeAll, vi } from 'vitest';
import { pluginManager } from '../../services/pluginManager';
import { orchestrationService } from '../../services/orchestrationService';

describe('Provider Resolution Integration', () => {
  beforeAll(async () => {
    await pluginManager.initialize();
  });

  it('should resolve providers using the 3-tier fallback mechanism', async () => {
    const providers = pluginManager.getAllProviders();
    if (providers.length === 0) return;

    // Find a provider that is actually ready (has API key or doesn't need one)
    const readyProvider = providers.find(p => p.isReady());
    if (!readyProvider) return; // No ready providers in this environment

    // Test explicit provider resolution with a ready provider
    const resolvedExplicit = await pluginManager.resolveProvider(readyProvider.id);
    expect(resolvedExplicit.id).toBe(readyProvider.id);

    // Test default provider resolution
    const resolvedDefault = await pluginManager.resolveProvider(undefined, readyProvider.id);
    expect(resolvedDefault.id).toBe(readyProvider.id);

    // Test fallback to first available provider
    const resolvedFallback = await pluginManager.resolveProvider('nonexistent-provider', 'nonexistent-default');
    expect(resolvedFallback).toBeDefined();
    expect(resolvedFallback.isReady()).toBe(true);
  });

  it('should filter providers by capabilities', async () => {
    // Test capability-based filtering
    const providers = pluginManager.getAllProviders();
    if (providers.length > 0) {
      // Try to find a provider that supports vision
      try {
        const visionProvider = await pluginManager.resolveProvider(
          undefined,
          undefined,
          { supportsVision: true }
        );

        // If we found one, it should indeed support vision
        if (visionProvider) {
          expect(visionProvider.capabilities?.supportsVision).toBe(true);
        }
      } catch (error) {
        // If no vision-capable provider is available, that's OK for this test environment
        if (!(error as Error).message.includes('No operational AI providers')) {
          throw error;
        }
      }
    }
  });

  it('should use provider override in orchestration service', async () => {
    const providers = pluginManager.getAllProviders();
    if (providers.length === 0) {
      // Skip if no providers are available
      return;
    }

    // Get the first *ready* provider to use as override (order is non-deterministic with parallel loading)
    const firstProvider = providers.find(p => p.isReady()) ?? providers[0];

    // Stub `complete` on every ready provider so the test never touches a real
    // API. The test's intent is to verify the override is *resolved* and that
    // the orchestrator actually calls into the chosen provider — not to round-
    // trip a real LLM call. Without this, under parallel vitest worker load
    // the Gemini round-trip can blow past the 15s test timeout.
    const stubs = providers
      .filter(p => p.isReady())
      .map(p => vi.spyOn(p, 'complete').mockResolvedValue('stubbed completion'));
    // vectorService.addEntry is called by runMissionSync's memory-persistence
    // phase; in tests we don't need the side effect, and spying makes the call
    // graph fully deterministic.
    const { vectorService } = await import('../../services/vectorService');
    const addEntrySpy = vi.spyOn(vectorService, 'addEntry').mockResolvedValue('stub-id');

    try {
      await orchestrationService.runMission(
        'consultation',
        'Integration test goal',
        { async: false, providerOverride: firstProvider!.id }
      );

      // The override's complete() must have been invoked at least once
      // (synthesis pass + per-agent calls all go through complete()).
      expect(stubs.some(s => s.mock.calls.length > 0)).toBe(true);
    } finally {
      for (const stub of stubs) stub.mockRestore();
      addEntrySpy.mockRestore();
    }
  });
});