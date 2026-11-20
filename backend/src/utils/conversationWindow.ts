import { AIProviderFactory } from '../services/aiProviderFactory';
import { logger } from './logger';
import { estimateTokens, estimateMessagesTokens } from './tokenEstimator';
import type { ChatMessage } from '../types/ai';
import { createHash } from 'crypto';

// Number of recent message pairs to always preserve verbatim
const RECENT_PAIRS_TO_KEEP = 4;
const SUMMARY_MODEL = 'llama-3.3-70b-versatile';

// Summarizers tried in order; the first ready provider wins.
const SUMMARY_PROVIDERS: Array<{ provider: string; model: string }> = [
  { provider: 'groq', model: SUMMARY_MODEL },
  { provider: 'fireworks', model: 'accounts/fireworks/models/gpt-oss-120b' },
  { provider: 'openrouter', model: 'meta-llama/llama-3.1-8b-instruct' },
];

// Cap on the transcript sent to the summarizer — an unbounded history
// overflowed the summary model's own context and the call failed outright.
const MAX_TRANSCRIPT_CHARS = 48_000;

// In-memory cache for conversation summaries to avoid re-summarizing
const summaryCache = new Map<string, { summary: string; timestamp: number }>();
const MAX_CACHE_ENTRIES = 20;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Compute a hash for a set of messages to use as cache key. Hashes the full
 * text — keying on the first 200 chars made distinct conversations with a
 * shared prefix collide and reuse each other's summaries.
 */
function hashMessages(messages: ChatMessage[]): string {
  const hash = createHash('sha256');
  for (const m of messages) {
    hash.update(m.role);
    hash.update('\u0000');
    hash.update(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''));
    hash.update('\u0001');
  }
  return hash.digest('hex').slice(0, 32);
}

/**
 * Evict stale entries from the summary cache.
 */
function evictStaleCache() {
  const now = Date.now();
  for (const [key, entry] of summaryCache) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      summaryCache.delete(key);
    }
  }
  // LRU eviction if still over limit
  while (summaryCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = summaryCache.keys().next().value;
    if (oldestKey) summaryCache.delete(oldestKey);
  }
}

/** Keep the head and tail of an over-long transcript. */
function capTranscript(transcript: string): string {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;
  const half = Math.floor(MAX_TRANSCRIPT_CHARS / 2);
  return `${transcript.slice(0, half)}\n\n[… ${transcript.length - MAX_TRANSCRIPT_CHARS} characters omitted …]\n\n${transcript.slice(-half)}`;
}

/**
 * Summarize a block of messages into a concise summary.
 * Falls back to truncation if every summarizer fails.
 */
async function summarizeMessages(messages: ChatMessage[]): Promise<string> {
  const cacheKey = hashMessages(messages);

  // Check cache first
  const cached = summaryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.summary;
  }

  const transcript = capTranscript(
    messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')
  );
  const prompt = [
    { role: 'system' as const, content: 'You are a conversation summarizer. Produce a concise summary that preserves key decisions, questions, code references, and technical context. Omit greetings and filler.' },
    { role: 'user' as const, content: `Summarize the following conversation segment in 3-5 dense paragraphs:\n\n${transcript}` },
  ];

  let lastError = 'no summarizer provider available';
  for (const { provider: name, model } of SUMMARY_PROVIDERS) {
    try {
      const provider = await AIProviderFactory.getProvider(name);
      if (!provider.isReady()) continue;
      const summary = await provider.complete(prompt, { model, temperature: 0.1, maxTokens: 512 });
      if (!summary || !summary.trim()) continue;

      // Cache the result
      evictStaleCache();
      summaryCache.set(cacheKey, { summary, timestamp: Date.now() });
      return summary;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.debug(`[ConversationWindow] Summarizer ${name} failed: ${lastError}`);
    }
  }

  logger.warn(`[ConversationWindow] Summarization failed, falling back to truncation: ${lastError}`);
  // Fallback: take first and last message of the block
  const first = messages[0]?.content?.slice(0, 200) || '';
  const last = messages[messages.length - 1]?.content?.slice(0, 200) || '';
  return `[Earlier conversation truncated. First message: "${first}..." Last message: "${last}..."]`;
}

export interface FitResult {
  messages: ChatMessage[];
  wasTruncated: boolean;
  summarizedCount: number;
}

const summaryHeader = (count: number, truncated: boolean) =>
  `[CONVERSATION SUMMARY — ${count} earlier messages compressed${truncated ? ', truncated' : ''}]\n\n`;

/**
 * Fit a conversation into a token budget using a three-tier strategy:
 * 1. Always keep: system messages + last N message pairs
 * 2. Summarize: older messages compressed into a summary
 * 3. Truncate: drop if even the summary is too large
 */
export async function fitConversation(
  messages: ChatMessage[],
  tokenBudget: number
): Promise<FitResult> {
  // If already within budget, return as-is
  const currentTokens = estimateMessagesTokens(messages);
  if (currentTokens <= tokenBudget) {
    return { messages, wasTruncated: false, summarizedCount: 0 };
  }

  // Separate system messages from conversation messages
  const systemMessages: ChatMessage[] = [];
  const conversationMessages: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemMessages.push(msg);
    } else {
      conversationMessages.push(msg);
    }
  }

  // Always keep the most recent messages (last N pairs)
  const recentCount = Math.min(conversationMessages.length, RECENT_PAIRS_TO_KEEP * 2);
  let recentMessages = conversationMessages.slice(-recentCount);
  let olderMessages = conversationMessages.slice(0, conversationMessages.length - recentCount);

  const systemTokens = estimateMessagesTokens(systemMessages);

  // If system + recent alone exceed the budget, drop the oldest "recent"
  // messages (never the latest one) — returning them all used to send a
  // request that was still over budget.
  while (recentMessages.length > 1 && systemTokens + estimateMessagesTokens(recentMessages) > tokenBudget) {
    olderMessages = [...olderMessages, recentMessages[0]!];
    recentMessages = recentMessages.slice(1);
  }

  // If no older messages to summarize, we can only keep what fits
  if (olderMessages.length === 0) {
    // Just system + recent, can't compress further
    return {
      messages: [...systemMessages, ...recentMessages],
      wasTruncated: true,
      summarizedCount: 0
    };
  }

  // Calculate token budget available for the summary, net of the summary
  // message's own header and per-message overhead.
  const recentTokens = estimateMessagesTokens(recentMessages);
  const wrapperTokens = estimateMessagesTokens([{ role: 'system', content: summaryHeader(olderMessages.length, true) + '...' }]);
  const summaryBudget = tokenBudget - systemTokens - recentTokens - wrapperTokens;

  if (summaryBudget <= 100) {
    // No room for a summary — just keep system + recent
    return {
      messages: [...systemMessages, ...recentMessages],
      wasTruncated: true,
      summarizedCount: olderMessages.length
    };
  }

  // Summarize older messages
  const summary = await summarizeMessages(olderMessages);
  const summaryTokens = estimateTokens(summary);

  // If summary fits, insert it
  if (summaryTokens <= summaryBudget) {
    const summaryMessage: ChatMessage = {
      role: 'system',
      content: `${summaryHeader(olderMessages.length, false)}${summary}`
    };

    return {
      messages: [...systemMessages, summaryMessage, ...recentMessages],
      wasTruncated: true,
      summarizedCount: olderMessages.length
    };
  }

  // Summary is too large — truncate it to fit
  const maxSummaryChars = summaryBudget * 4; // rough inverse of token estimation
  const truncatedSummary = summary.slice(0, maxSummaryChars);
  const summaryMessage: ChatMessage = {
    role: 'system',
    content: `${summaryHeader(olderMessages.length, true)}${truncatedSummary}...`
  };

  return {
    messages: [...systemMessages, summaryMessage, ...recentMessages],
    wasTruncated: true,
    summarizedCount: olderMessages.length
  };
}
