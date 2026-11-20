import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AIController } from '../controllers/aiController';
import { BrowseController } from '../controllers/browseController';
import { CollaborateController } from '../controllers/collaborateController';
import { aiService } from '../services/aiService';
import { debateService } from '../services/debateService';
import { supervisorService } from '../services/supervisorService';
import { orchestrationService } from '../services/orchestrationService';
import { ConversationStorageService } from '../services/conversationStorageService';
import { handleRouteError } from '../utils/routeErrors';
import { logger } from '../utils/logger';
import { PROJECT_ROOT } from '../utils/fileSystem';
import { PathSecurityError, resolveSecureChildPath } from '../utils/pathSecurity';
import { fetchLinkPreview } from '../services/linkPreviewService';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(id: string): boolean {
  return UUID_REGEX.test(id);
}

function queryString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return '';
}

function parseClampedInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(queryString(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

const sessionMessageSchema = z.object({
  id: z.string().max(128).optional(),
  role: z.enum(['user', 'assistant', 'system', 'model']),
  content: z.string(),
  model: z.string().max(256).optional(),
  image: z.string().nullable().optional(),
  thinking: z.string().optional(),
  isGeneratedImage: z.boolean().optional(),
  imageUrl: z.string().optional(),
  createdAt: z.number().optional(),
  timestamp: z.number().optional(),
}).passthrough();

const createSessionSchema = z.object({
  id: z.string().regex(UUID_REGEX, 'Invalid session ID format').optional(),
  mode: z.string().min(1).max(64).default('chat'),
  title: z.string().max(500).optional(),
  messages: z.array(sessionMessageSchema).default([]),
  parentMessageId: z.string().max(128).optional(),
  parentSessionId: z.string().max(128).optional(),
  tags: z.array(z.string().max(64)).max(50).optional(),
});

const updateSessionSchema = z.object({
  title: z.string().max(500).optional(),
  messages: z.array(sessionMessageSchema).optional(),
});

const router = Router();
const storageService = new ConversationStorageService();

// ── Core Chat ──────────────────────────────────────────────────────────────
router.post('/chat', AIController.chat);
router.post('/chat/stream', AIController.chatStream);

// ── Notepad Link Preview (OG metadata) ────────────────────────────────────
const linkPreviewSchema = z.object({ url: z.string().url().max(2048) });
router.post('/notepad/link-preview', async (req, res) => {
  const parsed = linkPreviewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid url' });
  }
  try {
    const preview = await fetchLinkPreview(parsed.data.url);
    res.json(preview);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: msg });
  }
});

// ── Intent Detection (single authoritative implementation) ─────────────────
// The frontend calls this to determine routing before sending a message.
// Keeps image intent logic in one place (aiService) instead of duplicating
// the regex in the frontend's actionSlice.
const detectIntentSchema = z.object({
  message: z.string().min(1).max(50_000),
  mode: z.string().max(64).optional()
});

router.post('/detect-intent', (req, res) => {
  const parseResult = detectIntentSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parseResult.error.errors });
  }
  const { message, mode } = parseResult.data;
  const result = aiService.detectImageIntent(message, mode);
  res.json(result);
});

// ── Waterfall (SSE streaming + single-step) ───────────────────────────────
router.post('/waterfall', AIController.waterfall);
router.post('/waterfall/step', AIController.waterfallStep);

// ── Image Generation ──────────────────────────────────────────────────────
router.post('/generate-image', AIController.generateImage);

// ── Web Search ────────────────────────────────────────────────────────────
router.post('/search', AIController.search);

// ── Browse (Page Extraction + Summarization) ─────────────────────────────
router.post('/browse', BrowseController.extractContent);
router.post('/browse/summarize', BrowseController.summarize);
router.post('/browse/ask', BrowseController.askAboutPage);

// ── Model / Health Discovery ──────────────────────────────────────────────
router.get('/models', AIController.listModels);
router.get('/health/services', AIController.checkHealth);
router.get('/local-image-status', AIController.checkLocalImageStatus);

// ── Adversarial Debate ─────────────────────────────────────────────────────
const debateRequestSchema = z.object({
  topic: z.string().min(1, 'topic is required').max(10_000),
  proponentModel: z.object({ provider: z.string().max(64), model: z.string().max(256) }).optional(),
  criticModel: z.object({ provider: z.string().max(64), model: z.string().max(256) }).optional()
});

router.post('/debate', async (req, res) => {
  const parseResult = debateRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parseResult.error.errors });
  }
  const { topic, proponentModel, criticModel } = parseResult.data;
  try {
    const result = await debateService.conductDebate(topic, proponentModel, criticModel);
    res.json(result);
  } catch (error) {
    handleRouteError({ res, error, context: 'debate' });
  }
});

// ── Agentic Compare ───────────────────────────────────────────────────────
router.post('/compare', AIController.compare);

// ── Multi-Agent Collaborate (Conversational Roundtable — SSE) ────────────
router.post('/collaborate/stream', CollaborateController.streamConversation);
router.post('/collaborate/inject', CollaborateController.injectMessage);
router.get('/collaborate/session/:id', CollaborateController.getSessionState);
router.post('/collaborate/synthesize', CollaborateController.synthesizeNow);

// ── Multi-Agent Collaborate (Legacy parallel mode) ───────────────────────
router.post('/collaborate', async (req, res) => {
  const { goal, missionType = 'consultation', async: isAsync, provider, model } = req.body;
  if (!goal) return res.status(400).json({ error: 'Goal is required' });
  if (typeof goal !== 'string' || goal.length > 5000) {
    return res.status(400).json({ error: 'Goal must be a string with max 5000 characters' });
  }

  try {
    const result = await orchestrationService.runMission(missionType, goal, {
      async: isAsync,
      providerOverride: provider,
      modelOverride: model
    });

    // Return 202 Accepted for async requests
    if (isAsync && 'jobId' in result) {
      return res.status(202).json(result);
    }

    res.json(result);
  } catch (error) {
    handleRouteError({ res, error, context: 'collaborate' });
  }
});

// Task Status Polling Endpoint
router.get('/tasks/:jobId', async (req, res) => {
  const { jobId } = req.params;

  try {
    const { taskService } = await import('../services/taskService');
    const status = await taskService.getJobStatus(jobId);
    res.json(status);
  } catch (error) {
    handleRouteError({ res, error, context: 'tasks' });
  }
});

// Conclusive Analysis Endpoint
// Re-synthesizes agent opinions + user context into a deeper actionable analysis
// Mirrors orchestrationService.analyzeFindings()'s parameter shape.
const analyzeSchema = z.object({
  opinions: z.array(z.object({
    id: z.string().max(256).optional(),
    agent: z.string().max(256).optional(),
    role: z.string().max(256).optional(),
    opinion: z.string().max(50_000),
  })).min(1, 'opinions is required'),
  synthesis: z.string().min(1, 'synthesis is required').max(50_000),
  userContext: z.string().max(50_000).optional(),
  missionType: z.string().max(64).optional(),
});

router.post('/analyze', async (req, res) => {
  const parseResult = analyzeSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'opinions and synthesis are required', details: parseResult.error.errors });
  }
  const { opinions, synthesis, userContext, missionType } = parseResult.data;

  try {
    const analysis = await orchestrationService.analyzeFindings(
      opinions,
      synthesis,
      userContext,
      missionType
    );
    res.json({ analysis });
  } catch (error) {
    handleRouteError({ res, error, context: 'analyze' });
  }
});

// Manual Overseer Trigger Endpoint
// Allows the Command Center to fire a live-context think() cycle on demand.
// Mirrors supervisorService.think()'s `data` parameter shape.
const overseerTriggerSchema = z.object({
  focus: z.string().max(2000).optional(),
  notepadContent: z.string().max(50_000).optional(),
  recentMessages: z.array(z.object({
    role: z.string().max(32),
    content: z.string().max(50_000),
  })).max(50).optional(),
});

router.post('/overseer/trigger', async (req, res) => {
  const parseResult = overseerTriggerSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parseResult.error.errors });
  }
  const { focus, notepadContent, recentMessages } = parseResult.data;
  // Fire-and-forget — respond immediately, let think() run async
  supervisorService.think({
    activity: 'manual_trigger',
    data: { focus, notepadContent, recentMessages }
  }).catch((err: unknown) => {
    logger.warn(`[Overseer] manual_trigger think() failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  res.json({ status: 'triggered', message: 'Overseer is analyzing...' });
});

// Plugin Discovery Endpoint
router.get('/plugins', async (_req, res) => {
  try {
    const { pluginManager } = await import('../services/pluginManager');
    await pluginManager.initialize(); // Ensure plugins are loaded

    const registry = pluginManager.getRegistry();
    const pluginsInfo = {
      providers: Array.from(registry.providers.values()).map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        version: p.version,
        defaultModel: p.defaultModel
      })),
      tools: Array.from(registry.tools.values()).map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        version: t.version,
        schema: t.schema
      }))
    };

    res.json(pluginsInfo);
  } catch (error: unknown) {
    const err = error as { message?: string };
    res.status(500).json({ error: err.message });
  }
});

// ── Session Persistence ────────────────────────────────────────────────────
router.post('/sessions', async (req, res) => {
  try {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid session payload', details: parsed.error.errors });
    }
    const { id, mode, title, messages, parentMessageId, parentSessionId, tags } = parsed.data;
    const now = Date.now();
    const storedMessages = storageService.toStoredMessages(messages as unknown as import('../types/frontend').Message[]);
    const modelsUsed = [...new Set(storedMessages.map(m => m.model).filter((m): m is string => Boolean(m)))];
    const tokenEstimate = storedMessages.reduce((acc, m) => acc + Math.ceil((m.content?.length || 0) / 4), 0);
    const derivedTitle = title?.trim()
      || storedMessages.find(m => m.role === 'user')?.content.slice(0, 60).trim()
      || 'New Session';

    const session = {
      id: id || randomUUID(),
      mode,
      title: derivedTitle,
      messages: storedMessages,
      createdAt: now,
      updatedAt: now,
      ...(parentMessageId ? { parentMessageId } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      metadata: {
        modelsUsed,
        messageCount: storedMessages.length,
        tokenEstimate,
        tags: tags ?? [],
      },
    };

    await storageService.saveSession(session);
    res.status(201).json({ ...session, messages: storageService.toFrontendMessages(session.messages) });
  } catch (error) {
    handleRouteError({ res, error, context: 'session-create' });
  }
});

router.get('/sessions', async (req, res) => {
  try {
    const mode = queryString(req.query.mode) || undefined;
    const search = queryString(req.query.search);
    const parsedLimit = parseClampedInt(req.query.limit, 50, 1, 200);
    const parsedOffset = parseClampedInt(req.query.offset, 0, 0, 100_000);

    // The index holds summaries only (no message bodies), so content search
    // goes through findSessions, which reads the session files. Hits carry
    // the matched message in `messages` for the frontend's excerpt.
    const sessions = search
      ? await storageService.findSessions(search, {
          mode,
          includeTitles: true,
          limit: parsedOffset + parsedLimit,
        })
      : await storageService.listSessions(mode);

    const paginated = sessions.slice(parsedOffset, parsedOffset + parsedLimit);
    res.json({ sessions: paginated, total: sessions.length });
  } catch (error) {
    handleRouteError({ res, error, context: 'sessions-list' });
  }
});

router.get('/sessions/search', async (req, res) => {
  try {
    const q = queryString(req.query.q);
    if (!q) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }
    const limit = parseClampedInt(req.query.limit, 20, 1, 100);
    const results = await storageService.searchSessions(q, limit);
    res.json({ results });
  } catch (error) {
    handleRouteError({ res, error, context: 'sessions-search' });
  }
});

router.get('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid session ID format' });
    }
    const session = await storageService.loadSession(id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    // Storage uses StoredMessage (`timestamp`); the frontend's Message type
    // uses `createdAt` — convert so the API always speaks the frontend shape.
    res.json({ ...session, messages: storageService.toFrontendMessages(session.messages) });
  } catch (error) {
    handleRouteError({ res, error, context: 'session-get' });
  }
});

router.put('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid session ID format' });
    }
    const parsed = updateSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid session update payload', details: parsed.error.errors });
    }
    const existing = await storageService.loadSession(id);
    if (!existing) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const { messages, title } = parsed.data;
    const storedMessages = messages
      ? storageService.toStoredMessages(messages as unknown as import('../types/frontend').Message[])
      : existing.messages;
    const updated = {
      ...existing,
      title: title !== undefined && title.trim() ? title.trim() : existing.title,
      messages: storedMessages,
      updatedAt: Date.now(),
      metadata: {
        ...existing.metadata,
        messageCount: storedMessages.length,
        modelsUsed: [...new Set(storedMessages.map(m => m.model).filter((m): m is string => Boolean(m)))]
      }
    };

    await storageService.saveSession(updated);
    res.json({ ...updated, messages: storageService.toFrontendMessages(updated.messages) });
  } catch (error) {
    handleRouteError({ res, error, context: 'session-update' });
  }
});

router.delete('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid session ID format' });
    }
    await storageService.deleteSession(id);
    res.json({ success: true, message: 'Session deleted' });
  } catch (error) {
    handleRouteError({ res, error, context: 'session-delete' });
  }
});

// ── Overseer Decision Review ────────────────────────────────────────────────
router.get('/overseer/pending', async (_req, res) => {
  try {
    const pending = supervisorService.getPendingDecisions();
    res.json({ decisions: pending });
  } catch (error) {
    handleRouteError({ res, error, context: 'overseer-pending' });
  }
});

router.get('/overseer/history', async (req, res) => {
  try {
    const limit = parseClampedInt(req.query.limit, 50, 1, 200);
    const offset = parseClampedInt(req.query.offset, 0, 0, 100_000);
    const trigger = queryString(req.query.trigger);
    const status = queryString(req.query.status);

    // Fetch full history before filtering so pagination & total reflect the filtered set
    let history = supervisorService.getDecisionHistory(Number.MAX_SAFE_INTEGER, 0);

    if (trigger) {
      history = history.filter(h => h.trigger === trigger);
    }
    if (status) {
      history = history.filter(h => h.status === status);
    }

    const total = history.length;
    const page = history.slice(offset, offset + limit);

    res.json({ decisions: page, total });
  } catch (error) {
    handleRouteError({ res, error, context: 'overseer-history' });
  }
});

router.post('/overseer/approve', async (req, res) => {
  try {
    const { decisionId } = req.body;
    if (!decisionId) {
      return res.status(400).json({ error: 'decisionId is required' });
    }

    const result = await supervisorService.approveDecision(decisionId);
    if (result.success) {
      res.json({ success: true, message: 'Decision approved' });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    handleRouteError({ res, error, context: 'overseer-approve' });
  }
});

router.post('/overseer/reject', async (req, res) => {
  try {
    const { decisionId, reason } = req.body;
    if (!decisionId) {
      return res.status(400).json({ error: 'decisionId is required' });
    }

    const result = await supervisorService.rejectDecision(decisionId, reason);
    if (result.success) {
      res.json({ success: true, message: 'Decision rejected' });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    handleRouteError({ res, error, context: 'overseer-reject' });
  }
});

// ── Debug Traces ─────────────────────────────────────────────────────────────
router.get('/debug/traces', AIController.getTraces);
router.get('/debug/traces/health', AIController.getTraceHealth);
router.patch('/debug/traces/:id/outcome', AIController.updateTraceOutcome);

// ── Codebase Indexing ────────────────────────────────────────────────────────
router.post('/codebase/index', async (req, res) => {
  try {
    const rawRoot = req.body?.rootPath;
    if (rawRoot !== undefined && typeof rawRoot !== 'string') {
      return res.status(400).json({ error: 'rootPath must be a string' });
    }
    const resolved = await resolveSecureChildPath(PROJECT_ROOT, rawRoot, [PROJECT_ROOT]);

    const { codebaseIndexer } = await import('../services/codebaseIndexer');

    // Perform full index
    await codebaseIndexer.indexProject(resolved);

    res.json({ success: true, message: 'Codebase indexing complete' });
  } catch (error) {
    if (error instanceof PathSecurityError) {
      return res.status(403).json({ error: 'Access denied' });
    }
    handleRouteError({ res, error, context: 'codebase-index' });
  }
});

router.get('/codebase/status', async (_req, res) => {
  try {
    const { codebaseIndexer } = await import('../services/codebaseIndexer');
    const status = codebaseIndexer.getStatus();
    res.json(status);
  } catch (error) {
    handleRouteError({ res, error, context: 'codebase-status' });
  }
});

router.post('/codebase/watch', async (req, res) => {
  try {
    const { rootPath, enabled } = req.body ?? {};
    const { codebaseIndexer } = await import('../services/codebaseIndexer');

    if (enabled) {
      if (rootPath !== undefined && typeof rootPath !== 'string') {
        return res.status(400).json({ error: 'rootPath must be a string' });
      }
      const resolved = await resolveSecureChildPath(PROJECT_ROOT, rootPath, [PROJECT_ROOT]);
      await codebaseIndexer.stop();
      await codebaseIndexer.start({ rootPath: resolved });
      res.json({ success: true, message: 'File watcher started' });
    } else {
      await codebaseIndexer.stop();
      res.json({ success: true, message: 'File watcher stopped' });
    }
  } catch (error) {
    if (error instanceof PathSecurityError) {
      return res.status(403).json({ error: 'Access denied' });
    }
    handleRouteError({ res, error, context: 'codebase-watch' });
  }
});

export default router;
