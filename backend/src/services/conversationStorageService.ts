import { randomUUID } from 'node:crypto';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger';
import { AtomicFileSystem } from '../utils/fileSystem';
import { Message } from '../types/frontend';

export interface StoredSession {
  id: string;
  mode: string;
  title: string;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  parentMessageId?: string;
  parentSessionId?: string;
  metadata: {
    modelsUsed: string[];
    messageCount: number;
    tokenEstimate: number;
    tags: string[];
  };
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'model';
  content: string;
  model?: string;
  image?: string | null;
  thinking?: string;
  isGeneratedImage?: boolean;
  imageUrl?: string;
  timestamp: number;
}

const DEFAULT_SESSIONS_DIR = path.resolve(__dirname, '../../../.solvent_sessions');

export interface ConversationStorageOptions {
  baseDir?: string;
}

/**
 * What index.json stores per session: metadata only. Embedding full
 * `messages[]` (including base64 images) for every session made the index
 * grow without bound and be rewritten in full on every save.
 */
export type SessionSummary = Omit<StoredSession, 'messages'> & {
  /** First ~200 chars of the first text message, for list/search previews. */
  preview?: string;
};

/** A session summary as returned by search, with the matched message attached (text only). */
export type SessionSearchHit = SessionSummary & { messages: Array<Pick<StoredMessage, 'id' | 'role' | 'content' | 'timestamp'>> };

const PREVIEW_CHARS = 200;

function toSummary(session: StoredSession | (SessionSummary & { messages?: unknown })): SessionSummary {
  const { messages, ...rest } = session as StoredSession & { preview?: string };
  const msgs = Array.isArray(messages) ? (messages as StoredMessage[]) : [];
  const firstText = msgs.find(m => typeof m?.content === 'string' && m.content.trim().length > 0);
  return {
    ...rest,
    metadata: {
      modelsUsed: rest.metadata?.modelsUsed ?? [],
      tokenEstimate: rest.metadata?.tokenEstimate ?? 0,
      tags: rest.metadata?.tags ?? [],
      messageCount: rest.metadata?.messageCount ?? msgs.length,
    },
    preview: firstText ? firstText.content.slice(0, PREVIEW_CHARS) : rest.preview,
  };
}

export class ConversationStorageService {
  private readonly sessionsDir: string;
  private readonly indexFile: string;
  private readonly directoryReady: Promise<void>;
  // Serializes every read-modify-write of session files and index.json —
  // concurrent saves used to interleave and drop each other's index entries.
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(options: ConversationStorageOptions = {}) {
    this.sessionsDir = options.baseDir
      ? path.resolve(options.baseDir)
      : (process.env.SOLVENT_SESSIONS_DIR
        ? path.resolve(process.env.SOLVENT_SESSIONS_DIR)
        : DEFAULT_SESSIONS_DIR);
    this.indexFile = path.join(this.sessionsDir, 'index.json');
    this.directoryReady = this.ensureStorageDirectory();
  }

  private async ensureStorageDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
      logger.info(`[ConversationStorage] Session directory ready: ${this.sessionsDir}`);
    } catch (error) {
      logger.error('[ConversationStorage] Failed to create session directory', error);
    }
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private getSessionFilePath(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      throw new Error('Invalid session ID');
    }
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  /**
   * Save a session to disk
   */
  async saveSession(session: StoredSession): Promise<void> {
    await this.directoryReady;
    return this.withLock(async () => {
      try {
        const filePath = this.getSessionFilePath(session.id);

        // Check for concurrent modification
        try {
          const existingData = await fs.readFile(filePath, 'utf-8');
          let existing: { updatedAt?: number } | null = null;
          try {
            existing = JSON.parse(existingData);
          } catch {
            // A corrupt file must not wedge the session forever — overwrite it.
            logger.warn(`[ConversationStorage] Existing session file ${session.id} is corrupt — overwriting`);
          }
          if (existing && typeof existing.updatedAt === 'number' && existing.updatedAt > session.updatedAt) {
            logger.warn('[ConversationStorage] Concurrent modification detected, skipping save');
            return; // Skip save - newer version exists
          }
        } catch (e: unknown) {
          const err = e as NodeJS.ErrnoException;
          if (err.code !== 'ENOENT') throw e; // File doesn't exist is OK
        }

        await AtomicFileSystem.writeJson(filePath, session);
        await this.updateIndex(session);
        logger.debug(`[ConversationStorage] Saved session ${session.id}`);
      } catch (error) {
        logger.error('[ConversationStorage] Failed to save session', error);
        throw error;
      }
    });
  }

  /**
   * Load a session from disk
   */
  async loadSession(sessionId: string): Promise<StoredSession | null> {
    try {
      const filePath = this.getSessionFilePath(sessionId);
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data);
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        logger.warn(`[ConversationStorage] Session ${sessionId} not found`);
        return null;
      }
      logger.error('[ConversationStorage] Failed to load session', error);
      throw error;
    }
  }

  private async readIndex(): Promise<SessionSummary[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.indexFile, 'utf-8');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn('[ConversationStorage] index.json is corrupt — treating as empty');
      return [];
    }
    // Older index files embedded full messages[] — strip them on read.
    return Array.isArray(parsed)
      ? parsed.filter((s): s is StoredSession => !!s && typeof s === 'object' && typeof (s as StoredSession).id === 'string').map(toSummary)
      : [];
  }

  /**
   * List all sessions (summaries, newest first), optionally filtered by mode
   */
  async listSessions(mode?: string): Promise<SessionSummary[]> {
    try {
      const index = await this.readIndex();
      const filtered = mode ? index.filter(s => s.mode === mode) : index;
      // Always newest first — the mode-filtered path used to skip sorting.
      return filtered.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    } catch (error: unknown) {
      logger.error('[ConversationStorage] Failed to list sessions', error);
      throw error;
    }
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    return this.withLock(async () => {
      try {
        const filePath = this.getSessionFilePath(sessionId);
        await fs.unlink(filePath);
        await this.removeFromIndex(sessionId);
        logger.info(`[ConversationStorage] Deleted session ${sessionId}`);
      } catch (error: unknown) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          await this.removeFromIndex(sessionId);
          return;
        }
        logger.error('[ConversationStorage] Failed to delete session', error);
        throw error;
      }
    });
  }

  /**
   * Search across all sessions for a query (message content, plus titles
   * when `includeTitles` is set). Loads each session file since the index
   * no longer carries message bodies.
   */
  async findSessions(query: string, options: { limit?: number; mode?: string; includeTitles?: boolean } = {}): Promise<SessionSearchHit[]> {
    const limit = options.limit ?? 20;
    const queryLower = String(query ?? '').toLowerCase();
    if (!queryLower) return [];
    const hits: SessionSearchHit[] = [];
    for (const summary of await this.listSessions(options.mode)) {
      if (hits.length >= limit) break;
      let session: StoredSession | null = null;
      try {
        session = await this.loadSession(summary.id);
      } catch {
        continue; // corrupt / unreadable session file
      }
      const match = (session?.messages ?? []).find(
        m => typeof m?.content === 'string' && m.content.toLowerCase().includes(queryLower)
      );
      if (match) {
        hits.push({ ...summary, messages: [{ id: match.id, role: match.role, content: match.content, timestamp: match.timestamp }] });
      } else if (options.includeTitles && typeof summary.title === 'string' && summary.title.toLowerCase().includes(queryLower)) {
        const first = (session?.messages ?? []).find(m => typeof m?.content === 'string');
        hits.push({ ...summary, messages: first ? [{ id: first.id, role: first.role, content: first.content, timestamp: first.timestamp }] : [] });
      }
    }
    return hits;
  }

  /**
   * Search across all sessions for a query
   */
  async searchSessions(query: string, limit: number = 20): Promise<{ session: SessionSummary, match: StoredMessage }[]> {
    try {
      const hits = await this.findSessions(query, { limit });
      return hits.map(({ messages, ...session }) => ({ session, match: messages[0] as StoredMessage }));
    } catch (error) {
      logger.error('[ConversationStorage] Search failed', error);
      return [];
    }
  }

  /**
   * Generate a title from the first message
   */
  generateTitle(firstMessage: string): string {
    const truncated = firstMessage.slice(0, 50);
    return truncated + (firstMessage.length > 50 ? '...' : '');
  }

  /**
   * Convert frontend Message[] to StoredMessage[]
   */
  toStoredMessages(messages: Message[]): StoredMessage[] {
    return messages.map(m => ({
      id: m.id || randomUUID(),
      role: m.role,
      content: m.content,
      model: m.model,
      image: m.image,
      thinking: m.thinking,
      isGeneratedImage: m.isGeneratedImage,
      imageUrl: m.imageUrl,
      // Preserve the frontend's own creation time when it sent one (so a
      // message's displayed time doesn't jump to "now" every time the
      // session is re-saved); only stamp Date.now() for messages that never
      // had one (e.g. older sessions saved before this field existed).
      timestamp: m.createdAt ?? Date.now()
    }));
  }

  /**
   * Convert StoredMessage[] to frontend Message[]
   */
  toFrontendMessages(messages: StoredMessage[]): Message[] {
    return messages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      model: m.model,
      image: m.image,
      thinking: m.thinking,
      isGeneratedImage: m.isGeneratedImage,
      imageUrl: m.imageUrl,
      createdAt: m.timestamp
    }));
  }

  /**
   * Update the session index (caller holds the write lock)
   */
  private async updateIndex(session: StoredSession): Promise<void> {
    try {
      const index = await this.readIndex();
      const summary = toSummary(session);
      const existingIndex = index.findIndex(s => s.id === session.id);
      if (existingIndex >= 0) {
        index[existingIndex] = summary;
      } else {
        index.push(summary);
      }
      await AtomicFileSystem.writeJson(this.indexFile, index);
    } catch (error) {
      logger.error('[ConversationStorage] Index update failed', error);
    }
  }

  /**
   * Remove a session from the index (caller holds the write lock)
   */
  private async removeFromIndex(sessionId: string): Promise<void> {
    try {
      const index = await this.readIndex();
      const filtered = index.filter(s => s.id !== sessionId);
      if (filtered.length !== index.length) {
        await AtomicFileSystem.writeJson(this.indexFile, filtered);
      }
    } catch (error: unknown) {
      logger.error('[ConversationStorage] Index removal failed', error);
    }
  }
}
