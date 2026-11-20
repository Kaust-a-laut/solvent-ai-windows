import { AIProviderFactory } from './aiProviderFactory';
import { logger } from '../utils/logger';

export interface DebateRound {
  model: string;
  role: string;
  content: string;
  turnNumber: number;
}

export interface DebateResult {
  topic: string;
  rounds: DebateRound[];
  consensus: string;
}

export interface ModelSelection {
  provider: string;
  model: string;
}

const DEFAULT_PROPONENT: ModelSelection = { provider: 'gemini', model: 'gemini-3.1-pro-preview' };
const DEFAULT_CRITIC: ModelSelection = { provider: 'groq', model: 'llama-3.3-70b-versatile' };

export class DebateService {
  /**
   * 4-turn back-and-forth debate followed by neutral synthesis.
   * Each turn uses a context-first system prompt so the model responds to
   * what was just said rather than re-anchoring to the original topic.
   */
  async conductDebate(
    topic: string,
    proponentModel: ModelSelection = DEFAULT_PROPONENT,
    criticModel: ModelSelection = DEFAULT_CRITIC
  ): Promise<DebateResult> {
    const rounds: DebateRound[] = [];
    const pro = proponentModel;
    const crit = criticModel;
    const opts = { temperature: 0.7, maxTokens: 2048, shouldSearch: false };

    logger.info(
      `[DebateService] Starting 4-turn debate on: "${topic}" | ` +
      `Proponent: ${pro.provider}/${pro.model} | Critic: ${crit.provider}/${crit.model}`
    );

    const proProvider = await AIProviderFactory.getExactProvider(pro.provider);
    const critProvider = await AIProviderFactory.getExactProvider(crit.provider);

    // Turn 1: Proponent opens
    const turn1 = await proProvider.complete([
      {
        role: 'system',
        content:
          `You are a debater arguing FOR the following position. ` +
          `Make a focused, decisive opening argument with 2–3 specific claims. ` +
          `Be direct and take a clear stance. Do not hedge.`
      },
      { role: 'user', content: `Debate topic: ${topic}` }
    ], { ...opts, model: pro.model });
    rounds.push({ model: pro.model, role: 'proponent', content: turn1, turnNumber: 1 });

    // Turn 2: Critic responds to Turn 1
    const turn2 = await critProvider.complete([
      {
        role: 'system',
        content:
          `You are a debater arguing AGAINST the position: "${topic}".\n\n` +
          `Your opponent just made this specific argument:\n\n` +
          `"${turn1}"\n\n` +
          `Respond DIRECTLY to the specific claims they just made. ` +
          `Do NOT re-introduce the topic from scratch — engage with what they actually said. ` +
          `Challenge their evidence, logic, and assumptions point by point.`
      },
      { role: 'user', content: `Debate topic: ${topic}` }
    ], { ...opts, model: crit.model });
    rounds.push({ model: crit.model, role: 'critic', content: turn2, turnNumber: 2 });

    // Turn 3: Proponent rebuts Turn 2
    const turn3 = await proProvider.complete([
      {
        role: 'system',
        content:
          `You are continuing a debate where you are arguing FOR: "${topic}".\n\n` +
          `Your opponent just countered your argument with:\n\n` +
          `"${turn2}"\n\n` +
          `Respond DIRECTLY to their specific objections. ` +
          `Defend your original claims point by point. ` +
          `Do NOT re-argue from scratch — address what they said.`
      },
      { role: 'user', content: `Debate topic: ${topic}` }
    ], { ...opts, model: pro.model });
    rounds.push({ model: pro.model, role: 'proponent_rebuttal', content: turn3, turnNumber: 3 });

    // Turn 4: Critic's final counterargument
    const turn4 = await critProvider.complete([
      {
        role: 'system',
        content:
          `This is your final argument in a debate where you are arguing AGAINST: "${topic}".\n\n` +
          `The proponent just rebutted your position with:\n\n` +
          `"${turn3}"\n\n` +
          `Address their specific rebuttals directly. ` +
          `Deliver your strongest closing argument — be incisive and precise.`
      },
      { role: 'user', content: `Debate topic: ${topic}` }
    ], { ...opts, model: crit.model });
    rounds.push({ model: crit.model, role: 'critic_rebuttal', content: turn4, turnNumber: 4 });

    // Final: Neutral synthesis
    const synthesis = await proProvider.complete([
      {
        role: 'system',
        content:
          `You are a neutral moderator who has observed a full 4-turn debate on: "${topic}". ` +
          `Do not take sides. Identify the 2–3 strongest arguments from each side and ` +
          `synthesize a balanced conclusion that captures the core tension and any common ground.`
      },
      {
        role: 'user',
        content:
          `Proponent's opening:\n${turn1}\n\n` +
          `Critic's response:\n${turn2}\n\n` +
          `Proponent's rebuttal:\n${turn3}\n\n` +
          `Critic's final argument:\n${turn4}\n\n` +
          `Synthesize a balanced conclusion.`
      }
    ], { ...opts, model: pro.model });
    rounds.push({ model: pro.model, role: 'synthesizer', content: synthesis, turnNumber: 5 });

    return {
      topic,
      rounds,
      consensus: synthesis
    };
  }
}

export const debateService = new DebateService();
