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

// Max recursion depth for scrub() — guards against pathologically deep or
// cyclic context objects (e.g. an Error with a `cause` chain) blowing the stack.
const SCRUB_MAX_DEPTH = 6;

// Matches common provider API key prefixes (OpenAI/OpenRouter/Anthropic sk-*,
// Groq gsk_*, Gemini AIza*, HuggingFace hf_*, Cerebras csk-*, Fireworks fw_*, ai_*).
const API_KEY_PATTERN = /(?:(?:sk-|gsk[-_]|ai_|hf_|csk-|fw_)[a-zA-Z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,})/g;

class LoggerService {
  private scrub(data: unknown, depth: number = 0, seen: WeakSet<object> = new WeakSet()): unknown {
    if (depth > SCRUB_MAX_DEPTH) return '<max depth>';
    if (typeof data === 'string') {
      // Mask typical API key patterns wherever the string appears — not just
      // under obviously-named keys, since a secret can end up embedded in an
      // error message or URL logged under an innocuous key.
      return data.replace(API_KEY_PATTERN, '***REDACTED***');
    }
    if (Array.isArray(data)) {
      if (seen.has(data)) return '[Circular]';
      seen.add(data);
      return data.map(v => this.scrub(v, depth + 1, seen));
    }
    if (data instanceof Error) {
      if (seen.has(data)) return '[Circular]';
      seen.add(data);
      const errObj: Record<string, unknown> = {
        name: data.name,
        message: this.scrub(data.message, depth + 1, seen),
      };
      if (data.stack) errObj.stack = this.scrub(data.stack, depth + 1, seen);
      const anyErr = data as unknown as Record<string, unknown>;
      if (anyErr.code !== undefined) errObj.code = anyErr.code;
      if (anyErr.status !== undefined) errObj.status = anyErr.status;
      if (anyErr.cause !== undefined) errObj.cause = this.scrub(anyErr.cause, depth + 1, seen);
      for (const [key, val] of Object.entries(anyErr)) {
        if (key in errObj) continue;
        errObj[key] = /key|secret|token|password|auth/i.test(key)
          ? '***REDACTED***'
          : this.scrub(val, depth + 1, seen);
      }
      return errObj;
    }
    if (typeof data === 'object' && data !== null) {
      if (seen.has(data)) return '[Circular]';
      seen.add(data);
      const scrubbed: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
        scrubbed[key] = /key|secret|token|password|auth/i.test(key)
          ? '***REDACTED***'
          : this.scrub(val, depth + 1, seen);
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
    let ctxString = '';
    if (scrubbedContext !== null) {
      try {
        ctxString = ` | Context: ${JSON.stringify(scrubbedContext)}`;
      } catch {
        ctxString = ` | Context: ${String(scrubbedContext)}`;
      }
    }
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
