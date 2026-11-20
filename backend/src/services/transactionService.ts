import path from 'path';
import { randomUUID } from 'node:crypto';
import { PROJECT_ROOT } from '../utils/fileSystem';
import { safeForAudit } from '../utils/redaction';
import { isSensitivePath } from '../utils/sensitivePaths';
import { JsonlAppender, DEFAULT_JSONL_ROTATION } from '../utils/jsonlAppender';
import { LRUMap } from '../utils/lruMap';

interface TransactionLogEntry {
  id: string;
  timestamp: string;
  tool?: string;
  args?: unknown;
  status: 'pending' | 'success' | 'failed' | 'denied';
  result?: unknown;
  resultBytes?: number;
  error?: string;
  cycleId?: string;
}

const LOG_RESULTS = (process.env.SOLVENT_AUDIT_LOG_RESULTS ?? 'true') === 'true';
const SENSITIVE_PLACEHOLDER = '[REDACTED: sensitive file]';

// Arg keys that name files a tool reads or writes.
const PATH_ARG_KEYS = ['path', 'file', 'from', 'to', 'filePath', 'projectPath'];
// Arg keys that carry file *contents* — dropped when the target is sensitive.
const CONTENT_ARG_KEYS = ['content', 'new_content', 'old_content', 'patch', 'replacement'];

/**
 * Estimate serialized size without JSON.stringify-ing the whole value —
 * results can be multi-MB (base64 screenshots, file contents) and stringifying
 * them synchronously on every tool call blocked the event loop.
 */
function approxByteSize(value: unknown, budget = { nodes: 10_000 }): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length;
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value !== 'object') return 0;
  if (--budget.nodes <= 0) return 0;
  let total = 2;
  if (Array.isArray(value)) {
    for (const item of value) total += approxByteSize(item, budget) + 1;
    return total;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    total += k.length + 3 + approxByteSize(v, budget) + 1;
  }
  return total;
}

function referencesSensitivePath(args: Record<string, unknown> | undefined): boolean {
  if (!args || typeof args !== 'object') return false;
  for (const key of PATH_ARG_KEYS) {
    const v = args[key];
    if (typeof v === 'string' && isSensitivePath(v)) return true;
  }
  return false;
}

function redactSensitiveArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (!referencesSensitivePath(args)) return args;
  const out: Record<string, unknown> = { ...args };
  for (const key of CONTENT_ARG_KEYS) {
    if (key in out) out[key] = SENSITIVE_PLACEHOLDER;
  }
  return out;
}

export class TransactionService {
  private appender: JsonlAppender;
  // Transactions whose args touched a sensitive path — their results
  // (e.g. read_file of .env) are not written to the audit log.
  private sensitiveTx = new LRUMap<string, true>(1000);

  constructor() {
    // Rotated at 20MB (2 generations kept); the live file used to grow forever.
    this.appender = new JsonlAppender(path.join(PROJECT_ROOT, '.solvent_audit.jsonl'), DEFAULT_JSONL_ROTATION);
  }

  async logStart(tool: string, args: Record<string, unknown>, cycleId?: string): Promise<string> {
    const id = randomUUID();
    if (referencesSensitivePath(args)) this.sensitiveTx.set(id, true);
    const entry: TransactionLogEntry = {
      id,
      timestamp: new Date().toISOString(),
      tool,
      args: safeForAudit(redactSensitiveArgs(args)),
      status: 'pending',
      cycleId
    };
    await this.appendLog(entry);
    return id;
  }

  async logComplete(id: string, result: unknown) {
    const entry: TransactionLogEntry = {
      id,
      status: 'success',
      timestamp: new Date().toISOString(),
      resultBytes: approxByteSize(result),
    };
    if (LOG_RESULTS) {
      entry.result = this.sensitiveTx.has(id) ? SENSITIVE_PLACEHOLDER : safeForAudit(result);
    }
    this.sensitiveTx.delete(id);
    await this.appendLog(entry);
  }

  async logError(id: string, error: string) {
    this.sensitiveTx.delete(id);
    await this.appendLog({
      id,
      status: 'failed',
      error: safeForAudit(typeof error === 'string' ? error : String(error)) as string,
      timestamp: new Date().toISOString(),
    });
  }

  async logDenial(tool: string, args: Record<string, unknown>, reason: string) {
    await this.appendLog({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      tool,
      args: safeForAudit(redactSensitiveArgs(args)),
      status: 'denied',
      error: reason,
    });
  }

  private async appendLog(entry: TransactionLogEntry) {
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ id: entry.id, status: entry.status, timestamp: entry.timestamp, error: 'unserializable entry' });
    }
    // JsonlAppender logs and swallows write failures.
    await this.appender.append(line);
  }
}

export const transactionService = new TransactionService();
