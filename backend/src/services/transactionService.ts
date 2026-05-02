import fs from 'fs/promises';
import path from 'path';
import { PROJECT_ROOT } from '../utils/fileSystem';
import { logger } from '../utils/logger';
import { safeForAudit } from '../utils/redaction';

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

function approxByteSize(value: unknown): number {
  try {
    return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? null));
  } catch {
    return 0;
  }
}

export class TransactionService {
  private logPath: string;

  constructor() {
    this.logPath = path.join(PROJECT_ROOT, '.solvent_audit.jsonl');
  }

  async logStart(tool: string, args: Record<string, unknown>, cycleId?: string): Promise<string> {
    const id = Math.random().toString(36).substring(7);
    const entry: TransactionLogEntry = {
      id,
      timestamp: new Date().toISOString(),
      tool,
      args: safeForAudit(args),
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
      entry.result = safeForAudit(result);
    }
    await this.appendLog(entry);
  }

  async logError(id: string, error: string) {
    await this.appendLog({
      id,
      status: 'failed',
      error: typeof error === 'string' ? error.slice(0, 2048) : String(error),
      timestamp: new Date().toISOString(),
    });
  }

  async logDenial(tool: string, args: Record<string, unknown>, reason: string) {
    const id = Math.random().toString(36).substring(7);
    await this.appendLog({
      id,
      timestamp: new Date().toISOString(),
      tool,
      args: safeForAudit(args),
      status: 'denied',
      error: reason,
    });
  }

  private async appendLog(entry: TransactionLogEntry) {
    try {
      const line = JSON.stringify(entry) + '\n';
      await fs.appendFile(this.logPath, line);
    } catch (error) {
      logger.error('[TransactionService] Failed to write audit log', error);
    }
  }
}

export const transactionService = new TransactionService();
