import * as path from 'path';
import * as fs from 'fs/promises';
import { logger } from './logger';
import { getRequestContext } from './requestContext';

// Global (repo) root — safety floor that no request may escape, regardless of
// per-request project scoping.
export const PROJECT_ROOT = path.resolve(__dirname, '../../../');

/**
 * Effective project root for the current request. When a chat request specifies
 * a `projectRoot` (via requestContextStore), tool operations are scoped to it.
 * Falls back to the global PROJECT_ROOT when no per-request scope is active.
 *
 * Always returns a path that is inside (or equal to) PROJECT_ROOT — the
 * controller is responsible for validating the per-request value before
 * populating the store.
 */
export const getEffectiveProjectRoot = (): string => {
  const ctx = getRequestContext();
  return ctx?.projectRoot ?? PROJECT_ROOT;
};

/**
 * Validate a path is inside the effective project root (per-request scope if
 * set, otherwise the global repo root). Both boundaries are enforced — a
 * per-request path may not escape into a sibling project even if the global
 * repo would have allowed it.
 */
export const validatePath = (targetPath: string) => {
  const effectiveRoot = getEffectiveProjectRoot();
  const normalized = path.resolve(effectiveRoot, targetPath);
  // Trailing separator prevents prefix attacks (e.g. /root vs /root-evil).
  const withSep = (p: string) => (p.endsWith(path.sep) ? p : p + path.sep);
  const effectiveRootSep = withSep(effectiveRoot);
  if (!normalized.startsWith(effectiveRootSep) && normalized !== effectiveRoot) {
    throw new Error(`SECURITY ALERT: Path escape detected: ${targetPath}`);
  }
  // Safety floor: never allow a per-request root to escape the global repo.
  const globalRootSep = withSep(PROJECT_ROOT);
  if (!normalized.startsWith(globalRootSep) && normalized !== PROJECT_ROOT) {
    throw new Error(`SECURITY ALERT: Path escape detected: ${targetPath}`);
  }
  return normalized;
};

export class AtomicFileSystem {
  /**
   * Writes data to a file atomically by first writing to a temp file
   * and then renaming it. This prevents data corruption on crashes.
   */
  static async writeJson(filePath: string, data: unknown) {
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
      await fs.rename(tempPath, filePath);
    } catch (error) {
      logger.error(`[AtomicFS] Failed to write JSON to ${filePath}`, error);
      try { await fs.unlink(tempPath); } catch (e) { logger.debug('[AtomicFS] Temp file cleanup failed', { path: tempPath }); }
      throw error;
    }
  }

  static async writeFile(filePath: string, content: string) {
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    try {
      await fs.writeFile(tempPath, content);
      await fs.rename(tempPath, filePath);
    } catch (error) {
      logger.error(`[AtomicFS] Failed to write file to ${filePath}`, error);
      try { await fs.unlink(tempPath); } catch (e) { logger.debug('[AtomicFS] Temp file cleanup failed', { path: tempPath }); }
      throw error;
    }
  }
}
