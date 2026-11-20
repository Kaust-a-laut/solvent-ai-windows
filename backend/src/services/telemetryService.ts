import path from 'path';
import { logger } from '../utils/logger';
import { JsonlAppender, DEFAULT_JSONL_ROTATION } from '../utils/jsonlAppender';

interface TelemetryEvent {
  id: string;
  timestamp: string;
  type: 'chat' | 'image' | 'waterfall' | 'search';
  model: string;
  provider: string;
  latencyMs: number;
  tokensIn?: number; // Estimate or actual
  tokensOut?: number;
  status: 'success' | 'error';
  error?: string;
  meta?: Record<string, unknown>;
}

class TelemetryService {
  private appender: JsonlAppender;

  constructor() {
    // Rotated at 20MB (2 generations kept) — it used to append forever.
    this.appender = new JsonlAppender(path.resolve(__dirname, '../../../.solvent_telemetry.jsonl'), DEFAULT_JSONL_ROTATION);
  }

  async logTransaction(event: Omit<TelemetryEvent, 'timestamp'>) {
    const entry: TelemetryEvent = {
      ...event,
      timestamp: new Date().toISOString()
    };

    // Structured log for real-time dev visibility; [TELEMETRY] prefix is parseable by aggregators
    logger.info(`[TELEMETRY] ${JSON.stringify(entry)}`);

    // 2. Persistent Append-Only Log (JSONL); write failures are logged, never thrown.
    await this.appender.append(JSON.stringify(entry));
  }

  // Optional: Simple analytics
  async getStats() {
    // In a real app, this would read the file and aggregate
    // For now, we return a placeholder or implement a simple tail
    return { status: "active", logPath: this.appender.path };
  }
}

export const telemetryService = new TelemetryService();
