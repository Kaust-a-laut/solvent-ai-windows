/**
 * Extract a human-readable message from an unknown caught value.
 *
 * Handles the four shapes provider code repeatedly hand-types as inline
 * casts:
 *   - axios errors with response.data.error.message
 *   - axios errors with a top-level message
 *   - native Error instances
 *   - non-Error throws (strings, objects, primitives)
 */
export function getErrorMessage(err: unknown): string {
  if (err == null) return 'unknown error';

  if (typeof err === 'string') return err;

  if (typeof err === 'object') {
    const e = err as {
      response?: { data?: { error?: { message?: unknown } | string } | string };
      message?: unknown;
    };

    const data = e.response?.data;
    if (data) {
      if (typeof data === 'string') return data;
      const inner = (data as { error?: { message?: unknown } | string }).error;
      if (typeof inner === 'string') return inner;
      if (inner && typeof inner === 'object' && typeof inner.message === 'string') {
        return inner.message;
      }
    }

    if (typeof e.message === 'string' && e.message.length > 0) return e.message;
  }

  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}
