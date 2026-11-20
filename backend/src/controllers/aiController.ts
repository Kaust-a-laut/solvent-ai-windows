import { Request, Response } from 'express';
import { aiService } from '../services/aiService';
import { WaterfallStep } from '../services/waterfallService';
import { metaMemoryService } from '../services/metaMemoryService';
import { taskService } from '../services/taskService';
import { traceLogger } from '../services/traceLogger';
import { logger } from '../utils/logger';
import { createSSEWriter } from '../utils/sseWriter';
import { requestContextStore } from '../utils/requestContext';
import { PROJECT_ROOT } from '../utils/fileSystem';
import { PathSecurityError, resolveSecurePath } from '../utils/pathSecurity';
import { requestBodySummary } from '../utils/redaction';
import { z } from 'zod';
import { access } from 'fs/promises';
import path from 'path';

function normalizeImageInput(
  val: string | { data: string; mimeType: string } | null | undefined
): { data: string; mimeType: string } | null | undefined {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (!trimmed) return null;
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(trimmed);
  if (match && match[1] && match[2]) {
    return { mimeType: match[1], data: match[2] };
  }
  return { mimeType: 'image/png', data: trimmed };
}

function isSafeLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

// Zod schemas for request validation
const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'model']),
  content: z.string(),
  image: z.string().nullable().optional()
});

const chatRequestSchema = z.object({
  provider: z.string(),
  model: z.string(),
  messages: z.array(chatMessageSchema),
  image: z.union([
    z.string(),
    z.object({ data: z.string(), mimeType: z.string() }),
  ]).nullable().optional().transform(normalizeImageInput),
  mode: z.string().optional(),
  smartRouter: z.boolean().optional(),
  fallbackModel: z.string().optional(),
  imageProvider: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
  apiKeys: z.record(z.string()).optional(),
  thinkingModeEnabled: z.boolean().optional(),
  activeFile: z.string().max(4096).nullable().optional().transform(v => v ?? undefined),
  tier: z.enum(['full-agentic', 'code-only']).optional(),
  traits: z.object({
    toolUse: z.enum(['strong', 'basic']),
    multimodal: z.boolean(),
    contextWindow: z.number().int().min(1).max(2_000_000),
  }).optional(),
  deviceInfo: z.object({
    isMobile: z.boolean(),
    isTablet: z.boolean(),
    isDesktop: z.boolean(),
    windowSize: z.object({ width: z.number(), height: z.number() })
  }).optional(),
  notepadContent: z.string().optional(),
  openFiles: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
  codingHistory: z.array(chatMessageSchema).optional(),
  browserContext: z.object({
    history: z.array(z.string()),
    lastSearchResults: z.array(z.object({
      title: z.string(),
      link: z.string(),
      snippet: z.string().optional()
    })).nullable().optional()
  }).optional(),
  sessionId: z.string().optional(),
  projectRoot: z.string().optional(),
  previewState: z.object({
    url: z.string().nullable().optional(),
    bodyHash: z.string().nullable().optional(),
    consoleBuffer: z.array(z.object({
      level: z.string(),
      message: z.string(),
      timestamp: z.number(),
    })).optional(),
    selectedElement: z.object({
      tag: z.string(),
      id: z.string().optional(),
      classes: z.array(z.string()),
      text: z.string(),
    }).nullable().optional(),
  }).optional()
});

const searchRequestSchema = z.object({
  query: z.string().min(1, 'Query is required').max(2_000),
  page: z.number().int().min(1).max(100).optional(),
  expandedQuery: z.string().max(2_000).optional(),
});

const compareRequestSchema = z.object({
  messages: z.array(chatMessageSchema),
  model1: z.string().optional(),
  provider1: z.string().optional(),
  model2: z.string().optional(),
  provider2: z.string().optional(),
});

const phaseSelectionSchema = z.union([
  z.enum(['A', 'B']),
  z.object({ model: z.string(), provider: z.string() })
]);

const modelSelectionSchema = z.object({
  planner: phaseSelectionSchema,
  executor: phaseSelectionSchema,
  reviewer: phaseSelectionSchema,
}).optional();

const waterfallRequestSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required').max(50_000),
  globalProvider: z.string().max(64).optional(),
  notepadContent: z.string().optional(),
  openFiles: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
  forceProceed: z.boolean().optional(),
  modelSelection: modelSelectionSchema,
  apiKeys: z.record(z.string()).optional(),
});

const waterfallStepRequestSchema = z.object({
  step: z.enum([WaterfallStep.PLANNER, WaterfallStep.EXECUTOR, WaterfallStep.REVIEWER]),
  input: z.string().max(200_000),
  context: z.record(z.unknown()).nullable().optional(),
  globalProvider: z.string().max(64).optional()
});

export class AIController {
  static async chat(req: Request, res: Response) {
    try {
      const parseResult = chatRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        logger.error('[AIController] Invalid request body', {
          route: req.path,
          requestId: req.id,
          ...requestBodySummary(req.body, parseResult.error.issues),
        });
        return res.status(400).json({
          error: 'Invalid request body',
          details: parseResult.error.errors
        });
      }
      const result = await aiService.processChat(parseResult.data);
      res.json(result);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`[AIController] Chat Error: ${err.message}`);
      const status = 'status' in err && typeof err.status === 'number' ? err.status : 500;
      const message = err.message || 'Chat processing failed';
      res.status(status).json({ error: message });
    }
  }

  /**
   * Streaming chat: same context pipeline as /chat, but flushes token deltas as SSE events.
   * Event shapes:
   *   { type: 'token', value: string }
   *   { type: 'done', model, provider, traceId }
   *   { type: 'error', message }
   * Client disconnect aborts the upstream provider call.
   */
  static async chatStream(req: Request, res: Response) {
    const parseResult = chatRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parseResult.error.errors });
    }
    const sse = createSSEWriter(req, res);
    try {
      for await (const event of aiService.processChatStream(parseResult.data, sse.signal)) {
        if (sse.signal.aborted) break;
        sse.send(event);
        // Apply socket backpressure: if the client is slow, wait for drain
        // before pulling more from the upstream provider stream. Prevents
        // unbounded buffering in Node when the consumer falls behind.
        if (sse.isBackpressured) await sse.flushed();
      }
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`[AIController] Chat Stream Error: ${err.message}`);
      sse.send({ type: 'error', message: err.message || 'stream failed' });
    } finally {
      sse.end();
    }
  }

  static async generateImage(req: Request, res: Response) {
    try {
      const imageSchema = z.object({
        prompt: z.string().trim().min(1, 'Prompt is required').max(10_000),
        model: z.string().max(256).optional(),
        provider: z.string().max(64).optional(),
        localUrl: z.string().max(2048).refine(isSafeLoopbackUrl, {
          message: 'localUrl must be a valid loopback http(s) URL (127.0.0.1, localhost, or ::1)',
        }).optional(),
        apiKeys: z.record(z.string()).optional()
      });
      const parsed = imageSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request body', details: parsed.error.errors });
      }
      const { prompt, model, provider, localUrl, apiKeys } = parsed.data;
      const result = await aiService.generateImage(prompt, model, apiKeys?.gemini, provider, { localUrl, apiKeys });
      res.json(result);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`[AIController] Image Generation Error: ${err.message}`);
      res.status(500).json({ error: err.message || 'Image generation failed' });
    }
  }

  static async search(req: Request, res: Response) {
    try {
      const parseResult = searchRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Invalid request body',
          details: parseResult.error.errors
        });
      }
      const { query, page, expandedQuery } = parseResult.data;
      const { intelligentSearchService } = await import('../services/intelligentSearchService');
      const result = await intelligentSearchService.search(query, page, expandedQuery);
      res.json(result);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      res.status(500).json({ error: err.message });
    }
  }

  static async compare(req: Request, res: Response) {
    try {
      const parseResult = compareRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ 
          error: 'Invalid request body', 
          details: parseResult.error.errors 
        });
      }
      const { messages, model1, provider1, model2, provider2 } = parseResult.data;
      const result = await aiService.compareModels(messages, {
        model1, provider1, model2, provider2,
      });
      res.json(result);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      res.status(500).json({ error: err.message });
    }
  }

  static async waterfall(req: Request, res: Response) {
    const sse = createSSEWriter(req, res);

    try {
      const parseResult = waterfallRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        sse.send({ phase: 'error', message: 'Invalid request body', details: parseResult.error.errors });
        sse.end();
        return;
      }

      const { prompt, globalProvider, notepadContent, openFiles, forceProceed, modelSelection, apiKeys } = parseResult.data;

      const result = await aiService.runAgenticWaterfall(
        prompt,
        globalProvider,
        undefined,
        (phase, data) => sse.send({ phase, ...data }),
        notepadContent,
        openFiles,
        sse.signal,
        forceProceed,
        undefined,
        modelSelection,
        apiKeys
      );

      sse.send({ phase: 'final', ...result });
      sse.end();
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      sse.send({ phase: 'error', message: err.message });
      sse.end();
    }
  }

  static async waterfallStep(req: Request, res: Response) {
    try {
      const parseResult = waterfallStepRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ 
          error: 'Invalid request body', 
          details: parseResult.error.errors 
        });
      }
      const { step, input, context, globalProvider } = parseResult.data;
      const result = await aiService.runWaterfallStep(step as WaterfallStep, input, (context ?? undefined) as import('../types/waterfall').WaterfallContext | undefined, globalProvider);
      res.json(result);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      res.status(500).json({ error: err.message });
    }
  }

  static async indexProject(_req: Request, res: Response) {
    try {
      // Use the task service to dispatch the indexing job asynchronously
      const jobId = await taskService.dispatchIndexingJob(process.cwd());
      res.json({
        status: 'queued',
        jobId,
        message: 'Project indexing has been queued for processing'
      });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      res.status(500).json({ error: err.message });
    }
  }

  static async listModels(_req: Request, res: Response) {
    try {
      const result = await aiService.listAvailableModels();
      res.json(result);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      res.status(500).json({ error: err.message });
    }
  }

  static async checkLocalImageStatus(_req: Request, res: Response) {
    try {
      const result = await aiService.checkLocalImageStatus();
      res.json(result);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      res.status(500).json({ error: err.message });
    }
  }

  static async checkHealth(_req: Request, res: Response) {
    try {
      const result = await aiService.checkHealth();
      res.json(result);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * SSE endpoint for agent chat with real-time tool visibility.
   * Streams AgentEvent objects as SSE `data:` lines.
   */
  static async agentChat(req: Request, res: Response) {
    const sse = createSSEWriter(req, res);

    try {
      const parseResult = chatRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        sse.send({ type: 'error', message: 'Invalid request body' });
        sse.end();
        return;
      }

      const data = { ...parseResult.data, signal: sse.signal };

      // Resolve the per-request project root (chat body) against the repo root,
      // resolving symlinks/junctions and handling Windows path casing.
      let resolvedProjectRoot: string | undefined;
      if (parseResult.data.projectRoot) {
        try {
          resolvedProjectRoot = await resolveSecurePath(parseResult.data.projectRoot, PROJECT_ROOT, [PROJECT_ROOT]);
        } catch (err) {
          if (err instanceof PathSecurityError) {
            sse.send({ type: 'error', message: 'Invalid projectRoot (escapes repo)' });
            sse.end();
            return;
          }
          throw err;
        }
      }

      // Hold the frontend-supplied preview state + project scope in AsyncLocalStorage
      // so tools can read both without threading parameters through every call site.
      await requestContextStore.run(
        { previewState: parseResult.data.previewState, projectRoot: resolvedProjectRoot },
        async () => {
          await aiService.processAgentChat(data, (event) => sse.send(event));
        }
      );

      sse.send({ type: 'done' });
      sse.end();
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      sse.send({ type: 'error', message: err.message });
      sse.end();
    }
  }

  static async synthesizeMemory(_req: Request, res: Response) {
    try {
      const summary = await metaMemoryService.synthesizeStateOfTheUnion();
      res.json({ status: 'success', summary });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      res.status(500).json({ error: err.message });
    }
  }

  static async updateTraceOutcome(req: Request, res: Response) {
    const ip = req.ip || req.socket?.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) {
      res.status(403).json({ error: 'This endpoint is only accessible from localhost.' });
      return;
    }

    const id = req.params['id'];
    if (!id) {
      res.status(400).json({ error: 'Missing trace id parameter.' });
      return;
    }
    const validOutcomes = ['correction', 'crystallized', 'rerequested', 'accepted'] as const;
    const schema = z.object({ outcome: z.enum(validOutcomes) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `outcome must be one of: ${validOutcomes.join(', ')}` });
      return;
    }

    try {
      await traceLogger.updateOutcome(id, parsed.data.outcome);
      if (parsed.data.outcome === 'correction') {
        const sessionId = aiService.getSessionForTrace(id);
        if (sessionId) aiService.recordCorrection(sessionId);
      }
      res.json({ success: true });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      res.status(500).json({ error: err.message });
    }
  }

  static async getTraces(req: Request, res: Response) {
    const TRACE_FILE_PATH = path.join(process.cwd(), '..', 'backend', '.solvent_retrieval_traces.jsonl');
    const ALT_TRACE_FILE_PATH = path.join(process.cwd(), '.solvent_retrieval_traces.jsonl');

    const ip = req.ip || req.socket?.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) {
      res.status(403).json({ error: 'This endpoint is only accessible from localhost.' });
      return;
    }

    const firstString = (v: unknown): string => {
      if (typeof v === 'string') return v;
      if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
      return '';
    };

    const rawLimit = Number.parseInt(firstString(req.query.limit), 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 200)) : 50;
    const queryFilter = firstString(req.query.query).toLowerCase();
    const modeFilter = firstString(req.query.mode);
    const rawSince = firstString(req.query.since);
    let sinceFilter = 0;
    if (rawSince) {
      sinceFilter = new Date(rawSince).getTime();
      if (Number.isNaN(sinceFilter)) {
        res.status(400).json({ error: 'Invalid "since" date parameter.' });
        return;
      }
    }
    const outcomeFilter = firstString(req.query.outcome);
    const sessionFilter = firstString(req.query.sessionId);

    let filePath = TRACE_FILE_PATH;
    try {
      await access(filePath);
    } catch {
      try {
        await access(ALT_TRACE_FILE_PATH);
        filePath = ALT_TRACE_FILE_PATH;
      } catch {
        res.json([]);
        return;
      }
    }

    try {
      const allTraces = await traceLogger.readTraces(filePath);
      // Newest first
      const reversed = [...allTraces].reverse();

      const results = reversed.filter(trace => {
        if (queryFilter && !trace.query?.toLowerCase().includes(queryFilter)) return false;
        if (modeFilter && trace.mode !== modeFilter) return false;
        if (sinceFilter && new Date(trace.ts).getTime() < sinceFilter) return false;
        if (outcomeFilter && trace.outcome !== outcomeFilter) return false;
        if (sessionFilter && trace.sessionId !== sessionFilter) return false;
        return true;
      }).slice(0, limit);

      res.json(results);
    } catch {
      res.status(500).json({ error: 'Failed to read trace file.' });
    }
  }

  static async getTraceHealth(_req: Request, res: Response) {
    try {
      const allTraces = await traceLogger.readTraces();
      const recent = allTraces.slice(-50);

      if (recent.length === 0) {
        res.json({ traceCount: 0, recentCount: 0, avgBudgetUtilization: 0, correctionRate: 0, avgPipelineMs: 0, lastTraceTs: null });
        return;
      }

      const corrections = recent.filter(t => t.outcome === 'correction').length;
      const budgetUtils = recent.map(t =>
        t.promptTokens?.budget > 0 ? t.promptTokens.total / t.promptTokens.budget : 0
      );
      const avgBudget = budgetUtils.reduce((a, b) => a + b, 0) / recent.length;
      const avgMs = recent.reduce((a, t) => a + t.pipelineMs, 0) / recent.length;

      res.json({
        traceCount: allTraces.length,
        recentCount: recent.length,
        avgBudgetUtilization: Math.round(avgBudget * 1000) / 1000,
        correctionRate: Math.round((corrections / recent.length) * 1000) / 1000,
        avgPipelineMs: Math.round(avgMs),
        lastTraceTs: recent[recent.length - 1]?.ts || null,
      });
    } catch {
      res.json({ traceCount: 0, recentCount: 0, avgBudgetUtilization: 0, correctionRate: 0, avgPipelineMs: 0, lastTraceTs: null });
    }
  }
}
