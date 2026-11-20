import { pluginManager } from './pluginManager';
import { circuitBreaker } from './circuitBreaker';
import { IProviderPlugin } from '../types/plugins';

export interface SelectionCriteria {
  priority: 'cost' | 'performance' | 'reliability';
  excludeProviders?: string[];
  requirements: {
    minContext?: number;
    supportsVision?: boolean;
    inputTokens: number;
    outputTokens: number;
  };
}

export class ProviderSelector {
  async select(criteria: SelectionCriteria): Promise<IProviderPlugin> {
    const allProviders = pluginManager.getAllProviders();
    const excluded = new Set(criteria.excludeProviders ?? []);

    // 1. Filter by readiness, configured credentials, requirements, and read-only circuit availability
    // (avoiding side-effecting isOpen() transitions on unselected candidates)
    const available: IProviderPlugin[] = [];
    for (const p of allProviders) {
      if (excluded.has(p.id)) continue;
      if (!p.isReady()) continue;
      if (typeof p.hasConfiguredKey === 'function' && !p.hasConfiguredKey()) continue;
      if (!this.meetsRequirements(p, criteria.requirements)) continue;
      const availableNow = typeof circuitBreaker.isAvailable === 'function'
        ? await circuitBreaker.isAvailable(p.id)
        : !(await circuitBreaker.isOpen(p.id));
      if (!availableNow) continue;
      available.push(p);
    }

    if (available.length === 0) throw new Error("No healthy providers match requirements");

    // 2. Sort by Criteria
    available.sort((a, b) => {
      if (criteria.priority === 'cost') {
        return this.calculateCost(a, criteria) - this.calculateCost(b, criteria);
      }
      if (criteria.priority === 'performance') {
        return (b.capabilities?.contextWindow ?? 0) - (a.capabilities?.contextWindow ?? 0);
      }
      return 0;
    });

    // 3. Acquire circuit slot only on the chosen candidate (and fall through if another probe beat us)
    for (const candidate of available) {
      if (!(await circuitBreaker.isOpen(candidate.id))) {
        return candidate;
      }
    }

    throw new Error("No healthy providers match requirements");
  }

  private meetsRequirements(p: IProviderPlugin, reqs: { supportsVision?: boolean; minContext?: number }): boolean {
    if (!p.capabilities) return false;
    if (reqs.supportsVision && !p.capabilities.supportsVision) return false;
    if (reqs.minContext && p.capabilities.contextWindow < reqs.minContext) return false;
    return true;
  }

  private calculateCost(p: IProviderPlugin, criteria: SelectionCriteria): number {
    if (!p.capabilities) return Infinity;
    const { input, output } = p.capabilities.costPer1k;
    return (
      (criteria.requirements.inputTokens / 1000) * input +
      (criteria.requirements.outputTokens / 1000) * output
    );
  }
}

export const providerSelector = new ProviderSelector();