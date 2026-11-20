import { Job } from 'bullmq';
import { pluginManager } from '../services/pluginManager';
import { vectorService } from '../services/vectorService';
import { logger } from '../utils/logger';
import { MissionTemplate } from '../services/orchestrationService';

export interface OrchestrationJobData {
  templateId: string;
  goal: string;
  template: MissionTemplate;
  providerOverride?: string;
  modelOverride?: string;
}

export async function orchestrationJob(job: Job<OrchestrationJobData | { type?: string; data?: OrchestrationJobData }>): Promise<unknown> {
  const raw = job.data as unknown as { data?: OrchestrationJobData } & Partial<OrchestrationJobData>;
  const payload = (raw?.data && typeof raw.data === 'object' ? raw.data : raw) as Partial<OrchestrationJobData>;
  const { templateId, goal, template, providerOverride, modelOverride } = payload;

  if (!templateId || typeof goal !== 'string' || !template || !Array.isArray(template.agents)) {
    throw new Error('Orchestration mission failed: invalid job payload');
  }

  logger.info(`[OrchestrationJob] Starting mission: ${templateId} for goal: ${goal.substring(0, 50)}...`);

  try {
    // Resolve provider dynamically
    const provider = await pluginManager.resolveProvider(providerOverride);
    const model = modelOverride || provider.defaultModel || 'default';

    logger.info(`[OrchestrationJob] Using provider: ${provider.id}, model: ${model}`);

    // Report initial progress (0-5%)
    await job.updateProgress(5);

    // Phase 1: Parallel expert analysis (5-75%)
    const agentCount = template.agents.length;
    const progressPerAgent = agentCount > 0 ? 70 / agentCount : 0;
    let completedAgents = 0;

    const expertOpinions = await Promise.all(template.agents.map(async (agent) => {
      // Per-agent provider override if specified
      const agentProvider = agent.provider
        ? await pluginManager.resolveProvider(agent.provider)
        : provider;
      const agentModel = agent.model || (agent.provider ? agentProvider.defaultModel || model : model);

      const response = await agentProvider.complete(
        [{ role: 'user', content: `GOAL: ${goal}\n\nAs the ${agent.name}, provide your professional analysis. ${agent.instruction}` }],
        { model: agentModel }
      );

      // Monotonic progress across concurrent completions
      completedAgents++;
      const currentProgress = 5 + (progressPerAgent * completedAgents);
      await job.updateProgress(Math.min(75, Math.round(currentProgress)));

      return { id: agent.id, agent: agent.name, opinion: response };
    }));

    // Phase 2: Synthesis pass (75-90%)
    await job.updateProgress(75);

    const synthesisPrompt = `I have gathered analysis from multiple experts regarding: "${goal}"

    INVARIANTS TO MAINTAIN:
    ${template.intentAssertions.map(a => `- ${a}`).join('\n')}

    EXPERT FEEDBACK:
    ${expertOpinions.map(o => `--- ${o.agent} ---\n${o.opinion}`).join('\n\n')}

    TASK:
    ${template.synthesisInstruction}

    Verify that the consensus meets all INVARIANTS.
    Output the synthesis followed by a 'VERIFICATION' section marking each invariant as PASSED or FAILED.`;

    const synthesis = await provider.complete(
      [{ role: 'user', content: synthesisPrompt }],
      { model }
    );

    await job.updateProgress(90);

    // Phase 3: Memory persistence (90-100%)
    await vectorService.addEntry(synthesis, {
      type: 'mission_synthesis',
      templateId,
      goal,
      timestamp: new Date().toISOString()
    });

    await job.updateProgress(100);

    logger.info(`[OrchestrationJob] Completed mission: ${templateId} for goal: ${goal.substring(0, 50)}...`);

    return {
      success: true,
      goal,
      expertOpinions,
      synthesis,
      completedAt: new Date().toISOString()
    };
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`[OrchestrationJob] Failed mission: ${templateId}`, error);
    throw new Error(`Orchestration mission failed: ${err.message}`);
  }
}
