enum LogLevel {
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  DEBUG = 'DEBUG'
}

/**
 * `context` may be either a value or a thunk that produces one. Hot paths
 * (per-chunk stream loops, inner tool loops) can pass a thunk so the object
 * is only constructed when the level actually emits — currently relevant for
 * `debug()`, which is suppressed in production.
 */
export type LogContext = unknown | (() => unknown);

class LoggerService {
  private scrub(data: unknown): unknown {
    if (typeof data === 'string') {
      // Mask typical API key patterns (e.g., sk-..., gsk-..., etc.)
      return data.replace(/(sk-|gsk-|ai_)[a-zA-Z0-9]{20,}/g, '***REDACTED***');
    }
    if (typeof data === 'object' && data !== null) {
      const scrubbed: Record<string, unknown> = { ...(data as Record<string, unknown>) };
      for (const key in scrubbed) {
        if (/key|secret|token|password|auth/i.test(key)) {
          scrubbed[key] = '***REDACTED***';
        } else if (typeof scrubbed[key] === 'object') {
          scrubbed[key] = this.scrub(scrubbed[key]);
        }
      }
      return scrubbed;
    }
    return data;
  }

  private resolveContext(context?: LogContext): unknown {
    if (typeof context === 'function') {
      try {
        return (context as () => unknown)();
      } catch {
        return '<context thunk threw>';
      }
    }
    return context;
  }

  private formatMessage(level: LogLevel, message: string, context?: LogContext) {
    const timestamp = new Date().toISOString();
    const scrubbedMessage = this.scrub(message);
    const resolved = this.resolveContext(context);
    const scrubbedContext = resolved !== undefined && resolved !== null ? this.scrub(resolved) : null;
    const ctxString = scrubbedContext ? ` | Context: ${JSON.stringify(scrubbedContext)}` : '';
    return `[${timestamp}] [${level}] ${scrubbedMessage}${ctxString}`;
  }

  info(message: string, context?: LogContext) {
    console.log(this.formatMessage(LogLevel.INFO, message, context));
  }

  warn(message: string, context?: LogContext) {
    console.warn(this.formatMessage(LogLevel.WARN, message, context));
  }

  error(message: string, context?: LogContext) {
    console.error(this.formatMessage(LogLevel.ERROR, message, context));
  }

  debug(message: string, context?: LogContext) {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(this.formatMessage(LogLevel.DEBUG, message, context));
    }
  }
}

export const logger = new LoggerService();
